//! Read-only view of the user's OpenSSH client config (`~/.ssh/config`).
//!
//! Iris uses it two ways: [`SshConfigFile::hosts`] lists the concrete `Host`
//! aliases for the connection form's picker, and [`SshConfigFile::resolve`]
//! turns a name into its effective HostName / User / Port / IdentityFile /
//! ProxyJump at connect time (first value wins, like OpenSSH).
//!
//! Parsing is `ssh2-config`'s. On top of it:
//! - `Match` blocks are dropped before parsing (the parser does not know
//!   them and would otherwise fold their lines into the preceding `Host`);
//!   directives Iris does not use are ignored. Both are logged at DEBUG,
//!   by name only.
//! - `%h %u %r %p %d %%` tokens are expanded in `HostName` and
//!   `IdentityFile`; `~` is expanded by the parser.
//!
//! The path is always injected (tests use temp files); a missing file is an
//! empty config.

use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::Serialize;
use ssh2_config::{ParseRule, SshConfig};

use crate::error::{CoreError, CoreResult};

/// `~/.ssh/config`, or `None` when there is no home folder.
pub fn default_ssh_config_path() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("config"))
}

/// One name as `~/.ssh/config` resolves it.
///
/// On the wire (`list_ssh_config_hosts`):
/// `{ alias, hostName, user, port, identityFiles, proxyJump }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    /// The name as written after `Host`.
    pub alias: String,
    /// `HostName`, tokens expanded; `None` when the config does not set it
    /// (the alias itself is then the host name).
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// `IdentityFile`s in order, `~` and tokens expanded.
    pub identity_files: Vec<String>,
    /// The raw `ProxyJump` list (`a,b`); `None` when unset or `none`.
    pub proxy_jump: Option<String>,
}

impl SshConfigHost {
    /// The host to connect to: `HostName`, else the alias.
    pub fn effective_host(&self) -> &str {
        self.host_name.as_deref().unwrap_or(&self.alias)
    }

    /// The `ProxyJump` entries in connect order.
    pub fn proxy_jumps(&self) -> Vec<String> {
        self.proxy_jump
            .as_deref()
            .map(split_jump_list)
            .unwrap_or_default()
    }
}

/// A parsed config file.
#[derive(Debug, Default)]
pub struct SshConfigFile {
    config: SshConfig,
}

impl SshConfigFile {
    /// Read and parse the file at `path`; a missing file is an empty config.
    pub fn load(path: &Path) -> CoreResult<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => {
                tracing::debug!("could not read the SSH config: {e}");
                Err(CoreError::Config(
                    "the SSH config file could not be read".into(),
                ))
            }
        }
    }

    /// Parse config text.
    pub fn parse(text: &str) -> CoreResult<Self> {
        let text = strip_match_blocks(text);
        let config = SshConfig::default()
            .parse(
                &mut BufReader::new(text.as_bytes()),
                ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS,
            )
            .map_err(|e| {
                // The parser's message can quote config values; keep it out
                // of the error text.
                tracing::debug!("could not parse the SSH config: {e}");
                CoreError::Config("the SSH config file could not be parsed".into())
            })?;
        for host in config.get_hosts() {
            let skipped: Vec<&str> = host
                .params
                .ignored_fields
                .keys()
                .chain(host.params.unsupported_fields.keys())
                .map(String::as_str)
                .collect();
            if !skipped.is_empty() {
                tracing::debug!(?skipped, "ignoring unsupported SSH config directives");
            }
        }
        Ok(Self { config })
    }

    /// The concrete `Host` aliases, in file order, each resolved. Patterns
    /// (`*`, `?`, negations) are skipped: they are not something to connect
    /// to.
    pub fn hosts(&self) -> Vec<SshConfigHost> {
        let mut aliases: Vec<&str> = Vec::new();
        for host in self.config.get_hosts() {
            for clause in &host.pattern {
                let name = clause.pattern.as_str();
                let concrete = !clause.negated && !name.contains(['*', '?', '!']);
                if concrete && !aliases.contains(&name) {
                    aliases.push(name);
                }
            }
        }
        aliases.into_iter().map(|a| self.resolve(a)).collect()
    }

    /// What the config says for `name` (any name, alias or not).
    pub fn resolve(&self, name: &str) -> SshConfigHost {
        let params = self.config.query(name);
        let host_name = params
            .host_name
            .as_deref()
            .map(|h| expand_tokens(h, &Tokens::for_host_name(name)));
        let tokens = Tokens {
            host: host_name.clone().unwrap_or_else(|| name.to_string()),
            alias: name.to_string(),
            remote_user: params.user.clone().unwrap_or_else(local_user),
            port: params.port.unwrap_or(crate::connection::DEFAULT_PORT),
        };
        let identity_files = params
            .identity_file
            .unwrap_or_default()
            .iter()
            .map(|p| expand_tokens(&p.to_string_lossy(), &tokens))
            .collect();
        let proxy_jump = params
            .proxy_jump
            .map(|list| list.join(","))
            .filter(|list| !list.is_empty() && !list.eq_ignore_ascii_case("none"));
        SshConfigHost {
            alias: name.to_string(),
            host_name,
            user: params.user,
            port: params.port,
            identity_files,
            proxy_jump,
        }
    }
}

