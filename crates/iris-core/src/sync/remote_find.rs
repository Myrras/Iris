//! The server-side search of a sync limited to recently changed files
//! ("Only files changed in"): one `find` run over SSH instead of listing
//! every folder over SFTP. Pure parts only — the script, its output, the
//! clock skew — so each rule is unit-tested; `window.rs` runs it.
//!
//! ## The command
//! The script goes to `sh` on standard input (so the user's login shell,
//! whatever it is, only has to start `sh`, and no quoting has to survive
//! two shells):
//!
//! ```text
//! LC_ALL=C
//! export LC_ALL
//! printf 'IRIS-FIND\0'
//! find -H '<root>' -mindepth 1 \( -name '<exclude>' -o -name '.*' \) -prune \
//!   -o -type d \( ! -readable -o ! -executable \) -printf 'U\0%P\0-\0-\0' -prune \
//!   -o -type f -newermt @<since − 1> -printf 'F\0%P\0%s\0%T@\0' \
//!   -o -type l -printf 'L\0%P\0%Y\0%T@\0' \
//!   -o ! -type d -newermt @<since − 1> -printf 'S\0%P\0-\0%T@\0'
//! printf 'IRIS-END\0%s\0' "$?"
//! ```
//!
//! - `-H` follows the root when it is a link (as SFTP's OPENDIR does), and
//!   nothing below it. A relative root gets a `./` prefix, so a name
//!   starting with `-`, `(` or `!` is never read as an option or operator.
//! - Excludes (the ones without `?`, whose byte-wise C-locale meaning
//!   could differ from Iris' per-character one; `[`, `]` and `\` escaped)
//!   and, with "skip hidden", dotfiles are pruned: neither searched nor
//!   reported. Iris checks every name again, so a pattern left out here
//!   still applies.
//! - Unreadable folders are reported (`U`) and not entered, like the walk.
//! - Files newer than one second before the cutoff are printed and Iris
//!   keeps whole seconds ≥ the cutoff, the walk's rule exactly (`-newermt`
//!   is a strict, sub-second comparison).
//! - Every link is reported with what it resolves to (`%Y`) and its own
//!   date: Iris looks a link to a file up over SFTP (its target's size and
//!   date decide, as in the walk); links to folders, broken links and
//!   sockets/devices/fifos (`S`) are reported unsupported when their own
//!   date is within the window.
//! - Records are four NUL-terminated fields (no name can hold a NUL; any
//!   other byte, a newline too, is fine), between a header and an end
//!   marker with `find`'s exit status. A missing marker (cut off), another
//!   status than 0, or anything unexpected means the search failed: the
//!   caller falls back to walking the folders.
//!
//! GNU findutils is needed (`-printf`, `-newermt`, `-readable`); BusyBox
//! and BSD `find` fail the command at once, which is the fallback again.

use crate::fs::is_dotfile;
use crate::ssh::exec::sh_quote;
use crate::transfer::naming::is_safe_name;

use super::exclude::first_match;

/// Standard output of one search, at most (beyond it: walk instead).
pub(crate) const FIND_OUTPUT_LIMIT: usize = 50 * 1024 * 1024;
/// How long one search may take, at most (beyond it: walk instead).
pub(crate) const FIND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// How long reading the server's clock may take.
pub(crate) const CLOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// The command that prints the server's clock (unix seconds).
pub(crate) const CLOCK_COMMAND: &str = "date +%s";
/// The command the script is fed to.
pub(crate) const FIND_COMMAND: &str = "sh";
/// Clocks this far apart (seconds) or less count as the same.
pub const CLOCK_SKEW_TOLERANCE_SECS: i64 = 60;

const HEADER: &[u8] = b"IRIS-FIND\0";
const END: &[u8] = b"IRIS-END";

/// What one search looks for.
#[derive(Debug, Clone)]
pub(crate) struct FindQuery<'a> {
    /// The source folder, as the server names it.
    pub root: &'a str,
    /// Files modified at or after this (unix seconds, the server's clock).
    pub since: i64,
    pub excludes: &'a [String],
    pub skip_hidden: bool,
}

