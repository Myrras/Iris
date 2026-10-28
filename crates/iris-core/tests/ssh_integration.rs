//! Integration tests against **real** OpenSSH servers in Docker.
//!
//! Each test starts `lscr.io/linuxserver/openssh-server` containers through
//! [`testcontainers`] (sshd on 2222, mapped to a random host port) and drives
//! the public [`Core`] API end to end: password, key and agent logins,
//! `known_hosts` handling, a jump host (ProxyJump) on a shared Docker
//! network, the file operations and previews, parallel transfers with
//! resume, an automatic reconnect that lets the queue carry on, a remote
//! edit round trip (save → upload, server change → conflict → copy), and a
//! folder sync (Update, then Mirror, both ways).
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
    AgentLocation, AuthMethod, ConflictResolution, ConnectionProfile, Core, CoreError, CoreEvent,
    CoreResult, EditResolution, FsTarget, JumpHost, Opener, Preview, ProfileId, Secret, SessionId,
    SessionState, SyncGroup, SyncMode, SyncOptions, SyncPlan, TransferDirection, TransferItem,
    TransferList, TransferRequest, TransferState,
};
use russh::keys::{PrivateKey, PublicKey};
use tempfile::TempDir;
use testcontainers::core::{ExecCommand, IntoContainerPort, WaitFor};
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
    container: ContainerAsync<GenericImage>,
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
    Sshd { container, port }
}

impl Sshd {
    /// Run a shell script in the container (as root) and wait for it.
    async fn sh(&self, script: &str) {
        let mut result = self
            .container
            .exec(ExecCommand::new(["sh", "-c", script]))
            .await
            .expect("exec in the container");
        let out = result.stdout_to_vec().await.unwrap_or_default();
        assert_eq!(
            result.exit_code().await.unwrap(),
            Some(0),
            "{script}\n{}",
            String::from_utf8_lossy(&out)
        );
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

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn file_operations_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    // A tree in the login folder (owned by the user) with a link that points
    // outside it, and a text file to preview. All content is fictitious.
    sshd.sh("cd /config && mkdir -p keep tree/a/b \
         && echo fictional > keep/precious.txt \
         && echo deep > tree/a/b/deep.txt \
         && ln -s ../keep tree/to-keep \
         && printf 'line one\\nline two\\n' > notes.txt \
         && chown -R 1000:1000 keep tree notes.txt")
        .await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    let target = remote(session);
    let home = f.core.home_dir(target).await.unwrap();
    let at = |name: &str| format!("{}/{name}", home.trim_end_matches('/'));

    // mkdir, and an existing name is `alreadyExists` (OpenSSH itself only
    // says "failure").
    f.core.mkdir(target, &at("untitled folder")).await.unwrap();
    assert!(matches!(
        f.core.mkdir(target, &at("untitled folder")).await,
        Err(CoreError::AlreadyExists(_))
    ));

    // rename, never onto an existing entry.
    f.core
        .rename(target, &at("untitled folder"), &at("Reports"))
        .await
        .unwrap();
    assert!(matches!(
        f.core.rename(target, &at("Reports"), &at("keep")).await,
        Err(CoreError::AlreadyExists(_))
    ));

    // chmod, recursive.
    let report = f
        .core
        .chmod(target, &[at("tree")], 0o750, true)
        .await
        .unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    let deep = f.core.stat(target, &at("tree/a/b/deep.txt")).await.unwrap();
    assert_eq!(deep.mode.unwrap() & 0o7777, 0o750);
    let precious = f.core.stat(target, &at("keep/precious.txt")).await.unwrap();
    assert_ne!(precious.mode.unwrap() & 0o7777, 0o750, "link not followed");

    // preview, whole and truncated.
    assert_eq!(
        f.core
            .preview(target, &at("notes.txt"), 1024)
            .await
            .unwrap(),
        Preview::Text {
            text: "line one\nline two\n".into(),
            truncated: false,
            total_size: 18,
        }
    );
    assert!(matches!(
        f.core.preview(target, &at("notes.txt"), 4).await.unwrap(),
        Preview::Text { text, truncated: true, .. } if text == "line"
    ));

    // Recursive delete removes the link, not what it points at.
    let report = f
        .core
        .delete(target, &[at("tree"), at("Reports")])
        .await
        .unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    assert!(matches!(
        f.core.stat(target, &at("tree")).await,
        Err(CoreError::NotFound(_))
    ));
    assert!(f.core.stat(target, &at("keep/precious.txt")).await.is_ok());
    f.core.disconnect(session).await.unwrap();
}

// -- Remote edit --------------------------------------------------------------

/// Opens nothing: the test plays the editor by writing the local copy.
struct NoEditor;

impl Opener for NoEditor {
    fn open(&self, _path: &std::path::Path, _app: Option<&str>) -> CoreResult<()> {
        Ok(())
    }

