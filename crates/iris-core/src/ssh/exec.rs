//! Running one command on the server over an SSH `exec` channel, for the
//! few things a shell does far faster than SFTP (a `find` over a whole
//! tree). Callers get the command's standard output and exit status, never
//! its standard error: server text stays out of Iris' messages.
//!
//! Many accounts cannot run commands at all (SFTP-only users, an
//! `internal-sftp` chroot, a restricted shell), so every caller must have
//! a fallback; a refusal is an ordinary [`CoreError::Remote`].

use std::time::Duration;

use russh::ChannelMsg;

use crate::error::{CoreError, CoreResult};

use super::session::SshSession;

/// Bounds of one command run.
#[derive(Debug, Clone, Copy)]
pub struct ExecLimits {
    /// Standard output beyond this many bytes stops the command
    /// ([`CoreError::TooLarge`]).
    pub max_output: usize,
    /// The whole run (open, start, input, output) must end within this.
    pub timeout: Duration,
}

/// What a finished command left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    /// `None` when the server sent none (killed by a signal, say).
    pub exit_status: Option<u32>,
}

impl SshSession {
    /// Run `command` (the user's login shell gets it as `$SHELL -c`), feed
    /// it `stdin` followed by end-of-file, and collect its output.
    /// `on_output` sees each chunk of standard output as it arrives (for
    /// progress). Standard error is discarded.
    ///
    /// `Remote` when the server refuses to run commands, `TooLarge` past
    /// `limits.max_output`, `Remote` after `limits.timeout` (or
    /// `NotConnected` when the connection turned out to be gone).
    pub async fn exec(
        &self,
        command: &str,
        stdin: &[u8],
        limits: ExecLimits,
        on_output: &mut (dyn FnMut(&[u8]) + Send),
    ) -> CoreResult<ExecOutput> {
        if self.is_closed() {
            return Err(CoreError::NotConnected);
        }
        let deadline = tokio::time::Instant::now() + limits.timeout;
        let opened = tokio::time::timeout_at(deadline, self.open_session_channel()).await;
        let mut channel = match opened {
            Ok(Ok(channel)) => channel,
            Ok(Err(e)) => return Err(self.exec_failed(&e)),
            Err(_) => return Err(self.timed_out().await),
        };
        let run = run_command(&mut channel, command, stdin, limits.max_output, on_output);
        let result = match tokio::time::timeout_at(deadline, run).await {
            Ok(Err(_)) if self.is_closed() => Err(CoreError::NotConnected),
            Ok(result) => result,
            Err(_) => Err(self.timed_out().await),
        };
        // Also when it took too long or printed too much: the server ends
        // the command with the channel (SIGHUP / a closed pipe).
        let _ = channel.close().await;
        result
    }

    fn exec_failed(&self, e: &dyn std::fmt::Display) -> CoreError {
        tracing::debug!("exec channel failed: {e}");
        if self.is_closed() {
            CoreError::NotConnected
        } else {
            CoreError::Remote("the server could not run a command".into())
        }
    }

    /// A command that ran out of time: a slow server, or a dead connection.
    async fn timed_out(&self) -> CoreError {
        if self.probe().await {
            CoreError::Remote("the server command took too long".into())
        } else {
            CoreError::NotConnected
        }
    }
}

/// Start `command` on the opened `channel`, send `stdin`, collect stdout.
async fn run_command(
    channel: &mut russh::Channel<russh::client::Msg>,
    command: &str,
    stdin: &[u8],
    max_output: usize,
    on_output: &mut (dyn FnMut(&[u8]) + Send),
) -> CoreResult<ExecOutput> {
    let failed = |e: &dyn std::fmt::Display| {
        tracing::debug!("exec channel failed: {e}");
        CoreError::Remote("the server could not run a command".into())
    };
    channel.exec(true, command).await.map_err(|e| failed(&e))?;
    // The answer to the exec request comes first.
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => break,
            Some(ChannelMsg::Failure) | None => {
                return Err(CoreError::Remote(
                    "the server does not allow running commands".into(),
                ))
            }
            Some(ChannelMsg::WindowAdjusted { .. }) => {}
            Some(other) => {
                tracing::debug!(?other, "unexpected message before the exec reply");
            }
        }
    }
    if !stdin.is_empty() {
        channel
            .data_bytes(stdin.to_vec())
            .await
            .map_err(|e| failed(&e))?;
    }
    channel.eof().await.map_err(|e| failed(&e))?;

    let mut stdout = Vec::new();
    let mut exit_status = None;
    let mut stderr_bytes = 0usize;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                if stdout.len() + data.len() > max_output {
                    return Err(CoreError::TooLarge(
                        "the server command printed too much".into(),
                    ));
                }
                on_output(&data);
                stdout.extend_from_slice(&data);
            }
            // Never shown, never logged: only how much there was.
            ChannelMsg::ExtendedData { data, .. } => stderr_bytes += data.len(),
            ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    if stderr_bytes > 0 {
        tracing::debug!(stderr_bytes, ?exit_status, "a server command wrote errors");
    }
    Ok(ExecOutput {
        stdout,
        exit_status,
    })
}

/// `text` as one word for a POSIX shell: single-quoted, with each `'`
/// written as `'\''`. Inside single quotes nothing is special (`$`, `` ` ``,
/// `\`, newlines, `*`), so the shell passes the text through unchanged.
/// `None` for text with a NUL in it, which no shell word can hold.
///
/// Quoting does not stop a program from reading a word that starts with
/// `-` as an option: callers put such paths behind `./` or `--`.
pub(crate) fn sh_quote(text: &str) -> Option<String> {
    if text.contains('\0') {
        return None;
    }
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for c in text.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `sh` makes of `word`: the quoted word run through a real
    /// shell's `printf %s`, so the round trip is checked, not the text.
    #[cfg(unix)]
    fn through_sh(word: &str) -> String {
        let quoted = sh_quote(word).unwrap();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {quoted}"))
            .output()
            .unwrap();
        assert!(out.status.success(), "{quoted}");
        String::from_utf8(out.stdout).unwrap()
    }

    #[test]
    fn plain_words_are_single_quoted() {
        assert_eq!(sh_quote("site").unwrap(), "'site'");
        assert_eq!(sh_quote("").unwrap(), "''");
        assert_eq!(sh_quote("it's").unwrap(), r"'it'\''s'");
    }

    #[test]
    fn a_nul_cannot_be_quoted() {
        assert_eq!(sh_quote("a\0b"), None);
    }

    #[cfg(unix)]
    #[test]
    fn nasty_text_survives_a_real_shell() {
        for word in [
            "/srv/my site",
            "it's",
            "''",
            "'; rm -rf / #",
            "$(touch /tmp/iris-pwned)",
            "`id`",
            "$HOME ${PATH}",
            "line one\nline two",
            "tab\there",
            "-name",
            "--",
            "back\\slash",
            "*.log",
            "[a-z]?",
            "\"double\"",
            "ünïcødé ✓",
            "!history",
            "a;b|c&d>e<f",
        ] {
            assert_eq!(through_sh(word), word, "{word:?}");
        }
    }
}
