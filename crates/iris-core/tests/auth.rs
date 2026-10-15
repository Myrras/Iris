//! Integration tests for the Phase 2 logins: ssh-agent, `~/.ssh/config`
//! hosts, jump hosts (ProxyJump) and remembered secrets, against the
//! hermetic in-process servers and agent in `support/`. Every test uses its
//! own temp `known_hosts`, SSH config and in-memory secret store; the real
//! `~/.ssh`, agent and keychain are never touched.

#![cfg(unix)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;

use iris_core::{
    AgentLocation, AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, Credentials,
    FsTarget, JumpHost, ProfileId, Secret, SecretKind, SessionId,
};
use tempfile::TempDir;

use support::{random_key, start_agent, write_key_file, TestServer, HOST, PASSWORD, USER};

/// The name a hidden target is known by behind its jump host.
const TARGET: &str = "target.internal.test";

struct Fixture {
    core: Arc<Core>,
    known_hosts: PathBuf,
    ssh_config: PathBuf,
    dir: TempDir,
}

impl Fixture {
    /// A core with a temp `known_hosts` trusting `trusted`, and a temp SSH
    /// config path (no file yet).
    fn new(trusted: &[String]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        std::fs::write(&known_hosts, trusted.concat()).unwrap();
        let ssh_config = dir.path().join("ssh_config");
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts.clone());
        core.set_ssh_config_path(ssh_config.clone());
        Self {
            core,
            known_hosts,
            ssh_config,
            dir,
        }
    }

    fn write_config(&self, text: &str) {
        std::fs::write(&self.ssh_config, text).unwrap();
    }

    /// An unencrypted (or, with `passphrase`, encrypted) key file for `key`.
    fn key_file(
        &self,
        name: &str,
        key: &russh::keys::PrivateKey,
        passphrase: Option<&str>,
    ) -> String {
        let path = self.dir.path().join(name);
        write_key_file(&path, key, passphrase);
        path.to_string_lossy().into_owned()
    }

    fn save(&self, host: &str, port: u16, auth: AuthMethod, jump: Option<JumpHost>) -> ProfileId {
        self.core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: format!("{host} test"),
                host: host.into(),
                port,
                user: USER.into(),
                auth,
                start_dir: None,
                jump,
            })
            .unwrap()
            .id
    }
}

fn remote(session_id: SessionId) -> FsTarget {
    FsTarget::Remote { session_id }
}

fn key_auth(path: &str) -> AuthMethod {
    AuthMethod::KeyFile { path: path.into() }
}

fn config_host(alias: &str) -> AuthMethod {
    AuthMethod::SshConfigHost {
        alias: alias.into(),
    }
}

// -- ssh-agent ------------------------------------------------------------------

#[tokio::test]
async fn agent_auth_tries_each_identity() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    // The authorized key is the second one the agent offers.
    let agent = start_agent(&[random_key(), client_key]).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    f.core.set_agent(AgentLocation::Path(agent.socket.clone()));

    let id = f.save(HOST, server.port, AuthMethod::Agent, None);
    let session = f.core.connect(id, None, None).await.unwrap();
    assert!(f.core.list_dir(remote(session), "/").await.is_ok());
}

#[tokio::test]
async fn an_agent_without_the_right_key_is_auth_failed() {
    let server = TestServer::start(Some(random_key().public_key().clone())).await;
    let agent = start_agent(&[random_key()]).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    f.core.set_agent(AgentLocation::Path(agent.socket.clone()));
    let id = f.save(HOST, server.port, AuthMethod::Agent, None);
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::AuthFailed), "{err:?}");
}

#[tokio::test]
async fn an_empty_or_missing_agent_is_an_agent_error() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let id = f.save(HOST, server.port, AuthMethod::Agent, None);

    // No agent configured at all.
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert_eq!(err.kind(), "agent", "{err:?}");

    // A socket nobody listens on.
    f.core
        .set_agent(AgentLocation::Path(f.dir.path().join("nothing.sock")));
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert_eq!(err.to_string(), "ssh agent: no SSH agent is running");

    // An agent without keys.
    let agent = start_agent(&[]).await;
    f.core.set_agent(AgentLocation::Path(agent.socket.clone()));
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert_eq!(err.to_string(), "ssh agent: the SSH agent has no keys");
}