    fn reveal(&self, _path: &std::path::Path) -> CoreResult<()> {
        Ok(())
    }
}

/// Wait (bounded) for the first event `pick` accepts.
async fn next_event<T>(
    rx: &mut tokio::sync::broadcast::Receiver<CoreEvent>,
    what: &str,
    pick: impl Fn(&CoreEvent) -> Option<T>,
) -> T {
    let wait = async {
        loop {
            if let Some(found) = pick(&rx.recv().await.expect("the event bus")) {
                return found;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(30), wait)
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn edit_round_trip_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    sshd.sh("cd /config && printf 'draft one\n' > notes.txt && chown 1000:1000 notes.txt")
        .await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let cache = tempfile::tempdir().unwrap();
    f.core.set_cache_dir(cache.path().to_path_buf());
    f.core.set_opener(Arc::new(NoEditor));
    f.core.set_edit_debounce(Duration::from_millis(100));
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    let target = remote(session);
    let home = f.core.home_dir(target).await.unwrap();
    let at = |name: &str| format!("{}/{name}", home.trim_end_matches('/'));
    let text = |path: String| {
        let core = Arc::clone(&f.core);
        async move {
            match core.preview(target, &path, 1024).await.unwrap() {
                Preview::Text { text, .. } => text,
                other => panic!("not text: {other:?}"),
            }
        }
    };
    let mut events = f.core.subscribe_events();

    // Open, save locally: the save lands on the server.
    let edit = f.core.open_remote(session, &at("notes.txt")).await.unwrap();
    let local = f.core.list_edits()[0].local_path.clone();
    assert_eq!(
        std::fs::read_to_string(&local).unwrap(),
        "draft one
"
    );
    std::fs::write(
        &local,
        "draft two, longer
",
    )
    .unwrap();
    next_event(&mut events, "the upload", |e| {
        matches!(e, CoreEvent::EditUploaded { edit_id, .. } if *edit_id == edit).then_some(())
    })
    .await;
    assert_eq!(
        text(at("notes.txt")).await,
        "draft two, longer
"
    );

    // Someone changes it on the server; the next save is a conflict, and
    // saving a copy keeps both versions.
    sshd.sh("printf 'changed on the server\n' > /config/notes.txt")
        .await;
    std::fs::write(
        &local,
        "draft three
",
    )
    .unwrap();
    next_event(&mut events, "the conflict", |e| {
        matches!(e, CoreEvent::EditConflict { edit_id, .. } if *edit_id == edit).then_some(())
    })
    .await;
    f.core.resolve_edit(edit, EditResolution::SaveCopy).unwrap();
    let copy = next_event(&mut events, "the copy", |e| match e {
        CoreEvent::EditUploaded { edit_id, path, .. } if *edit_id == edit => Some(path.clone()),
        _ => None,
    })
    .await;
    assert_eq!(copy, at("notes (edited).txt"));
    assert_eq!(
        text(copy).await,
        "draft three
"
    );
    assert_eq!(
        text(at("notes.txt")).await,
        "changed on the server
"
    );

    // Disconnecting deletes the local copy.
    f.core.disconnect(session).await.unwrap();
    assert!(!std::path::Path::new(&local).exists());
    assert!(f.core.list_edits().is_empty());
}

// -- Transfers ----------------------------------------------------------------

/// Deterministic, fictitious bytes.
fn data(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed;
    (0..len)
        .map(|_| {
            x = x
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (x >> 33) as u8
        })
        .collect()
}

/// Poll the transfer list until `done` holds.
async fn wait_transfers(
    core: &Core,
    what: &str,
    done: impl Fn(&TransferList) -> bool,
) -> TransferList {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let list = core.list_transfers();
        if done(&list) {
            return list;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {what}: {list:#?}"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn transfer(
    core: &Core,
    session_id: SessionId,
    direction: TransferDirection,
    srcs: &[String],
    dst_dir: &str,
) -> TransferList {
    core.enqueue_transfers(TransferRequest {
        session_id,
        direction,
        items: srcs
            .iter()
            .map(|src| TransferItem { src: src.clone() })
            .collect(),
        dst_dir: dst_dir.into(),
    })
    .unwrap();
    wait_transfers(core, "the transfers to settle", |_| {
        !core.has_active_transfers()
    })
    .await
}

fn all_done(list: &TransferList) -> bool {
    list.jobs.iter().all(|j| j.state == TransferState::Done)
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn parallel_transfers_and_resume_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    f.core
        .save_settings(iris_core::IrisSettings {
            parallel_transfers: 3,
            ..iris_core::IrisSettings::default()
        })
        .unwrap();
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    let home = f.core.home_dir(remote(session)).await.unwrap();
    let at = |name: &str| format!("{}/{name}", home.trim_end_matches('/'));

    // A local tree: six files over two folders, uploaded three at a time.
    let local = f.dir.path().join("tree");
    std::fs::create_dir_all(local.join("nested")).unwrap();
    let files: Vec<(String, Vec<u8>)> = (0..6)
        .map(|i| {
            let name = if i % 2 == 0 {
                format!("part-{i}.bin")
            } else {
                format!("nested/part-{i}.bin")
            };
            (name, data(1_500_000 + i * 100_000, i as u64 + 1))
        })
        .collect();
    for (name, content) in &files {
        std::fs::write(local.join(name), content).unwrap();
    }
    let list = transfer(
        &f.core,
        session,
        TransferDirection::Upload,
        &[local.to_string_lossy().into_owned()],
        &home,
    )
    .await;
    assert!(all_done(&list), "{list:#?}");
    assert_eq!(list.jobs.len(), 6);

    // Download it back somewhere else: byte-identical.
    let back = f.dir.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let list = transfer(
        &f.core,
        session,
        TransferDirection::Download,
        &[at("tree")],
        &back.to_string_lossy(),
    )
    .await;
    assert!(all_done(&list), "{list:#?}");
    for (name, content) in &files {
        assert_eq!(
            &std::fs::read(back.join("tree").join(name)).unwrap(),
            content,
            "{name}"
        );
    }

    // Resume an upload onto a partial remote copy (cut short in the
    // container), through the conflict answer.
    let big = data(8 * 1024 * 1024, 42);
    let big_local = f.dir.path().join("big.bin");
    std::fs::write(&big_local, &big).unwrap();
    let list = transfer(
        &f.core,
        session,
        TransferDirection::Upload,
        &[big_local.to_string_lossy().into_owned()],
        &home,
    )
    .await;
    assert!(all_done(&list));
    sshd.sh("truncate -s 3000000 /config/big.bin").await;
    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Upload,
            items: vec![TransferItem {
                src: big_local.to_string_lossy().into_owned(),
            }],
            dst_dir: home.clone(),
        })
        .unwrap();
    let list = wait_transfers(&f.core, "the conflict", |l| {
        l.jobs
            .iter()
            .any(|j| j.state == TransferState::NeedsDecision)
    })
    .await;
    let job = list
        .jobs
        .iter()
        .find(|j| j.state == TransferState::NeedsDecision)
        .unwrap();
    f.core
        .resolve_conflict(job.id, ConflictResolution::Resume, false)
        .unwrap();
    let list = wait_transfers(&f.core, "the resume", |_| !f.core.has_active_transfers()).await;
    assert!(all_done(&list), "{list:#?}");

    // Download a large file while the connection is cut midway: the job
    // pauses and resumes over a fresh session. A second, uninterrupted
    // download is the reference it must match byte for byte. (Random
    // content, generated in the container, so compression cannot make it
    // finish before the cut.)
    sshd.sh(
        "head -c 268435456 /dev/urandom > /config/huge.bin && chown 1000:1000 /config/huge.bin",
    )
    .await;
    let cut = f.dir.path().join("cut");
    let clean = f.dir.path().join("clean");
    std::fs::create_dir(&cut).unwrap();
    std::fs::create_dir(&clean).unwrap();
    f.core.clear_finished_transfers();
    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Download,
            items: vec![TransferItem {
                src: at("huge.bin"),
            }],
            dst_dir: cut.to_string_lossy().into_owned(),
        })
        .unwrap();
    let list = wait_transfers(&f.core, "progress", |l| {
        l.jobs.first().is_some_and(|j| j.bytes_done > 0)
    })
    .await;
    let job_id = list.jobs[0].id;
    // Kill the process that holds the user's connection (each SFTP channel
    // is an `internal-sftp` child of it). `[@]` keeps the pattern from
    // matching this very command line.
    sshd.sh("pkill -f 'demo[@]notty'").await;
    let paused = wait_transfers(&f.core, "the job to pause", |l| {
        l.jobs[0].state != TransferState::Running
    })
    .await
    .jobs[0]
        .clone();
    assert_eq!(paused.state, TransferState::Paused, "{paused:?}");
    assert!(paused.bytes_done < paused.size, "{paused:?}");
    let session2 = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    assert_eq!(f.core.resume_paused_on(session, session2), 1);
    wait_transfers(&f.core, "the resumed download", |l| {
        l.jobs
            .iter()
            .any(|j| j.id == job_id && j.state == TransferState::Done)
    })
    .await;

    let list = transfer(
        &f.core,
        session2,
        TransferDirection::Download,
        &[at("huge.bin")],
        &clean.to_string_lossy(),
    )
    .await;
    assert!(all_done(&list), "{list:#?}");
    assert_same_file(&cut.join("huge.bin"), &clean.join("huge.bin"));
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn a_cut_connection_reconnects_and_the_queue_continues_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    f.core
        .save_settings(iris_core::IrisSettings {
            parallel_transfers: 1,
            reconnect_attempts: 5,
            ..iris_core::IrisSettings::default()
        })
        .unwrap();
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    // Remembered, so the automatic reconnect can log in by itself.
    f.core
        .set_secret(id, iris_core::SecretKind::Password, Secret::new(PASSWORD))
        .unwrap();
    let session = f.core.connect(id, None, None).await.unwrap();
    let home = f.core.home_dir(remote(session)).await.unwrap();
    let at = |name: &str| format!("{}/{name}", home.trim_end_matches('/'));

    // Collect the session's states as they come.
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut rx = f.core.subscribe_events();
    let sink = Arc::clone(&states);
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let CoreEvent::SessionStateChanged { state, .. } = event {
                sink.lock().unwrap().push(state);
            }
        }
    });

    // Three large random files (generated in the container), copied one at
    // a time; the connection is cut while the first one runs.
    sshd.sh("mkdir -p /config/queue && for i in 1 2 3; do \
         head -c 134217728 /dev/urandom > /config/queue/part-$i.bin; done && \
         chown -R 1000:1000 /config/queue")
        .await;
    let cut = f.dir.path().join("cut");
    let clean = f.dir.path().join("clean");
    std::fs::create_dir(&cut).unwrap();
    std::fs::create_dir(&clean).unwrap();
    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Download,
            items: vec![TransferItem { src: at("queue") }],
            dst_dir: cut.to_string_lossy().into_owned(),
        })
        .unwrap();
    wait_transfers(&f.core, "progress", |l| {
        l.jobs.len() == 3 && l.jobs.iter().any(|j| j.bytes_done > 0)
    })
    .await;
    sshd.sh("pkill -f 'demo[@]notty'").await;

    // Reconnected on its own, on the same session id.
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let seen = states.lock().unwrap().clone();
        let reconnecting = seen
            .iter()
            .position(|s| matches!(s, SessionState::Reconnecting { .. }));
        if let Some(at) = reconnecting {
            if seen[at..].contains(&SessionState::Connected) {
                break;
            }
        }
        assert!(
            !seen
                .iter()
                .any(|s| matches!(s, SessionState::Disconnected { .. })),
            "gave up: {seen:#?}"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "no reconnect: {seen:#?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(f.core.sessions(), vec![session]);

    // The queue carries on by itself: every file arrives.
    let list = wait_transfers(&f.core, "the queue to finish", |l| {
        l.jobs.iter().all(|j| j.state.is_finished())
    })
    .await;
    assert!(all_done(&list), "{list:#?}");
    assert!(list.jobs.iter().all(|j| j.session_id == session));

    // An uninterrupted copy is the reference, byte for byte.
    f.core.clear_finished_transfers();
    let list = transfer(
        &f.core,
        session,
        TransferDirection::Download,
        &[at("queue")],
        &clean.to_string_lossy(),
    )
    .await;
    assert!(all_done(&list), "{list:#?}");
    for i in 1..=3 {
        let name = format!("queue/part-{i}.bin");
        assert_same_file(&cut.join(&name), &clean.join(&name));
    }
}