/// The script for `sh` (see the module docs); `None` when the root cannot
/// be put in a shell word (a NUL in it).
pub(crate) fn find_script(query: &FindQuery<'_>) -> Option<String> {
    let root = if query.root.starts_with('/') {
        query.root.to_string()
    } else {
        format!("./{}", query.root)
    };
    let root = sh_quote(&root)?;
    let mut prunes: Vec<String> = query
        .excludes
        .iter()
        .filter_map(|p| find_name_pattern(p))
        .filter_map(|p| sh_quote(&p))
        .map(|p| format!("-name {p}"))
        .collect();
    if query.skip_hidden {
        prunes.push("-name '.*'".into());
    }
    let prune = if prunes.is_empty() {
        String::new()
    } else {
        format!("\\( {} \\) -prune -o ", prunes.join(" -o "))
    };
    let newer = query.since.saturating_sub(1);
    Some(format!(
        "LC_ALL=C\n\
         export LC_ALL\n\
         printf 'IRIS-FIND\\0'\n\
         find -H {root} -mindepth 1 {prune}\
         -type d \\( ! -readable -o ! -executable \\) -printf 'U\\0%P\\0-\\0-\\0' -prune \
         -o -type f -newermt @{newer} -printf 'F\\0%P\\0%s\\0%T@\\0' \
         -o -type l -printf 'L\\0%P\\0%Y\\0%T@\\0' \
         -o ! -type d -newermt @{newer} -printf 'S\\0%P\\0-\\0%T@\\0'\n\
         printf 'IRIS-END\\0%s\\0' \"$?\"\n"
    ))
}

/// An exclude pattern as a `find -name` pattern: `*` stays a wildcard,
/// `[`, `]` and `\` are escaped to stand for themselves. `None` for a
/// pattern with `?`: in the C locale it matches one *byte*, Iris' matcher
/// one character, so it is only applied by Iris (after the search).
fn find_name_pattern(pattern: &str) -> Option<String> {
    if pattern.contains('?') {
        return None;
    }
    let mut out = String::with_capacity(pattern.len());
    for c in pattern.chars() {
        if matches!(c, '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    Some(out)
}

/// One record of the search, its path split into names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Found {
    /// A regular file modified within the window (by `find`'s test).
    File {
        segments: Vec<String>,
        size: u64,
        mtime: i64,
    },
    /// A link, any date: `target` is `find`'s `%Y` (`f`, `d`, `N` for a
    /// broken one, `L` for a loop, …); `mtime` is the link's own.
    Link {
        segments: Vec<String>,
        target: char,
        mtime: i64,
    },
    /// A folder that cannot be listed (not entered).
    Unreadable { segments: Vec<String> },
    /// A socket, device or fifo modified within the window.
    Special { segments: Vec<String>, mtime: i64 },
    /// A path with a name Iris does not accept: cut at that name, which
    /// is the last segment (shown lossily when it is not UTF-8).
    Unsafe { segments: Vec<String> },
}

impl Found {
    pub fn segments(&self) -> &[String] {
        match self {
            Self::File { segments, .. }
            | Self::Link { segments, .. }
            | Self::Unreadable { segments }
            | Self::Special { segments, .. }
            | Self::Unsafe { segments } => segments,
        }
    }
}

/// Why a search's output was not used (only logged).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ParseError {
    /// Not our script's output (another shell, an `internal-sftp` reply).
    NoHeader,
    /// Cut off before the end marker.
    Truncated,
    /// `find` ended with another status than 0 (an unknown option, a
    /// folder that vanished, …).
    FindFailed,
    /// A record that does not read.
    BadRecord,
}

/// The records of a search's standard output (see the module docs).
pub(crate) fn parse_find(out: &[u8]) -> Result<Vec<Found>, ParseError> {
    let rest = out.strip_prefix(HEADER).ok_or(ParseError::NoHeader)?;
    // Every field ends with a NUL: the piece after the last one must be
    // empty, else the output was cut mid-field.
    let mut fields = rest.split(|b| *b == 0);
    let mut found = Vec::new();
    loop {
        let Some(tag) = fields.next() else {
            return Err(ParseError::Truncated);
        };
        if tag == END {
            let status = fields.next().ok_or(ParseError::Truncated)?;
            let trailing = fields.next().ok_or(ParseError::Truncated)?;
            if !trailing.is_empty() || fields.next().is_some() {
                return Err(ParseError::BadRecord);
            }
            return if status == b"0" {
                Ok(found)
            } else {
                Err(ParseError::FindFailed)
            };
        }
        let (Some(path), Some(a), Some(b)) = (fields.next(), fields.next(), fields.next()) else {
            return Err(ParseError::Truncated);
        };
        let segments = match split_path(path)? {
            Ok(segments) => segments,
            Err(cut) => {
                found.push(Found::Unsafe { segments: cut });
                continue;
            }
        };
        found.push(match tag {
            b"F" => Found::File {
                segments,
                size: parse_number(a).ok_or(ParseError::BadRecord)?,
                mtime: parse_mtime(b).ok_or(ParseError::BadRecord)?,
            },
            b"L" => {
                let [target] = a else {
                    return Err(ParseError::BadRecord);
                };
                Found::Link {
                    segments,
                    target: char::from(*target),
                    mtime: parse_mtime(b).ok_or(ParseError::BadRecord)?,
                }
            }
            b"U" => Found::Unreadable { segments },
            b"S" => Found::Special {
                segments,
                mtime: parse_mtime(b).ok_or(ParseError::BadRecord)?,
            },
            _ => return Err(ParseError::BadRecord),
        });
    }
}