// -- ~/.ssh/config hosts ----------------------------------------------------------

#[tokio::test]
async fn config_hosts_are_listed_and_connect_with_their_identity_file() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let key = f.key_file("id_web", &client_key, None);
    f.write_config(&format!(
        "Host web\n  HostName {HOST}\n  Port {}\n  User {USER}\n  IdentityFile {key}\n\
         Host *.example.test\n  User nobody\n",
        server.port
    ));

    let hosts = f.core.list_ssh_config_hosts().unwrap();
    assert_eq!(hosts.len(), 1);
    assert_eq!(hosts[0].alias, "web");
    assert_eq!(hosts[0].host_name.as_deref(), Some(HOST));
    assert_eq!(hosts[0].port, Some(server.port));
    assert_eq!(hosts[0].identity_files, std::slice::from_ref(&key));

    // The profile's own host/port/user are only fallbacks: the config wins.
    let id = f.save("stale.example.test", 2200, config_host("web"), None);
    let session = f.core.connect(id, None, None).await.unwrap();
    assert!(f.core.list_dir(remote(session), "/").await.is_ok());
}

#[tokio::test]
async fn config_hosts_fall_back_to_the_agent() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let agent = start_agent(&[client_key]).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    f.core.set_agent(AgentLocation::Path(agent.socket.clone()));
    // One identity file is missing, the other is the wrong key.
    let wrong = f.key_file("id_wrong", &random_key(), None);
    f.write_config(&format!(
        "Host web\n  HostName {HOST}\n  Port {}\n  IdentityFile {}/id_missing\n  IdentityFile {wrong}\n",
        server.port,
        f.dir.path().display()
    ));
    let id = f.save("web", 22, config_host("web"), None);
    f.core.connect(id, None, None).await.unwrap();
}

#[tokio::test]
async fn an_encrypted_config_identity_asks_for_its_passphrase() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let key = f.key_file("id_locked", &client_key, Some("open sesame"));
    f.write_config(&format!(
        "Host web\n  HostName {HOST}\n  Port {}\n  IdentityFile {key}\n",
        server.port
    ));
    let id = f.save("web", 22, config_host("web"), None);

    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::PassphraseRequired), "{err:?}");
    let err = f
        .core
        .connect(id, None, Some(Secret::new("wrong")))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::KeyFile(m) if m == "wrong passphrase"),
        "{err:?}"
    );
    f.core
        .connect(id, None, Some(Secret::new("open sesame")))
        .await
        .unwrap();
}

// -- Jump hosts -----------------------------------------------------------------

/// A jump server (password login) routing [`TARGET`]:22 to a hidden target
/// that accepts `target_key`.
async fn jump_and_target(target_key: &russh::keys::PrivateKey) -> (TestServer, TestServer) {
    let target = TestServer::start_hidden(Some(target_key.public_key().clone())).await;
    let jump = TestServer::start_jump(None, &[(TARGET, 22, &target)]).await;
    (jump, target)
}

#[tokio::test]
async fn a_saved_jump_profile_reaches_a_hidden_target() {
    let target_key = random_key();
    let (jump, target) = jump_and_target(&target_key).await;
    assert_eq!(target.port, 0, "the target has no TCP listener");
    std::fs::write(target.root().join("behind-the-jump.txt"), "x").unwrap();
    let f = Fixture::new(&[
        jump.known_hosts_line(),
        target.known_hosts_line_as(TARGET, 22),
    ]);

    let jump_id = f.save(HOST, jump.port, AuthMethod::Password, None);
    f.core
        .set_secret(jump_id, SecretKind::Password, Secret::new(PASSWORD))
        .unwrap();
    let key = f.key_file("id_target", &target_key, None);
    let target_id = f.save(
        TARGET,
        22,
        key_auth(&key),
        Some(JumpHost::Profile {
            profile_id: jump_id,
        }),
    );

    let session = f.core.connect(target_id, None, None).await.unwrap();
    let entries = f.core.list_dir(remote(session), "/").await.unwrap();
    assert_eq!(entries[0].name, "behind-the-jump.txt");
    f.core.disconnect(session).await.unwrap();
    assert!(f.core.sessions().is_empty());
}

