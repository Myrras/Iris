//! Integration tests against **real** OpenSSH servers in Docker.
//!
//! Each test starts `lscr.io/linuxserver/openssh-server` containers through
//! [`testcontainers`] (sshd on 2222, mapped to a random host port) and drives
//! the public [`Core`] API end to end: password, key and agent logins,
//! `known_hosts` handling, and a jump host (ProxyJump) on a shared Docker
//! network.
//!
//! ## Why every test is `#[ignore]`-d
//! `just test` must stay hermetic and fast, so these need Docker and run
//! only on request:
//!
//! ```text
//! just test-integration
//! # = cargo test -p iris-core --test ssh_integration -- --ignored
//! ```
//!
//! Every test uses its own temp `known_hosts` and an in-process agent; the
//! real `~/.ssh`, agent and keychain are never touched. All data is
//! fictitious.

#![cfg(unix)]

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use iris_core::{
    AgentLocation, AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, FsTarget, JumpHost,
    ProfileId, Secret, SessionId,
};
use russh::keys::{PrivateKey, PublicKey};
use tempfile::TempDir;
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::CopyTargetOptions;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

use support::{random_key, start_agent, write_key_file};

const IMAGE: &str = "lscr.io/linuxserver/openssh-server";
/// Pinned so a new upstream build cannot change the server under the tests.
const TAG: &str = "10.3_p1-r1-ls239";
const SSHD_PORT: u16 = 2222;
const USER: &str = "demo";
const PASSWORD: &str = "example-integration-password";
const HOST: &str = "127.0.0.1";

/// The image ships `AllowTcpForwarding no`. This runs as a custom init
/// script after the sshd config is generated and before sshd starts, so
/// the jump container allows `direct-tcpip` from its first connection.
const ALLOW_FORWARDING: &str = "#!/bin/sh\n\
sed -i 's/^AllowTcpForwarding no$/AllowTcpForwarding yes/' /config/sshd/sshd_config\n\
grep -q '^AllowTcpForwarding yes$' /config/sshd/sshd_config\n";

/// One running sshd container; dropping it removes the container.
struct Sshd {
    _container: ContainerAsync<GenericImage>,
    /// The host port mapped to 2222.
    port: u16,
}

#[derive(Default)]
struct SshdOptions<'a> {
    authorized_key: Option<&'a PublicKey>,
    /// `(network, container name)` to join a shared network under a name.
    network: Option<(&'a str, &'a str)>,
    allow_forwarding: bool,
}

async fn start_sshd(options: SshdOptions<'_>) -> Sshd {
    let image = GenericImage::new(IMAGE, TAG)
        .with_exposed_port(SSHD_PORT.tcp())
        .with_wait_for(WaitFor::message_on_stdout("[ls.io-init] done."));
    let mut request = image
        .with_env_var("PUID", "1000")
        .with_env_var("PGID", "1000")
        .with_env_var("TZ", "Etc/UTC")
        .with_env_var("USER_NAME", USER)
        .with_env_var("USER_PASSWORD", PASSWORD)
        .with_env_var("PASSWORD_ACCESS", "true")
        .with_startup_timeout(Duration::from_secs(120));
    if let Some(key) = options.authorized_key {
        request = request.with_env_var("PUBLIC_KEY", key.to_openssh().unwrap());
    }
    if let Some((network, name)) = options.network {
        request = request.with_network(network).with_container_name(name);
    }
    if options.allow_forwarding {
        request = request.with_copy_to(
            CopyTargetOptions::new("/custom-cont-init.d/10-allow-tcp-forwarding").with_mode(0o755),
            ALLOW_FORWARDING.as_bytes().to_vec(),
        );
    }
    let container = request.start().await.expect("start the sshd container");
    let port = container
        .get_host_port_ipv4(SSHD_PORT.tcp())
        .await
        .expect("map port 2222");
    Sshd {
        _container: container,
        port,
    }
}

/// A core with a temp `known_hosts` (empty: every host key is unknown).
struct Fixture {
    core: Arc<Core>,
    known_hosts: PathBuf,
    dir: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts.clone());
        core.set_ssh_config_path(dir.path().join("ssh_config"));
        Self {
            core,
            known_hosts,
            dir,
        }
    }

    fn key_file(&self, name: &str, key: &PrivateKey) -> String {
        let path = self.dir.path().join(name);
        write_key_file(&path, key, None);
        path.to_string_lossy().into_owned()
    }

    fn save(&self, host: &str, port: u16, auth: AuthMethod, jump: Option<JumpHost>) -> ProfileId {
        self.core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: format!("{host} integration"),
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

/// Answer every host key prompt with `trust`, reporting each prompted host.
fn auto_answer(core: &Arc<Core>, trust: bool) -> tokio::sync::mpsc::UnboundedReceiver<String> {
    let mut rx = core.subscribe_events();
    let core = Arc::clone(core);
    let (tx, seen) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let CoreEvent::HostKeyPrompt {
                request_id, host, ..
            } = event
            {
                core.answer_host_key(request_id, trust).unwrap();
                let _ = tx.send(host);
            }
        }
    });
    seen
}

fn remote(session_id: SessionId) -> FsTarget {
    FsTarget::Remote { session_id }
}