/// `%P` split into names: `Ok` when every name is safe, else `Err` with
/// the path cut at the first unsafe name. An empty path or an empty name
/// (`a//b`) does not read.
#[allow(clippy::type_complexity)]
fn split_path(path: &[u8]) -> Result<Result<Vec<String>, Vec<String>>, ParseError> {
    if path.is_empty() {
        return Err(ParseError::BadRecord);
    }
    let mut segments = Vec::new();
    for raw in path.split(|b| *b == b'/') {
        if raw.is_empty() {
            return Err(ParseError::BadRecord);
        }
        match std::str::from_utf8(raw) {
            Ok(name) if is_safe_name(name) => segments.push(name.to_string()),
            _ => {
                segments.push(String::from_utf8_lossy(raw).into_owned());
                return Ok(Err(segments));
            }
        }
    }
    Ok(Ok(segments))
}

fn parse_number(field: &[u8]) -> Option<u64> {
    std::str::from_utf8(field).ok()?.parse().ok()
}

/// `%T@` (`1700000000.1234567890`) as whole seconds, cut toward zero as
/// SFTP reports them.
fn parse_mtime(field: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(field).ok()?;
    let whole = text.split('.').next()?;
    if whole.is_empty() || whole == "-" {
        return None;
    }
    whole.parse().ok()
}

/// Whether a name of a found path is left out by the excludes or "skip
/// hidden" (Iris' own matcher: `find` pruned most of them already).
pub(crate) fn left_out(found: &Found, excludes: &[String], skip_hidden: bool) -> bool {
    found
        .segments()
        .iter()
        .any(|name| first_match(excludes, name).is_some() || (skip_hidden && is_dotfile(name)))
}

/// The server's clock from `date +%s`.
pub(crate) fn parse_clock(out: &[u8]) -> Option<i64> {
    std::str::from_utf8(out).ok()?.trim().parse().ok()
}

/// How far the server's clock is ahead of ours (negative: behind), when
/// it is beyond the tolerance; `None` when they agree well enough.
pub(crate) fn clock_skew(server_now: i64, local_now: i64) -> Option<i64> {
    let skew = server_now - local_now;
    (skew.abs() > CLOCK_SKEW_TOLERANCE_SECS).then_some(skew)
}