#[tokio::test]
async fn a_jump_profile_without_a_saved_password_is_a_jump_host_error() {
    let target_key = random_key();
    let (jump, target) = jump_and_target(&target_key).await;
    let f = Fixture::new(&[
        jump.known_hosts_line(),
        target.known_hosts_line_as(TARGET, 22),
    ]);
    let jump_id = f.save(HOST, jump.port, AuthMethod::Password, None);
    let key = f.key_file("id_target", &target_key, None);
    let target_id = f.save(
        TARGET,
        22,
        key_auth(&key),
        Some(JumpHost::Profile {
            profile_id: jump_id,
        }),
    );
    let err = f.core.connect(target_id, None, None).await.unwrap_err();
    assert_eq!(err.kind(), "jumpHost", "{err:?}");
    assert!(err.to_string().contains("needs a password"), "{err}");

    // A wrong saved password names the jump host too.
    f.core
        .set_secret(jump_id, SecretKind::Password, Secret::new("not-it"))
        .unwrap();
    let err = f.core.connect(target_id, None, None).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        format!("jump host: {HOST} test: authentication failed")
    );
}

#[tokio::test]
async fn an_unreachable_target_behind_the_jump_is_reported() {
    let jump_key = random_key();
    let jump = TestServer::start_jump(Some(jump_key.public_key().clone()), &[]).await;
    let f = Fixture::new(&[jump.known_hosts_line()]);
    let key = f.key_file("id_jump", &jump_key, None);
    let jump_id = f.save(HOST, jump.port, key_auth(&key), None);
    let target_id = f.save(
        "nowhere.internal.test",
        22,
        AuthMethod::Password,
        Some(JumpHost::Profile {
            profile_id: jump_id,
        }),
    );
    let err = f
        .core
        .connect(target_id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        format!("jump host: {HOST} test could not reach nowhere.internal.test:22")
    );
}

#[tokio::test]
async fn a_config_proxy_jump_chain_is_followed() {
    // outer (TCP) → inner (only via outer) → target (only via inner).
    let key = random_key();
    let target = TestServer::start_hidden(Some(key.public_key().clone())).await;
    let inner =
        TestServer::start_jump(Some(key.public_key().clone()), &[(TARGET, 22, &target)]).await;
    let outer = TestServer::start_jump(
        Some(key.public_key().clone()),
        &[("inner.internal.test", 2222, &inner)],
    )
    .await;
    let f = Fixture::new(&[
        outer.known_hosts_line(),
        inner.known_hosts_line_as("inner.internal.test", 2222),
        target.known_hosts_line_as(TARGET, 22),
    ]);
    let key = f.key_file("id_all", &key, None);
    f.write_config(&format!(
        "Host outer\n  HostName {HOST}\n  Port {}\n  User {USER}\n  IdentityFile {key}\n\
         Host inner\n  HostName inner.internal.test\n  Port 2222\n  User {USER}\n  IdentityFile {key}\n  ProxyJump outer\n\
         Host app\n  HostName {TARGET}\n  User {USER}\n  IdentityFile {key}\n  ProxyJump inner\n",
        outer.port
    ));
    let id = f.save("app", 22, config_host("app"), None);
    let session = f.core.connect(id, None, None).await.unwrap();
    assert!(f.core.list_dir(remote(session), "/").await.is_ok());
}

#[tokio::test]
async fn an_alias_jump_on_a_password_profile() {
    let jump_key = random_key();
    let target = TestServer::start_hidden(None).await;
    let jump = TestServer::start_jump(
        Some(jump_key.public_key().clone()),
        &[(TARGET, 22, &target)],
    )
    .await;
    let f = Fixture::new(&[
        jump.known_hosts_line(),
        target.known_hosts_line_as(TARGET, 22),
    ]);
    let key = f.key_file("id_jump", &jump_key, None);
    f.write_config(&format!(
        "Host bastion\n  HostName {HOST}\n  Port {}\n  IdentityFile {key}\n",
        jump.port
    ));
    let id = f.save(
        TARGET,
        22,
        AuthMethod::Password,
        Some(JumpHost::Alias {
            alias: format!("{USER}@bastion"),
        }),
    );
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    assert!(f.core.list_dir(remote(session), "/").await.is_ok());
}

