//! Host key verification against an OpenSSH `known_hosts` file.
//!
//! - Known and matching: the connect proceeds.
//! - Known but different: a hard [`CoreError::HostKeyChanged`]. There is no
//!   override path anywhere; the user fixes `known_hosts` by hand.
//! - Unknown: the user is asked through a [`CoreEvent::HostKeyPrompt`]; the
//!   connect waits until [`HostKeyPrompts::answer`] (via
//!   `Core::answer_host_key`). Trust appends the key to `known_hosts`
//!   (`[host]:port` form for a non-22 port); reject, timeout or a dropped
//!   prompt refuse the connection.
//!
//! The `known_hosts` path is always injected, never assumed, so tests can
//! (and must) use a temp file. [`default_known_hosts_path`] gives the real
//! `~/.ssh/known_hosts` for the shell to configure.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::{HashAlg, PublicKey};
use tokio::sync::oneshot;

use crate::error::{CoreError, CoreResult};
use crate::events::{CoreEvent, EventBus};
use crate::ids::{HostKeyRequestId, SessionId};

const LOCK_POISONED: &str = "host key prompt lock poisoned";

/// How long a host key prompt waits for an answer before rejecting.
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// `~/.ssh/known_hosts`, or `None` when there is no home folder.
pub fn default_known_hosts_path() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// OpenSSH-style SHA-256 fingerprint: `SHA256:<base64 without padding>`.
pub fn fingerprint_sha256(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// What `known_hosts` says about a host key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownHost {
    /// A matching entry exists.
    Trusted,
    /// No entry for this host and key algorithm.
    Unknown,
    /// An entry with the same algorithm but a different key exists.
    Changed,
}

/// Look `key` up for `host:port` in the `known_hosts` file at `path`. A
/// missing file means every host is unknown.
pub fn check(path: &Path, host: &str, port: u16, key: &PublicKey) -> CoreResult<KnownHost> {
    match check_known_hosts_path(host, port, key, path) {
        Ok(true) => Ok(KnownHost::Trusted),
        Ok(false) => Ok(KnownHost::Unknown),
        Err(russh::keys::Error::KeyChanged { .. }) => Ok(KnownHost::Changed),
        Err(e) => {
            tracing::debug!("known_hosts lookup failed: {e}");
            Err(CoreError::Config(
                "known_hosts has an entry for this host that could not be read".into(),
            ))
        }
    }
}

/// Append `key` for `host:port` to the `known_hosts` file at `path`
/// (creating it and its folder if needed).
pub fn learn(path: &Path, host: &str, port: u16, key: &PublicKey) -> CoreResult<()> {
    learn_known_hosts_path(host, port, key, path).map_err(|e| {
        tracing::debug!("could not append to known_hosts: {e}");
        CoreError::Config("could not record the host key in known_hosts".into())
    })
}

/// The pending "trust this host key?" questions, each answered once.
pub struct HostKeyPrompts {
    pending: Mutex<HashMap<HostKeyRequestId, oneshot::Sender<bool>>>,
    timeout: Duration,
}

/// The facts the user is shown in a host key prompt.
#[derive(Debug, Clone)]
pub struct HostKeyQuestion {
    pub session_id: SessionId,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint_sha256: String,
}

impl HostKeyPrompts {
    pub fn new(timeout: Duration) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            timeout,
        }
    }

    /// Publish a [`CoreEvent::HostKeyPrompt`] and wait for its answer.
    /// `false` on reject, timeout, or when nobody can answer any more.
    pub async fn ask(&self, events: &EventBus, question: HostKeyQuestion) -> bool {
        let request_id = HostKeyRequestId::new();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect(LOCK_POISONED)
            .insert(request_id, tx);
        events.publish(CoreEvent::HostKeyPrompt {
            request_id,
            session_id: question.session_id,
            host: question.host,
            port: question.port,
            key_type: question.key_type,
            fingerprint_sha256: question.fingerprint_sha256,
        });
        let answer = tokio::time::timeout(self.timeout, rx).await;
        // Whatever happened, the question is closed now.
        self.pending
            .lock()
            .expect(LOCK_POISONED)
            .remove(&request_id);
        matches!(answer, Ok(Ok(true)))
    }

    /// Answer a pending prompt. `InvalidInput` when it is unknown or already
    /// closed (answered, timed out).
    pub fn answer(&self, request_id: HostKeyRequestId, trust: bool) -> CoreResult<()> {
        let tx = self
            .pending
            .lock()
            .expect(LOCK_POISONED)
            .remove(&request_id)
            .ok_or_else(|| CoreError::InvalidInput("no such host key prompt is open".into()))?;
        tx.send(trust)
            .map_err(|_| CoreError::InvalidInput("the host key prompt was already closed".into()))
    }
}

impl Default for HostKeyPrompts {
    fn default() -> Self {
        Self::new(DEFAULT_PROMPT_TIMEOUT)
    }
}