async fn assert_lists_home(core: &Core, session: SessionId) {
    let home = core.home_dir(remote(session)).await.unwrap();
    core.list_dir(remote(session), &home).await.unwrap();
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn password_login() {
    let sshd = start_sshd(SshdOptions::default()).await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);

    let err = f
        .core
        .connect(id, Some(Secret::new("not-the-password")), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::AuthFailed), "{err:?}");

    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    assert_lists_home(&f.core, session).await;
    f.core.disconnect(session).await.unwrap();
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn key_login() {
    let client_key = random_key();
    let sshd = start_sshd(SshdOptions {
        authorized_key: Some(client_key.public_key()),
        ..SshdOptions::default()
    })
    .await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let key = f.key_file("id_client", &client_key);
    let id = f.save(HOST, sshd.port, AuthMethod::KeyFile { path: key }, None);
    let session = f.core.connect(id, None, None).await.unwrap();
    assert_lists_home(&f.core, session).await;

    // A key the server does not know is refused.
    let other = f.key_file("id_other", &random_key());
    let id = f.save(HOST, sshd.port, AuthMethod::KeyFile { path: other }, None);
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::AuthFailed), "{err:?}");
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn agent_login() {
    let client_key = random_key();
    let sshd = start_sshd(SshdOptions {
        authorized_key: Some(client_key.public_key()),
        ..SshdOptions::default()
    })
    .await;
    // The authorized key is the second identity the agent offers.
    let agent = start_agent(&[random_key(), client_key]).await;
    let f = Fixture::new();
    f.core.set_agent(AgentLocation::Path(agent.socket.clone()));
    let _answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Agent, None);
    let session = f.core.connect(id, None, None).await.unwrap();
    assert_lists_home(&f.core, session).await;
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn unknown_host_key_is_prompted_then_remembered() {
    let sshd = start_sshd(SshdOptions::default()).await;
    let f = Fixture::new();
    let mut answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);

    f.core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    assert_eq!(answers.try_recv().unwrap(), HOST);
    let known = std::fs::read_to_string(&f.known_hosts).unwrap();
    assert!(
        known.contains(&format!("[{HOST}]:{} ", sshd.port)),
        "{known}"
    );

    f.core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    assert!(answers.try_recv().is_err(), "no second prompt");
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn changed_host_key_is_refused_without_a_prompt() {
    let sshd = start_sshd(SshdOptions::default()).await;
    let f = Fixture::new();
    // known_hosts records another ed25519 key for this `[host]:port`.
    let recorded = format!(
        "[{HOST}]:{} {}\n",
        sshd.port,
        random_key().public_key().to_openssh().unwrap()
    );
    std::fs::write(&f.known_hosts, &recorded).unwrap();
    let mut answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);

    let err = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::HostKeyChanged { host, port } if host == HOST && *port == sshd.port),
        "{err:?}"
    );
    assert!(answers.try_recv().is_err(), "never offered to trust it");
    assert_eq!(std::fs::read_to_string(&f.known_hosts).unwrap(), recorded);
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn proxy_jump_reaches_a_target_on_the_jump_network() {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let network = format!("iris-it-{id}");
    let target_name = format!("iris-target-{id}");
    let jump_name = format!("iris-jump-{id}");
    let jump_key = random_key();

    let target = start_sshd(SshdOptions {
        network: Some((&network, &target_name)),
        ..SshdOptions::default()
    })
    .await;
    let jump = start_sshd(SshdOptions {
        authorized_key: Some(jump_key.public_key()),
        network: Some((&network, &jump_name)),
        allow_forwarding: true,
    })
    .await;

    let f = Fixture::new();
    let mut answers = auto_answer(&f.core, true);
    let key = f.key_file("id_jump", &jump_key);
    let jump_id = f.save(HOST, jump.port, AuthMethod::KeyFile { path: key }, None);
    // The target is addressed by its container name, which only resolves
    // inside the Docker network, i.e. from the jump host.
    let target_id = f.save(
        &target_name,
        SSHD_PORT,
        AuthMethod::Password,
        Some(JumpHost::Profile {
            profile_id: jump_id,
        }),
    );

    let session = f
        .core
        .connect(target_id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    assert_lists_home(&f.core, session).await;
    // Both hops had their own (unknown) host key checked.
    let mut prompted = vec![answers.try_recv().unwrap(), answers.try_recv().unwrap()];
    prompted.sort();
    let mut expected = vec![HOST.to_string(), target_name.clone()];
    expected.sort();
    assert_eq!(prompted, expected);
    f.core.disconnect(session).await.unwrap();

    // Without forwarding a jump host cannot reach the target: the target
    // container itself refuses `direct-tcpip` to its own sshd.
    let blocked_jump = f.save(HOST, target.port, AuthMethod::Password, None);
    f.core
        .set_secret(
            blocked_jump,
            iris_core::SecretKind::Password,
            Secret::new(PASSWORD),
        )
        .unwrap();
    let via_blocked = f.save(
        &jump_name,
        SSHD_PORT,
        AuthMethod::Password,
        Some(JumpHost::Profile {
            profile_id: blocked_jump,
        }),
    );
    let err = f
        .core
        .connect(via_blocked, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "jumpHost", "{err:?}");
}