#[tokio::test]
async fn each_hop_checks_its_own_host_key() {
    let target_key = random_key();
    let (jump, _target) = jump_and_target(&target_key).await;
    // Only the jump host is trusted; the target's key is unknown.
    let f = Fixture::new(&[jump.known_hosts_line()]);
    let jump_id = f.save(HOST, jump.port, AuthMethod::Password, None);
    f.core
        .set_secret(jump_id, SecretKind::Password, Secret::new(PASSWORD))
        .unwrap();
    let key = f.key_file("id_target", &target_key, None);
    let target_id = f.save(
        TARGET,
        22,
        key_auth(&key),
        Some(JumpHost::Profile {
            profile_id: jump_id,
        }),
    );

    let mut rx = f.core.subscribe_events();
    let core = Arc::clone(&f.core);
    let answering = tokio::spawn(async move {
        let mut asked = Vec::new();
        while let Ok(event) = rx.recv().await {
            if let CoreEvent::HostKeyPrompt {
                request_id,
                ref host,
                ..
            } = event
            {
                asked.push(host.clone());
                core.answer_host_key(request_id, true).unwrap();
            }
            if matches!(
                event,
                CoreEvent::SessionStateChanged {
                    state: iris_core::SessionState::Connected,
                    ..
                }
            ) {
                return asked;
            }
        }
        asked
    });
    f.core.connect(target_id, None, None).await.unwrap();
    assert_eq!(answering.await.unwrap(), [TARGET]);
    let known = std::fs::read_to_string(&f.known_hosts).unwrap();
    assert!(known.contains(&format!("{TARGET} ssh-ed25519 ")), "{known}");

    // A changed key on the jump host is a hard stop naming the jump host.
    std::fs::write(
        &f.known_hosts,
        format!(
            "[{HOST}]:{} {}\n",
            jump.port,
            random_key().public_key().to_openssh().unwrap()
        ),
    )
    .unwrap();
    let err = f.core.connect(target_id, None, None).await.unwrap_err();
    assert!(
        matches!(&err, CoreError::HostKeyChanged { host, port } if host == HOST && *port == jump.port),
        "{err:?}"
    );
}

// -- Remembered secrets -------------------------------------------------------------

#[tokio::test]
async fn a_remembered_password_is_used_and_a_wrong_one_fails() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let id = f.save(HOST, server.port, AuthMethod::Password, None);

    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::PasswordRequired), "{err:?}");

    f.core
        .set_secret(id, SecretKind::Password, Secret::new("stale-password"))
        .unwrap();
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::AuthFailed), "{err:?}");

    // Typing the right one with "remember" replaces the stored one…
    let failed = f
        .core
        .connect_with(
            id,
            Credentials {
                password: Some(Secret::new("still-wrong")),
                remember: true,
                ..Credentials::default()
            },
        )
        .await;
    assert!(failed.is_err());
    f.core
        .connect_with(
            id,
            Credentials {
                password: Some(Secret::new(PASSWORD)),
                remember: true,
                ..Credentials::default()
            },
        )
        .await
        .unwrap();
    // …so the next connect needs nothing.
    f.core.connect(id, None, None).await.unwrap();

    f.core.clear_secret(id, SecretKind::Password).unwrap();
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::PasswordRequired), "{err:?}");
}

#[tokio::test]
async fn a_remembered_passphrase_unlocks_the_key() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let key = f.key_file("id_locked", &client_key, Some("open sesame"));
    let id = f.save(HOST, server.port, key_auth(&key), None);
    f.core
        .connect_with(
            id,
            Credentials {
                passphrase: Some(Secret::new("open sesame")),
                remember: true,
                ..Credentials::default()
            },
        )
        .await
        .unwrap();
    f.core.connect(id, None, None).await.unwrap();
}

#[tokio::test]
async fn secrets_belong_to_existing_profiles_and_go_with_them() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let err = f
        .core
        .set_secret(ProfileId::new(), SecretKind::Password, Secret::new("x"))
        .unwrap_err();
    assert_eq!(err.kind(), "notFound");

    let id = f.save(HOST, server.port, AuthMethod::Password, None);
    f.core
        .set_secret(id, SecretKind::Password, Secret::new(PASSWORD))
        .unwrap();
    f.core.connect(id, None, None).await.unwrap();
    f.core.delete_profile(id).unwrap();

    // A profile saved again under the same id finds nothing remembered.
    f.core
        .save_profile(ConnectionProfile {
            id,
            name: "again".into(),
            host: HOST.into(),
            port: server.port,
            user: USER.into(),
            auth: AuthMethod::Password,
            start_dir: None,
            jump: None,
        })
        .unwrap();
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::PasswordRequired), "{err:?}");
}