/// The full policy for one presented server key; see the module docs.
///
/// `prompts` is `None` for a connect nobody watches (an automatic
/// reconnect): an unknown key is then refused as `HostKeyRejected` instead
/// of asking.
pub async fn verify(
    known_hosts: &Path,
    prompts: Option<&HostKeyPrompts>,
    events: &EventBus,
    session_id: SessionId,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> CoreResult<()> {
    match check(known_hosts, host, port, key)? {
        KnownHost::Trusted => Ok(()),
        KnownHost::Changed => Err(CoreError::HostKeyChanged {
            host: host.to_string(),
            port,
        }),
        KnownHost::Unknown => {
            let Some(prompts) = prompts else {
                return Err(CoreError::HostKeyRejected);
            };
            let question = HostKeyQuestion {
                session_id,
                host: host.to_string(),
                port,
                key_type: key.algorithm().as_str().to_string(),
                fingerprint_sha256: fingerprint_sha256(key),
            };
            if prompts.ask(events, question).await {
                learn(known_hosts, host, port, key)
            } else {
                Err(CoreError::HostKeyRejected)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public keys only (no private material); taken from russh's own
    // known_hosts tests.
    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    fn key(openssh: &str) -> PublicKey {
        PublicKey::from_openssh(openssh).unwrap()
    }

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        // `ssh-keygen -lf` prints the same value for KEY_A.
        assert_eq!(
            fingerprint_sha256(&key(KEY_A)),
            "SHA256:T7SvZ2cslqpPj6nKzitCBHHlpVF3r3MvLwmFL0fk0IE"
        );
    }

    #[test]
    fn unknown_then_learned_then_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh").join("known_hosts");
        let k = key(KEY_A);
        assert_eq!(
            check(&path, "sftp.example.test", 2222, &k).unwrap(),
            KnownHost::Unknown
        );
        learn(&path, "sftp.example.test", 2222, &k).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        // russh separates the entry with a newline even in a fresh file.
        let raw = raw.trim_start();
        assert!(
            raw.starts_with("[sftp.example.test]:2222 ssh-ed25519 "),
            "{raw}"
        );
        assert_eq!(
            check(&path, "sftp.example.test", 2222, &k).unwrap(),
            KnownHost::Trusted
        );
        // Same host on another port is a different entry.
        assert_eq!(
            check(&path, "sftp.example.test", 22, &k).unwrap(),
            KnownHost::Unknown
        );
    }

    #[test]
    fn port_22_uses_the_bare_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        learn(&path, "sftp.example.test", 22, &key(KEY_A)).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        // russh separates the entry with a newline even in a fresh file.
        let raw = raw.trim_start();
        assert!(raw.starts_with("sftp.example.test ssh-ed25519 "), "{raw}");
    }

    #[test]
    fn a_different_key_is_reported_as_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        learn(&path, "sftp.example.test", 22, &key(KEY_A)).unwrap();
        assert_eq!(
            check(&path, "sftp.example.test", 22, &key(KEY_B)).unwrap(),
            KnownHost::Changed
        );
    }

    #[tokio::test]
    async fn changed_keys_are_refused_without_a_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        learn(&path, "sftp.example.test", 22, &key(KEY_A)).unwrap();
        let events = EventBus::new();
        let mut rx = events.subscribe();
        let prompts = HostKeyPrompts::default();
        let err = verify(
            &path,
            Some(&prompts),
            &events,
            SessionId::new(),
            "sftp.example.test",
            22,
            &key(KEY_B),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "hostKeyChanged");
        assert!(rx.try_recv().is_err(), "no prompt for a changed key");
    }

    #[tokio::test]
    async fn unknown_keys_are_refused_without_a_prompt_when_nobody_can_answer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let events = EventBus::new();
        let mut rx = events.subscribe();
        let err = verify(
            &path,
            None,
            &events,
            SessionId::new(),
            "sftp.example.test",
            22,
            &key(KEY_A),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind(), "hostKeyRejected");
        assert!(rx.try_recv().is_err(), "no prompt without a listener");
        assert!(!path.exists(), "nothing was learned");
    }

    #[tokio::test]
    async fn an_unanswered_prompt_times_out_as_rejected() {
        let prompts = HostKeyPrompts::new(Duration::from_millis(20));
        let events = EventBus::new();
        let mut rx = events.subscribe();
        let question = HostKeyQuestion {
            session_id: SessionId::new(),
            host: "sftp.example.test".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint_sha256: "SHA256:x".into(),
        };
        assert!(!prompts.ask(&events, question).await);
        let CoreEvent::HostKeyPrompt { request_id, .. } = rx.try_recv().unwrap() else {
            panic!("expected a prompt");
        };
        // Answering after the timeout is refused: the question is closed.
        assert!(matches!(
            prompts.answer(request_id, true),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn answers_reach_the_waiting_prompt() {
        let prompts = std::sync::Arc::new(HostKeyPrompts::default());
        let events = EventBus::new();
        let mut rx = events.subscribe();
        let asker = {
            let prompts = prompts.clone();
            let events = events.clone();
            tokio::spawn(async move {
                prompts
                    .ask(
                        &events,
                        HostKeyQuestion {
                            session_id: SessionId::new(),
                            host: "sftp.example.test".into(),
                            port: 22,
                            key_type: "ssh-ed25519".into(),
                            fingerprint_sha256: "SHA256:x".into(),
                        },
                    )
                    .await
            })
        };
        let CoreEvent::HostKeyPrompt { request_id, .. } = rx.recv().await.unwrap() else {
            panic!("expected a prompt");
        };
        prompts.answer(request_id, true).unwrap();
        assert!(asker.await.unwrap());
    }

    #[test]
    fn unknown_request_ids_are_invalid_input() {
        let prompts = HostKeyPrompts::default();
        assert!(matches!(
            prompts.answer(HostKeyRequestId::new(), false),
            Err(CoreError::InvalidInput(_))
        ));
    }
}