/// The cutoff on the server's clock: ours moved by the skew, so "the last
/// hour" means the server's last hour.
pub(crate) fn server_cutoff(since: i64, skew: Option<i64>) -> i64 {
    since.saturating_add(skew.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segs(path: &str) -> Vec<String> {
        path.split('/').map(String::from).collect()
    }

    fn query<'a>(root: &'a str, excludes: &'a [String], skip_hidden: bool) -> FindQuery<'a> {
        FindQuery {
            root,
            since: 1_700_000_000,
            excludes,
            skip_hidden,
        }
    }

    /// Output as the script prints it: the header, each record's fields
    /// NUL-terminated, the end marker.
    fn output(records: &[&[&[u8]]], status: &str) -> Vec<u8> {
        let mut out = HEADER.to_vec();
        for record in records {
            for field in *record {
                out.extend_from_slice(field);
                out.push(0);
            }
        }
        out.extend_from_slice(END);
        out.push(0);
        out.extend_from_slice(status.as_bytes());
        out.push(0);
        out
    }

    #[test]
    fn the_script_searches_the_quoted_root_from_one_second_before() {
        let script = find_script(&query("/srv/my site", &[], false)).unwrap();
        assert!(script.contains("find -H '/srv/my site' -mindepth 1 -type d"));
        assert!(script.contains("-type f -newermt @1699999999 -printf 'F\\0%P\\0%s\\0%T@\\0'"));
        assert!(script.contains("! -type d -newermt @1699999999"));
        assert!(script.starts_with("LC_ALL=C\nexport LC_ALL\nprintf 'IRIS-FIND\\0'\n"));
        assert!(script.ends_with("printf 'IRIS-END\\0%s\\0' \"$?\"\n"));
        assert!(
            !script.contains("-prune -o -type d \\( ! -readable"),
            "no prunes"
        );
    }

    #[test]
    fn a_relative_or_dash_root_is_put_behind_dot_slash() {
        let script = find_script(&query("-rf", &[], false)).unwrap();
        assert!(script.contains("find -H './-rf' "), "{script}");
        let script = find_script(&query("(x", &[], false)).unwrap();
        assert!(script.contains("find -H './(x' "), "{script}");
    }

    #[test]
    fn nasty_roots_stay_one_quoted_word() {
        let script = find_script(&query("/srv/it's $(reboot)\n`id`", &[], false)).unwrap();
        assert!(
            script.contains(r"find -H '/srv/it'\''s $(reboot)"),
            "{script}"
        );
        assert!(script.contains("\n`id`' -mindepth 1"), "{script}");
        assert_eq!(find_script(&query("/srv/a\0b", &[], false)), None);
    }

    #[test]
    fn excludes_and_hidden_names_are_pruned() {
        let excludes = vec![
            "node_modules".to_string(),
            "*.log".to_string(),
            "it's[1]".to_string(),
            "file?.txt".to_string(),
        ];
        let script = find_script(&query("/srv", &excludes, true)).unwrap();
        assert!(
            script.contains(
                r"\( -name 'node_modules' -o -name '*.log' -o -name 'it'\''s\[1\]' -o -name '.*' \) -prune -o "
            ),
            "{script}"
        );
        assert!(!script.contains("file?"), "left to Iris: {script}");
    }

    #[test]
    fn records_are_parsed_with_odd_names() {
        let out = output(
            &[
                &[b"F", b"a.txt", b"12", b"1700000005.2475170020"],
                &[b"F", b"dir/with\nnewline\tand tab", b"0", b"1700000000"],
                &[b"F", b"quote's \"x\" $(id)", b"3", b"1700000001.5"],
                &[b"L", b"link", b"f", b"1600000000.0"],
                &[b"L", b"gone", b"N", b"1700000009.0"],
                &[b"U", b"locked", b"-", b"-"],
                &[b"S", b"sock", b"-", b"1700000003.9"],
            ],
            "0",
        );
        let found = parse_find(&out).unwrap();
        assert_eq!(
            found,
            vec![
                Found::File {
                    segments: segs("a.txt"),
                    size: 12,
                    mtime: 1_700_000_005
                },
                Found::File {
                    segments: vec!["dir".into(), "with\nnewline\tand tab".into()],
                    size: 0,
                    mtime: 1_700_000_000
                },
                Found::File {
                    segments: vec!["quote's \"x\" $(id)".into()],
                    size: 3,
                    mtime: 1_700_000_001
                },
                Found::Link {
                    segments: segs("link"),
                    target: 'f',
                    mtime: 1_600_000_000
                },
                Found::Link {
                    segments: segs("gone"),
                    target: 'N',
                    mtime: 1_700_000_009
                },
                Found::Unreadable {
                    segments: segs("locked")
                },
                Found::Special {
                    segments: segs("sock"),
                    mtime: 1_700_000_003
                },
            ]
        );
    }

    #[test]
    fn unsafe_names_cut_the_path() {
        let out = output(
            &[
                &[b"F", b"ok/bad\xffname/inner.txt", b"1", b"1700000000"],
                &[b"F", b"ok/..", b"1", b"1700000000"],
            ],
            "0",
        );
        let found = parse_find(&out).unwrap();
        assert_eq!(
            found,
            vec![
                Found::Unsafe {
                    segments: vec!["ok".into(), "bad\u{fffd}name".into()]
                },
                Found::Unsafe {
                    segments: vec!["ok".into(), "..".into()]
                },
            ]
        );
    }

    #[test]
    fn anything_but_a_complete_successful_run_fails() {
        let good = output(&[&[b"F", b"a", b"1", b"1700000000"]], "0");
        assert!(parse_find(&good).is_ok());
        // Cut off anywhere before the end.
        for cut in [
            good.len() - 1,
            good.len() - 4,
            HEADER.len() + 3,
            HEADER.len(),
        ] {
            assert!(parse_find(&good[..cut]).is_err(), "cut at {cut}");
        }
        assert_eq!(parse_find(b""), Err(ParseError::NoHeader));
        assert_eq!(parse_find(b"\0\0\0\0garbage"), Err(ParseError::NoHeader));
        // BusyBox: "find: unrecognized: -printf", nothing on stdout.
        let busybox = output(&[], "1");
        assert_eq!(parse_find(&busybox), Err(ParseError::FindFailed));
        let mut trailing = good.clone();
        trailing.extend_from_slice(b"more");
        assert_eq!(parse_find(&trailing), Err(ParseError::BadRecord));
        for bad in [
            output(&[&[b"X", b"a", b"1", b"1"]], "0"),
            output(&[&[b"F", b"a", b"big", b"1"]], "0"),
            output(&[&[b"F", b"a", b"1", b"soon"]], "0"),
            output(&[&[b"F", b"", b"1", b"1"]], "0"),
            output(&[&[b"F", b"a//b", b"1", b"1"]], "0"),
            output(&[&[b"L", b"a", b"fd", b"1"]], "0"),
        ] {
            assert_eq!(parse_find(&bad), Err(ParseError::BadRecord), "{bad:?}");
        }
    }

    #[test]
    fn mtimes_are_whole_seconds() {
        assert_eq!(parse_mtime(b"1700000000.9999999999"), Some(1_700_000_000));
        assert_eq!(parse_mtime(b"1700000000"), Some(1_700_000_000));
        assert_eq!(parse_mtime(b"-5.5"), Some(-5));
        assert_eq!(parse_mtime(b".5"), None);
        assert_eq!(parse_mtime(b"-"), None);
    }

    #[test]
    fn names_left_out_by_excludes_or_hidden_anywhere_in_the_path() {
        let excludes = vec!["file?.txt".to_string()];
        let file = |path: &str| Found::File {
            segments: segs(path),
            size: 1,
            mtime: 1,
        };
        assert!(left_out(&file("docs/file1.txt"), &excludes, false));
        assert!(!left_out(&file("docs/file12.txt"), &excludes, false));
        assert!(!left_out(&file(".config/a"), &excludes, false));
        assert!(left_out(&file(".config/a"), &excludes, true));
    }

    #[test]
    fn clock_skew_beyond_a_minute_moves_the_cutoff() {
        assert_eq!(parse_clock(b"1700000000\n"), Some(1_700_000_000));
        assert_eq!(parse_clock(b"%s\n"), None);
        assert_eq!(clock_skew(1_000_060, 1_000_000), None);
        assert_eq!(clock_skew(999_940, 1_000_000), None);
        assert_eq!(clock_skew(1_000_061, 1_000_000), Some(61));
        assert_eq!(clock_skew(1_000_000 - 600, 1_000_000), Some(-600));
        assert_eq!(server_cutoff(5_000, Some(600)), 5_600);
        assert_eq!(server_cutoff(5_000, Some(-600)), 4_400);
        assert_eq!(server_cutoff(5_000, None), 5_000);
    }

    /// The script against the real `find` of this machine, when it is GNU
    /// findutils (Linux CI; on macOS only with `gfind` as `find`).
    #[cfg(unix)]
    #[test]
    fn the_script_runs_under_a_real_gnu_find() {
        let version = std::process::Command::new("find").arg("--version").output();
        let gnu = version
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("GNU findutils"))
            .unwrap_or(false);
        if !gnu {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let set = |path: &std::path::Path, secs: u64| {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
                .unwrap();
        };
        std::fs::create_dir_all(root.join("a/node_modules")).unwrap();
        std::fs::write(root.join("a/new.txt"), "new").unwrap();
        set(&root.join("a/new.txt"), 1_700_000_000);
        std::fs::write(root.join("a/old.txt"), "old").unwrap();
        set(&root.join("a/old.txt"), 1_699_999_999);
        std::fs::write(root.join("a/node_modules/x.js"), "x").unwrap();
        set(&root.join("a/node_modules/x.js"), 1_700_000_100);
        let excludes = vec!["node_modules".to_string()];
        let root_text = root.to_string_lossy().into_owned();
        let script = find_script(&query(&root_text, &excludes, false)).unwrap();
        let mut child = std::process::Command::new("sh")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        let found = parse_find(&out.stdout).unwrap();
        assert_eq!(
            found,
            vec![Found::File {
                segments: segs("a/new.txt"),
                size: 3,
                mtime: 1_700_000_000
            }]
        );
    }
}