#[tokio::test]
async fn secrets_never_leak_into_files_events_errors_or_debug_output() {
    const SECRET: &str = "Zx9-unmistakable-secret-Qw7";
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let f = Fixture::new(&[server.known_hosts_line()]);
    let profiles_file = f.dir.path().join("profiles.json");
    f.core.set_profiles_path(profiles_file.clone());
    let mut rx = f.core.subscribe_events();

    let password_id = f.save(HOST, server.port, AuthMethod::Password, None);
    let key = f.key_file("id_locked", &client_key, Some(SECRET));
    let key_id = f.save(HOST, server.port, key_auth(&key), None);
    let jump_target = f.save(
        TARGET,
        22,
        AuthMethod::Password,
        Some(JumpHost::Profile {
            profile_id: password_id,
        }),
    );

    let mut texts = Vec::new();
    let credentials = Credentials {
        password: Some(Secret::new(SECRET)),
        passphrase: Some(Secret::new(SECRET)),
        remember: true,
    };
    texts.push(format!("{credentials:?}"));
    // A wrong remembered password, a wrong typed one, a wrong passphrase
    // and a jump host login with a wrong remembered password.
    f.core
        .set_secret(password_id, SecretKind::Password, Secret::new(SECRET))
        .unwrap();
    for result in [
        f.core.connect(password_id, None, None).await,
        f.core.connect_with(password_id, credentials).await,
        f.core
            .connect(key_id, None, Some(Secret::new(format!("{SECRET}-x"))))
            .await,
        f.core
            .connect(jump_target, Some(Secret::new(SECRET)), None)
            .await,
    ] {
        let err = result.unwrap_err();
        texts.push(err.to_string());
        texts.push(format!("{err:?}"));
    }
    // And one that works, remembering the passphrase.
    let session = f
        .core
        .connect_with(
            key_id,
            Credentials {
                passphrase: Some(Secret::new(SECRET)),
                remember: true,
                ..Credentials::default()
            },
        )
        .await
        .unwrap();
    f.core.disconnect(session).await.unwrap();

    while let Ok(event) = rx.try_recv() {
        texts.push(serde_json::to_string(&event).unwrap());
        texts.push(format!("{event:?}"));
    }
    for profile in f.core.list_profiles() {
        texts.push(serde_json::to_string(&profile).unwrap());
        texts.push(format!("{profile:?}"));
    }
    texts.push(std::fs::read_to_string(&profiles_file).unwrap());
    assert!(texts.len() > 10);
    for text in &texts {
        assert!(!text.contains(SECRET), "secret leaked into: {text}");
    }
}

#[tokio::test]
async fn losing_the_jump_host_ends_the_session() {
    let target_key = random_key();
    let (jump, target) = jump_and_target(&target_key).await;
    let f = Fixture::new(&[
        jump.known_hosts_line(),
        target.known_hosts_line_as(TARGET, 22),
    ]);
    let jump_id = f.save(HOST, jump.port, AuthMethod::Password, None);
    f.core
        .set_secret(jump_id, SecretKind::Password, Secret::new(PASSWORD))
        .unwrap();
    let key = f.key_file("id_target", &target_key, None);
    let target_id = f.save(
        TARGET,
        22,
        key_auth(&key),
        Some(JumpHost::Profile {
            profile_id: jump_id,
        }),
    );
    let session = f.core.connect(target_id, None, None).await.unwrap();
    let mut rx = f.core.subscribe_events();

    jump.disconnect_all().await;
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .expect("a disconnect event")
        .unwrap();
    assert!(
        matches!(
            &event,
            CoreEvent::SessionStateChanged {
                session_id,
                state: iris_core::SessionState::Disconnected,
                reason: Some(_),
                ..
            } if *session_id == session
        ),
        "{event:?}"
    );
    assert!(f.core.sessions().is_empty());
}