/// Compare two files chunk by chunk (they are too big to diff in memory).
fn assert_same_file(a: &std::path::Path, b: &std::path::Path) {
    use std::io::Read;
    let (mut fa, mut fb) = (
        std::fs::File::open(a).unwrap(),
        std::fs::File::open(b).unwrap(),
    );
    assert_eq!(fa.metadata().unwrap().len(), fb.metadata().unwrap().len());
    let (mut ba, mut bb) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    loop {
        let n = fa.read(&mut ba).unwrap();
        if n == 0 {
            break;
        }
        fb.read_exact(&mut bb[..n]).unwrap();
        assert!(ba[..n] == bb[..n], "the files differ");
    }
}

/// Every file reports its progress up to its last byte before it is done.
/// The progress throttle used to drop the bytes copied after its last tick,
/// so on a fast link the panel sat at the first chunk until the job changed
/// state, while the file was already complete on the other side.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs Docker; run with just test-integration"]
async fn transfers_report_progress_to_the_last_byte_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    let home = f.core.home_dir(remote(session)).await.unwrap();
    let content = data(32 * 1024 * 1024, 7);
    let local = f.dir.path().join("progress.bin");
    std::fs::write(&local, &content).unwrap();
    let back = f.dir.path().join("back");
    std::fs::create_dir(&back).unwrap();
    let size = content.len() as u64;

    for (direction, src, dst_dir) in [
        (
            TransferDirection::Upload,
            local.to_string_lossy().into_owned(),
            home.clone(),
        ),
        (
            TransferDirection::Download,
            format!("{}/progress.bin", home.trim_end_matches('/')),
            back.to_string_lossy().into_owned(),
        ),
    ] {
        let mut rx = f.core.subscribe_events();
        f.core
            .enqueue_transfers(TransferRequest {
                session_id: session,
                direction,
                items: vec![TransferItem { src }],
                dst_dir,
            })
            .unwrap();
        let mut progress = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(60), rx.recv())
                .await
                .unwrap_or_else(|_| panic!("{direction:?} stalled after {progress:?}"))
                .unwrap();
            match event {
                CoreEvent::TransferProgress { bytes_done, .. } => progress.push(bytes_done),
                CoreEvent::TransferJobChanged { job } if job.state == TransferState::Done => {
                    assert_eq!(job.bytes_done, size);
                    break;
                }
                CoreEvent::TransferJobChanged { job } => assert!(
                    matches!(job.state, TransferState::Queued | TransferState::Running),
                    "{direction:?}: {job:?}"
                ),
                _ => {}
            }
        }
        assert!(
            progress.iter().any(|&b| b > 0 && b < size),
            "{direction:?}: no progress on the way: {progress:?}"
        );
        assert_eq!(
            progress.last(),
            Some(&size),
            "{direction:?}: the last bytes were never announced: {progress:?}"
        );
    }
    assert_same_file(&local, &back.join("progress.bin"));
}