/// One `ProxyJump` / jump host entry: `[user@]host[:port]` or
/// `ssh://[user@]host[:port]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpSpec {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

impl JumpSpec {
    pub fn parse(spec: &str) -> CoreResult<Self> {
        let invalid = || CoreError::InvalidInput("the jump host is not valid".into());
        let rest = spec.trim();
        let rest = rest.strip_prefix("ssh://").unwrap_or(rest);
        let (user, rest) = match rest.rsplit_once('@') {
            Some((user, rest)) if !user.is_empty() => (Some(user.to_string()), rest),
            Some(_) => return Err(invalid()),
            None => (None, rest),
        };
        // `[v6]:port`, `host:port` or `host`.
        let (host, port) = if let Some(v6) = rest.strip_prefix('[') {
            let (host, after) = v6.split_once(']').ok_or_else(invalid)?;
            match after.strip_prefix(':') {
                Some(port) => (host, Some(port)),
                None if after.is_empty() => (host, None),
                None => return Err(invalid()),
            }
        } else {
            match rest.split_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (rest, None),
            }
        };
        if host.is_empty() || host.chars().any(char::is_whitespace) {
            return Err(invalid());
        }
        let port = match port {
            Some(p) => Some(
                p.parse::<u16>()
                    .ok()
                    .filter(|p| *p != 0)
                    .ok_or_else(invalid)?,
            ),
            None => None,
        };
        Ok(Self {
            user,
            host: host.to_string(),
            port,
        })
    }
}

/// `a, b,c` → `["a", "b", "c"]`.
pub fn split_jump_list(list: &str) -> Vec<String> {
    list.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// The local login name (`%u`, and the user for a jump host nobody named a
/// user for), or empty when unknown.
pub fn local_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
}

struct Tokens {
    /// `%h`: the host name being connected to.
    host: String,
    /// `%n`: the name as given.
    alias: String,
    /// `%r`.
    remote_user: String,
    /// `%p`.
    port: u16,
}

impl Tokens {
    /// In `HostName` itself, `%h` is the name as given.
    fn for_host_name(name: &str) -> Self {
        Self {
            host: name.to_string(),
            alias: name.to_string(),
            remote_user: String::new(),
            port: crate::connection::DEFAULT_PORT,
        }
    }
}

