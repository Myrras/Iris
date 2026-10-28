//! Reaching the user's SSH agent.
//!
//! - Unix: the socket in `SSH_AUTH_SOCK`.
//! - Windows: the pipe in `SSH_AUTH_SOCK` when set, else the Windows
//!   OpenSSH agent pipe, else Pageant. This path is compile-gated and only
//!   build-checked in CI on macOS; it has not been exercised on Windows yet.
//!
//! [`AgentLocation::Path`] points at a specific socket / pipe instead, which
//! is what the tests use (an in-process agent on a temp socket).

use std::path::PathBuf;

use russh::keys::agent::client::{AgentClient, AgentStream};

use crate::error::{CoreError, CoreResult};

/// Where the agent is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLocation {
    /// The user's agent, found the platform's usual way (module docs).
    System,
    /// A specific Unix socket (or, on Windows, named pipe).
    Path(PathBuf),
}

/// An agent connection, whatever the transport.
pub type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

fn unavailable(err: impl std::fmt::Display) -> CoreError {
    tracing::debug!("could not reach the SSH agent: {err}");
    CoreError::Agent("no SSH agent is running".into())
}

/// Open a connection to the agent at `location`.
pub async fn connect(location: &AgentLocation) -> CoreResult<Agent> {
    match location {
        AgentLocation::System => connect_system().await,
        AgentLocation::Path(path) => connect_path(path).await,
    }
}

#[cfg(unix)]
async fn connect_path(path: &std::path::Path) -> CoreResult<Agent> {
    AgentClient::connect_uds(path)
        .await
        .map(AgentClient::dynamic)
        .map_err(unavailable)
}

#[cfg(unix)]
async fn connect_system() -> CoreResult<Agent> {
    match std::env::var_os("SSH_AUTH_SOCK") {
        Some(sock) if !sock.is_empty() => connect_path(std::path::Path::new(&sock)).await,
        _ => Err(unavailable("SSH_AUTH_SOCK is not set")),
    }
}

#[cfg(windows)]
async fn connect_path(path: &std::path::Path) -> CoreResult<Agent> {
    AgentClient::connect_named_pipe(path)
        .await
        .map(AgentClient::dynamic)
        .map_err(unavailable)
}

#[cfg(windows)]
async fn connect_system() -> CoreResult<Agent> {
    // Windows OpenSSH's agent service listens on this pipe.
    const OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    if let Some(sock) = std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty()) {
        return connect_path(std::path::Path::new(&sock)).await;
    }
    match AgentClient::connect_named_pipe(OPENSSH_PIPE).await {
        Ok(agent) => Ok(agent.dynamic()),
        Err(e) => {
            tracing::debug!("no Windows OpenSSH agent ({e}); trying Pageant");
            AgentClient::connect_pageant()
                .await
                .map(AgentClient::dynamic)
                .map_err(unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_socket_is_an_agent_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = match connect(&AgentLocation::Path(dir.path().join("agent.sock"))).await {
            Err(e) => e,
            Ok(_) => panic!("connected to nothing"),
        };
        assert_eq!(err.kind(), "agent");
        assert_eq!(err.to_string(), "ssh agent: no SSH agent is running");
    }
}