// -- Sync -------------------------------------------------------------------------

/// Run `plan` with its defaults; returns `(copied, failed, deleted, kept)`.
async fn run_sync(core: &Core, plan: &SyncPlan) -> (usize, usize, usize, usize) {
    let mut rx = core.subscribe_events();
    core.run_sync(plan.plan_id, None).await.unwrap();
    let plan_id = plan.plan_id;
    next_event(&mut rx, "the sync to finish", |e| match e {
        CoreEvent::SyncFinished {
            plan_id: id,
            copied,
            failed,
            deleted,
            kept,
            ..
        } if *id == plan_id => Some((*copied, *failed, *deleted, *kept)),
        _ => None,
    })
    .await
}

fn sync_group(plan: &SyncPlan, path: &str) -> Option<SyncGroup> {
    plan.items.iter().find(|i| i.path == path).map(|i| i.group)
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn sync_update_and_mirror_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    // The server folder: an older changed.txt, an extra file and folder.
    sshd.sh("mkdir -p /config/site/stale \
         && printf 'version one\n' > /config/site/changed.txt \
         && touch -d '2020-01-01 00:00:00' /config/site/changed.txt \
         && echo extra > /config/site/extra.txt \
         && echo stale > /config/site/stale/x.txt \
         && chown -R 1000:1000 /config/site")
        .await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    let home = f.core.home_dir(remote(session)).await.unwrap();
    let site = format!("{}/site", home.trim_end_matches('/'));
    let at = |name: &str| format!("{site}/{name}");

    // The local folder (fictitious content), with an excluded .git.
    let local = f.dir.path().join("site");
    std::fs::create_dir_all(local.join("docs")).unwrap();
    std::fs::create_dir_all(local.join(".git")).unwrap();
    std::fs::write(local.join("new.txt"), "brand new\n").unwrap();
    std::fs::write(local.join("changed.txt"), "version two, longer\n").unwrap();
    std::fs::write(local.join("docs/deep.txt"), "deep\n").unwrap();
    std::fs::write(local.join(".git/HEAD"), "ref: main\n").unwrap();
    let local_dir = local.to_string_lossy().into_owned();

    // Update: new and changed go up, the extras stay.
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Upload,
            &local_dir,
            &site,
            SyncOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(sync_group(&plan, "new.txt"), Some(SyncGroup::New));
    assert_eq!(sync_group(&plan, "changed.txt"), Some(SyncGroup::Changed));
    assert_eq!(sync_group(&plan, "docs/deep.txt"), Some(SyncGroup::New));
    assert_eq!(sync_group(&plan, ".git"), Some(SyncGroup::Excluded));
    assert_eq!(sync_group(&plan, "extra.txt"), Some(SyncGroup::TargetOnly));
    let (copied, failed, deleted, _) = run_sync(&f.core, &plan).await;
    assert_eq!((copied, failed, deleted), (3, 0, 0));
    assert!(matches!(
        f.core.preview(remote(session), &at("changed.txt"), 1024).await.unwrap(),
        Preview::Text { text, .. } if text == "version two, longer\n"
    ));
    assert!(f.core.stat(remote(session), &at("extra.txt")).await.is_ok());
    assert!(matches!(
        f.core.stat(remote(session), &at(".git")).await,
        Err(CoreError::NotFound(_))
    ));

    // OpenSSH kept the dates: nothing left to copy.
    let again = f
        .core
        .plan_sync(
            session,
            TransferDirection::Upload,
            &local_dir,
            &site,
            SyncOptions::default(),
        )
        .await
        .unwrap();
    assert!(
        again
            .items
            .iter()
            .all(|i| !matches!(i.group, SyncGroup::New | SyncGroup::Changed)),
        "{:#?}",
        again.items
    );
    assert_eq!(again.totals.get(SyncGroup::Same).files, 3);

    // Mirror: the extras go, the excluded .git is never touched.
    let mirror = SyncOptions {
        mode: SyncMode::Mirror,
        ..SyncOptions::default()
    };
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Upload,
            &local_dir,
            &site,
            mirror.clone(),
        )
        .await
        .unwrap();
    let (copied, failed, deleted, kept) = run_sync(&f.core, &plan).await;
    assert_eq!((copied, failed, deleted, kept), (0, 0, 2, 0));
    for gone in ["extra.txt", "stale"] {
        assert!(
            matches!(
                f.core.stat(remote(session), &at(gone)).await,
                Err(CoreError::NotFound(_))
            ),
            "{gone}"
        );
    }

    // And back down into an empty folder: byte-identical, dates kept.
    let back = f.dir.path().join("back");
    std::fs::create_dir_all(&back).unwrap();
    let back_dir = back.to_string_lossy().into_owned();
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &back_dir,
            &site,
            SyncOptions::default(),
        )
        .await
        .unwrap();
    let (copied, failed, _, _) = run_sync(&f.core, &plan).await;
    assert_eq!((copied, failed), (3, 0));
    assert_eq!(
        std::fs::read(back.join("docs/deep.txt")).unwrap(),
        std::fs::read(local.join("docs/deep.txt")).unwrap()
    );
    let again = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &back_dir,
            &site,
            SyncOptions::default(),
        )
        .await
        .unwrap();
    assert!(again.items.is_empty(), "{:#?}", again.items);
    f.core.disconnect(session).await.unwrap();
}