/// Expand the simple OpenSSH tokens; unknown ones are left as written.
fn expand_tokens(value: &str, t: &Tokens) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('%') => out.push('%'),
            Some('h') => out.push_str(&t.host),
            Some('n') => out.push_str(&t.alias),
            Some('r') => out.push_str(&t.remote_user),
            Some('p') => out.push_str(&t.port.to_string()),
            Some('u') => out.push_str(&local_user()),
            Some('d') => out.push_str(
                &std::env::home_dir()
                    .map(|h| h.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// Drop every `Match` block (from a `Match` line up to the next `Host` or
/// `Match` line).
fn strip_match_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_match = false;
    for line in text.lines() {
        let keyword = line
            .trim_start()
            .split(|c: char| c.is_whitespace() || c == '=')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if keyword == "match" {
            tracing::debug!("ignoring a Match block in the SSH config");
            in_match = true;
            continue;
        }
        if keyword == "host" {
            in_match = false;
        }
        if !in_match {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# Example config; every host is fictitious.
Host bastion
    HostName bastion.example.test
    User jumper
    Port 2200
    IdentityFile ~/.ssh/id_bastion

Host app app-alias
    HostName app.internal.example.test
    User deploy
    IdentityFile /keys/%h-%r-%p
    IdentityFile /keys/second
    ProxyJump bastion

Host *.example.test !forbidden.example.test
    User wildcard

Match host app
    User matched

Host plain
    ForwardX11 yes
    SomethingUnknown on

Host *
    Port 22
";

    fn sample() -> SshConfigFile {
        SshConfigFile::parse(SAMPLE).unwrap()
    }

    #[test]
    fn lists_concrete_aliases_only() {
        let aliases: Vec<String> = sample().hosts().into_iter().map(|h| h.alias).collect();
        assert_eq!(aliases, ["bastion", "app", "app-alias", "plain"]);
    }

    #[test]
    fn resolves_the_directives_iris_uses() {
        let hosts = sample().hosts();
        let bastion = &hosts[0];
        assert_eq!(bastion.host_name.as_deref(), Some("bastion.example.test"));
        assert_eq!(bastion.user.as_deref(), Some("jumper"));
        assert_eq!(bastion.port, Some(2200));
        assert_eq!(bastion.proxy_jump, None);
        // Compared as paths: on Windows `~` expands to `C:\Users\x/.ssh/…`,
        // mixed separators that name the same file.
        let home = std::env::home_dir().unwrap();
        let identity_files: Vec<PathBuf> =
            bastion.identity_files.iter().map(PathBuf::from).collect();
        assert_eq!(identity_files, [home.join(".ssh").join("id_bastion")]);

        let app = &hosts[1];
        // The Match block is ignored: its User does not leak into `app`.
        assert_eq!(app.user.as_deref(), Some("deploy"));
        assert_eq!(app.port, Some(22), "from Host *");
        assert_eq!(app.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(
            app.identity_files,
            ["/keys/app.internal.example.test-deploy-22", "/keys/second"]
        );
        assert_eq!(app.effective_host(), "app.internal.example.test");
    }

    #[test]
    fn unset_values_stay_unset() {
        let plain = sample().resolve("plain");
        assert_eq!(plain.host_name, None);
        assert_eq!(plain.effective_host(), "plain");
        assert_eq!(plain.user, None);
        assert!(plain.identity_files.is_empty());
    }

    #[test]
    fn wildcards_apply_when_resolving_any_name() {
        let other = sample().resolve("db.example.test");
        assert_eq!(other.user.as_deref(), Some("wildcard"));
        let negated = sample().resolve("forbidden.example.test");
        assert_eq!(negated.user, None);
    }

    #[test]
    fn proxy_jump_none_means_no_jump() {
        let config = SshConfigFile::parse("Host x\n  ProxyJump none\n").unwrap();
        assert_eq!(config.resolve("x").proxy_jump, None);
        let config = SshConfigFile::parse("Host x\n  ProxyJump a,b:2222\n").unwrap();
        assert_eq!(config.resolve("x").proxy_jumps(), ["a", "b:2222"]);
    }

    #[test]
    fn host_name_tokens_use_the_alias() {
        let config = SshConfigFile::parse("Host web\n  HostName %h.example.test\n").unwrap();
        assert_eq!(
            config.resolve("web").host_name.as_deref(),
            Some("web.example.test")
        );
    }

    #[test]
    fn a_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let config = SshConfigFile::load(&dir.path().join("config")).unwrap();
        assert!(config.hosts().is_empty());
    }

    #[test]
    fn loads_from_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, SAMPLE).unwrap();
        assert_eq!(SshConfigFile::load(&path).unwrap().hosts().len(), 4);
    }

    #[test]
    fn jump_specs_parse() {
        let spec = |s: &str| JumpSpec::parse(s).unwrap();
        assert_eq!(
            spec("bastion"),
            JumpSpec {
                user: None,
                host: "bastion".into(),
                port: None
            }
        );
        assert_eq!(
            spec("ops@bastion.example.test:2222"),
            JumpSpec {
                user: Some("ops".into()),
                host: "bastion.example.test".into(),
                port: Some(2222)
            }
        );
        assert_eq!(
            spec("ssh://ops@[2001:db8::1]:22"),
            JumpSpec {
                user: Some("ops".into()),
                host: "2001:db8::1".into(),
                port: Some(22)
            }
        );
        for bad in ["", "@host", "host:0", "host:port", "two words", "[::1"] {
            assert!(JumpSpec::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn tokens_expand_and_unknown_ones_stay() {
        let t = Tokens {
            host: "h.example.test".into(),
            alias: "h".into(),
            remote_user: "demo".into(),
            port: 2222,
        };
        assert_eq!(
            expand_tokens("%h|%n|%r|%p|%%|%x|%", &t),
            "h.example.test|h|demo|2222|%|%x|%"
        );
    }
}