fn changed_within(since: i64) -> SyncOptions {
    SyncOptions {
        changed_within: Some(iris_core::ChangedWithin { since_unix: since }),
        ..SyncOptions::default()
    }
}

/// Every listed item's path with its group.
fn sync_groups(plan: &SyncPlan) -> Vec<(String, SyncGroup)> {
    plan.items
        .iter()
        .map(|i| (i.path.clone(), i.group))
        .collect()
}

#[tokio::test]
#[ignore = "needs Docker; run with just test-integration"]
async fn sync_within_a_window_against_openssh() {
    let sshd = start_sshd(SshdOptions::default()).await;
    // Server files at controlled dates: two old ones, the rest just now;
    // an excluded folder and a link to a fresh file.
    sshd.sh(
        "mkdir -p /config/site/docs /config/site/node_modules /config/site/archive \
         && echo old > /config/site/archive/2019.txt \
         && touch -d '2019-06-01 12:00:00' /config/site/archive/2019.txt \
         && echo 'version one' > /config/site/stale.txt \
         && touch -d '2020-01-01 00:00:00' /config/site/stale.txt \
         && echo 'brand new' > /config/site/new.txt \
         && echo 'version two, longer' > /config/site/changed.txt \
         && echo deep > /config/site/docs/deep.txt \
         && echo dep > /config/site/node_modules/dep.js \
         && echo linked > /config/site/target.txt \
         && ln -s target.txt /config/site/link.txt \
         && chown -R -h 1000:1000 /config/site \
         && mkdir /config/site/locked && echo secret > /config/site/locked/x.txt \
         && chmod 000 /config/site/locked",
    )
    .await;
    let f = Fixture::new();
    let _answers = auto_answer(&f.core, true);
    let id = f.save(HOST, sshd.port, AuthMethod::Password, None);
    let session = f
        .core
        .connect(id, Some(Secret::new(PASSWORD)), None)
        .await
        .unwrap();
    let home = f.core.home_dir(remote(session)).await.unwrap();
    let site = format!("{}/site", home.trim_end_matches('/'));
    let local = f.dir.path().join("site");
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("changed.txt"), "version one\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(local.join("changed.txt"))
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_577_836_800))
        .unwrap();
    let local_dir = local.to_string_lossy().into_owned();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let since = now - 3600;
    let expected = vec![
        ("changed.txt".to_string(), SyncGroup::Changed),
        ("docs".into(), SyncGroup::New),
        ("docs/deep.txt".into(), SyncGroup::New),
        ("link.txt".into(), SyncGroup::New),
        // Root's folder, unreadable for the user: reported, not entered.
        ("locked".into(), SyncGroup::Skipped),
        ("new.txt".into(), SyncGroup::New),
        ("target.txt".into(), SyncGroup::New),
    ];

    // The image ships GNU findutils: the server search runs.
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &local_dir,
            &site,
            changed_within(since),
        )
        .await
        .unwrap();
    let window = plan.window.unwrap();
    assert_eq!(window.method, iris_core::SearchMethod::ServerFind);
    assert_eq!(
        window.clock_skew_secs, None,
        "the container shares our clock"
    );
    assert_eq!(sync_groups(&plan), expected);

    // The compare rule still decides: a local copy newer than the server.
    std::fs::write(local.join("new.txt"), "newer here\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(local.join("new.txt"))
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(now as u64 + 3600))
        .unwrap();
    let options = SyncOptions {
        rule: iris_core::CompareRule::NewerOnly,
        ..changed_within(since)
    };
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &local_dir,
            &site,
            options,
        )
        .await
        .unwrap();
    assert_eq!(
        sync_group(&plan, "new.txt"),
        Some(SyncGroup::TargetNewer),
        "{:#?}",
        plan.items
    );
    std::fs::remove_file(local.join("new.txt")).unwrap();

    // Without `find` the folders are walked, with the same answer.
    sshd.sh("mv /usr/bin/find /usr/bin/find.off").await;
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &local_dir,
            &site,
            changed_within(since),
        )
        .await
        .unwrap();
    assert_eq!(plan.window.unwrap().method, iris_core::SearchMethod::Walk);
    assert_eq!(sync_groups(&plan), expected);
    let (copied, failed, _, _) = run_sync(&f.core, &plan).await;
    assert_eq!((copied, failed), (5, 0));
    assert_eq!(
        std::fs::read_to_string(local.join("changed.txt")).unwrap(),
        "version two, longer\n"
    );
    assert_eq!(
        std::fs::read_to_string(local.join("link.txt")).unwrap(),
        "linked\n"
    );
    assert!(!local.join("archive").exists());
    assert!(!local.join("stale.txt").exists());
    assert!(!local.join("node_modules").exists());
    sshd.sh("mv /usr/bin/find.off /usr/bin/find").await;

    // An upload within the window: only the fresh local file is looked
    // up on the server and copied.
    std::fs::write(local.join("fresh.txt"), "fresh\n").unwrap();
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Upload,
            &local_dir,
            &site,
            changed_within(now - 60),
        )
        .await
        .unwrap();
    assert_eq!(plan.window.unwrap().method, iris_core::SearchMethod::Walk);
    assert_eq!(
        sync_group(&plan, "fresh.txt"),
        Some(SyncGroup::New),
        "{:#?}",
        plan.items
    );
    assert_eq!(sync_group(&plan, "stale.txt"), None);
    f.core.disconnect(session).await.unwrap();
}
