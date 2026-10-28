//! Integration tests for connecting and browsing over SFTP, against the
//! hermetic in-process server in `support/`. Every test uses its own temp
//! `known_hosts`; the real `~/.ssh/known_hosts` is never touched.

#![cfg(unix)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use iris_core::ssh::hostkey::fingerprint_sha256;
use iris_core::{
    AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, EntryKind, FsTarget, IrisSettings,
    LinkTargetKind, Preview, ProfileId, Secret, SessionId, SessionState,
};
use tempfile::TempDir;
use tokio::sync::broadcast;

use support::{random_key, write_key_file, TestServer, HOST, PASSWORD, USER};

/// A core wired to a temp `known_hosts` (pre-trusting `server` when asked).
struct Fixture {
    core: Arc<Core>,
    known_hosts: PathBuf,
    _dir: TempDir,
}

fn fixture(server: &TestServer, trusted: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let known_hosts = dir.path().join("known_hosts");
    if trusted {
        std::fs::write(&known_hosts, server.known_hosts_line()).unwrap();
    }
    let core = Arc::new(Core::new());
    core.set_known_hosts_path(known_hosts.clone());
    Fixture {
        core,
        known_hosts,
        _dir: dir,
    }
}

fn save_profile(core: &Core, port: u16, auth: AuthMethod) -> ProfileId {
    core.save_profile(ConnectionProfile {
        id: ProfileId::new(),
        name: "Test server".into(),
        host: HOST.into(),
        port,
        user: USER.into(),
        auth,
        start_dir: None,
        jump: None,
    })
    .unwrap()
    .id
}

fn password() -> Option<Secret> {
    Some(Secret::new(PASSWORD))
}

async fn connect_with_password(f: &Fixture, server: &TestServer) -> SessionId {
    let id = save_profile(&f.core, server.port, AuthMethod::Password);
    f.core.connect(id, password(), None).await.unwrap()
}

/// Answer every host key prompt with `trust`, reporting each prompt seen.
fn auto_answer(core: &Arc<Core>, trust: bool) -> tokio::sync::mpsc::UnboundedReceiver<CoreEvent> {
    let mut rx = core.subscribe_events();
    let core = Arc::clone(core);
    let (tx, seen) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            if let CoreEvent::HostKeyPrompt { request_id, .. } = &event {
                core.answer_host_key(*request_id, trust).unwrap();
                let _ = tx.send(event);
            }
        }
    });
    seen
}

fn drain(rx: &mut broadcast::Receiver<CoreEvent>) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    events
}

fn states(events: &[CoreEvent]) -> Vec<SessionState> {
    events
        .iter()
        .filter_map(|e| match e {
            CoreEvent::SessionStateChanged { state, .. } => Some(state.clone()),
            _ => None,
        })
        .collect()
}

fn remote(session_id: SessionId) -> FsTarget {
    FsTarget::Remote { session_id }
}

// -- Authentication -----------------------------------------------------------

#[tokio::test]
async fn password_auth_connects_lists_and_disconnects() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("readme.txt"), "hello").unwrap();
    let f = fixture(&server, true);
    let mut rx = f.core.subscribe_events();

    let session = connect_with_password(&f, &server).await;
    let entries = f.core.list_dir(remote(session), "/").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "readme.txt");
    assert_eq!(entries[0].path, "/readme.txt");
    assert_eq!(entries[0].size, 5);
    assert_eq!(f.core.sessions(), vec![session]);

    f.core.disconnect(session).await.unwrap();
    assert!(matches!(
        f.core.list_dir(remote(session), "/").await,
        Err(CoreError::NotConnected)
    ));
    let events = drain(&mut rx);
    assert_eq!(
        states(&events),
        vec![
            SessionState::Connecting,
            SessionState::Connected,
            // A requested disconnect carries no reason.
            SessionState::Disconnected { reason: None }
        ]
    );
}

#[tokio::test]
async fn a_connection_closed_by_the_server_is_announced_once() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, true);
    // Without reconnecting, a drop is final.
    f.core
        .save_settings(IrisSettings {
            reconnect_attempts: 0,
            ..IrisSettings::default()
        })
        .unwrap();
    let session = connect_with_password(&f, &server).await;
    let mut rx = f.core.subscribe_events();

    server.disconnect_all().await;
    let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("a disconnect event")
        .unwrap();
    assert!(
        matches!(
            &event,
            CoreEvent::SessionStateChanged {
                session_id,
                state: SessionState::Disconnected { reason: Some(_) },
                ..
            } if *session_id == session
        ),
        "{event:?}"
    );
    assert!(f.core.sessions().is_empty());
    assert!(matches!(
        f.core.list_dir(remote(session), "/").await,
        Err(CoreError::NotConnected)
    ));
    assert!(drain(&mut rx).is_empty(), "announced once");
    // The UI's disconnect then forgets the session (a Retry is no longer
    // possible), announced without a reason.
    f.core.disconnect(session).await.unwrap();
    assert_eq!(
        states(&drain(&mut rx)),
        vec![SessionState::Disconnected { reason: None }]
    );
    let err = f
        .core
        .reconnect(session, iris_core::Credentials::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotConnected), "{err:?}");
}

#[tokio::test]
async fn a_wrong_password_is_auth_failed() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, true);
    let mut rx = f.core.subscribe_events();
    let id = save_profile(&f.core, server.port, AuthMethod::Password);

    let err = f
        .core
        .connect(id, Some(Secret::new("not-the-password")), None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::AuthFailed), "{err:?}");
    let events = drain(&mut rx);
    assert_eq!(
        states(&events),
        vec![
            SessionState::Connecting,
            SessionState::Disconnected {
                reason: Some("authentication failed".into())
            }
        ]
    );
    assert!(f.core.sessions().is_empty());
}

#[tokio::test]
async fn a_missing_password_is_password_required() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, true);
    let id = save_profile(&f.core, server.port, AuthMethod::Password);
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::PasswordRequired), "{err:?}");
}

#[tokio::test]
async fn key_file_auth_without_a_passphrase() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let f = fixture(&server, true);
    let keys = tempfile::tempdir().unwrap();
    let key_path = keys.path().join("id_ed25519");
    write_key_file(&key_path, &client_key, None);

    let id = save_profile(&f.core, server.port, key_auth(&key_path));
    let session = f.core.connect(id, None, None).await.unwrap();
    assert!(f.core.list_dir(remote(session), "/").await.is_ok());
}

#[tokio::test]
async fn key_file_auth_with_a_passphrase() {
    let client_key = random_key();
    let server = TestServer::start(Some(client_key.public_key().clone())).await;
    let f = fixture(&server, true);
    let keys = tempfile::tempdir().unwrap();
    let key_path = keys.path().join("id_ed25519");
    write_key_file(&key_path, &client_key, Some("open sesame"));
    let id = save_profile(&f.core, server.port, key_auth(&key_path));

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

    let session = f
        .core
        .connect(id, None, Some(Secret::new("open sesame")))
        .await
        .unwrap();
    assert!(f.core.list_dir(remote(session), "/").await.is_ok());
}

#[tokio::test]
async fn an_unauthorized_key_is_auth_failed() {
    let server = TestServer::start(Some(random_key().public_key().clone())).await;
    let f = fixture(&server, true);
    let keys = tempfile::tempdir().unwrap();
    let key_path = keys.path().join("id_other");
    write_key_file(&key_path, &random_key(), None);
    let id = save_profile(&f.core, server.port, key_auth(&key_path));
    let err = f.core.connect(id, None, None).await.unwrap_err();
    assert!(matches!(err, CoreError::AuthFailed), "{err:?}");
}

fn key_auth(path: &Path) -> AuthMethod {
    AuthMethod::KeyFile {
        path: path.to_string_lossy().into_owned(),
    }
}

#[tokio::test]
async fn a_refused_port_is_connect_failed() {
    // Grab a free port, then close it again so nothing listens there.
    let port = {
        let l = tokio::net::TcpListener::bind((HOST, 0)).await.unwrap();
        l.local_addr().unwrap().port()
    };
    let dir = tempfile::tempdir().unwrap();
    let core = Core::new();
    core.set_known_hosts_path(dir.path().join("known_hosts"));
    let id = save_profile(&core, port, AuthMethod::Password);
    let err = core.connect(id, password(), None).await.unwrap_err();
    assert!(matches!(err, CoreError::ConnectFailed(_)), "{err:?}");
}

// -- Host keys ------------------------------------------------------------------

#[tokio::test]
async fn an_unknown_host_key_is_prompted_and_trust_is_remembered() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, false);
    let mut prompts = auto_answer(&f.core, true);

    let first = connect_with_password(&f, &server).await;
    let CoreEvent::HostKeyPrompt {
        session_id,
        host,
        port,
        key_type,
        fingerprint_sha256: fp,
        ..
    } = prompts.try_recv().expect("a prompt for the unknown key")
    else {
        unreachable!()
    };
    assert_eq!(session_id, first);
    assert_eq!(host, HOST);
    assert_eq!(port, server.port);
    assert_eq!(key_type, "ssh-ed25519");
    assert_eq!(fp, fingerprint_sha256(&server.host_public_key()));
    assert!(fp.starts_with("SHA256:"));

    // Trusting appended the `[host]:port` entry.
    let known = std::fs::read_to_string(&f.known_hosts).unwrap();
    let key = server.host_public_key().to_openssh().unwrap();
    assert!(
        known.contains(&format!("[{HOST}]:{} {key}", server.port)),
        "{known}"
    );

    // A second connect finds the key and asks nothing.
    connect_with_password(&f, &server).await;
    assert!(prompts.try_recv().is_err(), "no second prompt");
}

#[tokio::test]
async fn a_rejected_host_key_refuses_the_connection() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, false);
    let mut prompts = auto_answer(&f.core, false);
    let id = save_profile(&f.core, server.port, AuthMethod::Password);

    let err = f.core.connect(id, password(), None).await.unwrap_err();
    assert!(matches!(err, CoreError::HostKeyRejected), "{err:?}");
    assert!(prompts.try_recv().is_ok(), "the user was asked");
    let known = std::fs::read_to_string(&f.known_hosts).unwrap_or_default();
    assert!(known.trim().is_empty(), "nothing learned: {known}");
}

#[tokio::test]
async fn a_changed_host_key_is_blocked_without_a_prompt() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, false);
    // known_hosts records a different key for the same `[host]:port`.
    let other = random_key().public_key().to_openssh().unwrap();
    std::fs::write(
        &f.known_hosts,
        format!("[{HOST}]:{} {other}\n", server.port),
    )
    .unwrap();
    let mut prompts = auto_answer(&f.core, true);
    let id = save_profile(&f.core, server.port, AuthMethod::Password);

    let err = f.core.connect(id, password(), None).await.unwrap_err();
    assert!(
        matches!(&err, CoreError::HostKeyChanged { host, port } if host == HOST && *port == server.port),
        "{err:?}"
    );
    assert!(prompts.try_recv().is_err(), "never offered to trust it");
    // The file is left exactly as it was.
    assert_eq!(
        std::fs::read_to_string(&f.known_hosts).unwrap(),
        format!("[{HOST}]:{} {other}\n", server.port)
    );
}

// -- Browsing ---------------------------------------------------------------------

#[tokio::test]
async fn remote_listing_reports_links_hidden_files_and_errors() {
    let server = TestServer::start(None).await;
    let root = server.root();
    std::fs::write(root.join("notes.txt"), "some notes").unwrap();
    std::fs::write(root.join(".profile"), "").unwrap();
    std::fs::create_dir(root.join("projects")).unwrap();
    std::fs::write(root.join("projects").join("plan.md"), "# plan").unwrap();
    std::os::unix::fs::symlink("projects", root.join("work")).unwrap();
    std::os::unix::fs::symlink("notes.txt", root.join("latest")).unwrap();
    std::os::unix::fs::symlink("gone", root.join("broken")).unwrap();

    let f = fixture(&server, true);
    let session = connect_with_password(&f, &server).await;
    let target = remote(session);

    let entries = f.core.list_dir(target, "/").await.unwrap();
    let by_name = |name: &str| {
        entries
            .iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("{name} missing"))
    };
    assert_eq!(entries.len(), 6);
    assert_eq!(by_name("notes.txt").kind, EntryKind::File);
    assert_eq!(by_name("notes.txt").size, 10);
    assert!(by_name("notes.txt").mtime.is_some());
    assert_eq!(by_name("notes.txt").mode.unwrap() & 0o170_000, 0o100_000);
    assert!(by_name(".profile").hidden);
    assert!(!by_name("notes.txt").hidden);
    assert_eq!(by_name("projects").kind, EntryKind::Dir);
    assert_eq!(
        by_name("work").kind,
        EntryKind::Symlink {
            target: Some("projects".into()),
            target_kind: Some(LinkTargetKind::Dir),
        }
    );
    assert_eq!(
        by_name("latest").kind,
        EntryKind::Symlink {
            target: Some("notes.txt".into()),
            target_kind: Some(LinkTargetKind::File),
        }
    );
    assert_eq!(
        by_name("broken").kind,
        EntryKind::Symlink {
            target: Some("gone".into()),
            target_kind: None,
        }
    );

    // stat does not follow the link; the UI follows it by listing it.
    let work = f.core.stat(target, "/work").await.unwrap();
    assert_eq!(work.name, "work");
    assert!(matches!(
        work.kind,
        EntryKind::Symlink {
            target_kind: Some(LinkTargetKind::Dir),
            ..
        }
    ));
    assert_eq!(f.core.read_link(target, "/work").await.unwrap(), "projects");
    let inside = f.core.list_dir(target, "/work").await.unwrap();
    assert_eq!(inside.len(), 1);
    assert_eq!(inside[0].path, "/work/plan.md");

    assert_eq!(f.core.home_dir(target).await.unwrap(), "/");
    assert!(matches!(
        f.core.list_dir(target, "/missing").await,
        Err(CoreError::NotFound(p)) if p == "/missing"
    ));
    assert!(matches!(
        f.core.stat(target, "/missing").await,
        Err(CoreError::NotFound(_))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn ten_thousand_entries_list_in_under_two_seconds() {
    let server = TestServer::start(None).await;
    let big = server.root().join("big");
    std::fs::create_dir(&big).unwrap();
    for i in 0..10_000 {
        std::fs::write(big.join(format!("file-{i:05}.dat")), "").unwrap();
    }
    let f = fixture(&server, true);
    let session = connect_with_password(&f, &server).await;

    let started = Instant::now();
    let entries = f.core.list_dir(remote(session), "/big").await.unwrap();
    let elapsed = started.elapsed();
    eprintln!("listed 10,000 remote entries in {elapsed:?}");
    assert_eq!(entries.len(), 10_000);
    // 2 s is the budget on a dev machine. Hosted CI runners are slower and
    // run a debug build (4.2 s measured), so there only a gross regression
    // (a quadratic listing) fails.
    let budget = if std::env::var_os("CI").is_some() {
        Duration::from_secs(20)
    } else {
        Duration::from_secs(2)
    };
    assert!(
        elapsed < budget,
        "listing took {elapsed:?} (budget {budget:?})"
    );
}

// -- File operations ----------------------------------------------------------------

#[tokio::test]
async fn remote_mkdir_and_rename_never_overwrite() {
    let server = TestServer::start(None).await;
    let root = server.root();
    std::fs::write(root.join("taken.txt"), "keep me").unwrap();
    let f = fixture(&server, true);
    let target = remote(connect_with_password(&f, &server).await);

    f.core.mkdir(target, "/untitled folder").await.unwrap();
    assert!(root.join("untitled folder").is_dir());
    assert!(matches!(
        f.core.mkdir(target, "/untitled folder").await,
        Err(CoreError::AlreadyExists(p)) if p == "/untitled folder"
    ));

    f.core
        .rename(target, "/untitled folder", "/Reports")
        .await
        .unwrap();
    assert!(root.join("Reports").is_dir());
    assert!(!root.join("untitled folder").exists());

    let err = f
        .core
        .rename(target, "/Reports", "/taken.txt")
        .await
        .unwrap_err();
    assert!(
        matches!(&err, CoreError::AlreadyExists(p) if p == "/taken.txt"),
        "{err:?}"
    );
    assert_eq!(err.kind(), "alreadyExists");
    assert_eq!(
        std::fs::read_to_string(root.join("taken.txt")).unwrap(),
        "keep me"
    );
    assert!(matches!(
        f.core.rename(target, "/nope", "/x").await,
        Err(CoreError::NotFound(_))
    ));
}

#[tokio::test]
async fn remote_delete_is_recursive_and_does_not_follow_symlinks() {
    let server = TestServer::start(None).await;
    let root = server.root();
    // A tree with a link that points outside it: deleting the tree must
    // remove the link, not what it points at.
    std::fs::create_dir_all(root.join("keep")).unwrap();
    std::fs::write(root.join("keep").join("precious.txt"), "fictional").unwrap();
    std::fs::create_dir_all(root.join("tree/a/b")).unwrap();
    std::fs::write(root.join("tree/a/b/deep.txt"), "x").unwrap();
    std::fs::write(root.join("tree/top.txt"), "x").unwrap();
    std::os::unix::fs::symlink("../keep", root.join("tree/to-keep")).unwrap();
    std::os::unix::fs::symlink("nowhere", root.join("tree/broken")).unwrap();
    std::fs::write(root.join("single.txt"), "x").unwrap();
    let f = fixture(&server, true);
    let target = remote(connect_with_password(&f, &server).await);

    let report = f
        .core
        .delete(
            target,
            &["/tree".into(), "/missing".into(), "/single.txt".into()],
        )
        .await
        .unwrap();
    assert_eq!(report.succeeded, vec!["/tree", "/single.txt"]);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(report.failed[0].path, "/missing");
    assert_eq!(report.failed[0].kind, "notFound");

    assert!(!root.join("tree").exists());
    assert!(!root.join("single.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("keep/precious.txt")).unwrap(),
        "fictional"
    );

    // A symlink to a folder is removed as a link.
    std::os::unix::fs::symlink("keep", root.join("shortcut")).unwrap();
    let report = f.core.delete(target, &["/shortcut".into()]).await.unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    assert!(std::fs::symlink_metadata(root.join("shortcut")).is_err());
    assert!(root.join("keep/precious.txt").exists());

    // The root itself is refused.
    let report = f.core.delete(target, &["/".into()]).await.unwrap();
    assert_eq!(report.failed[0].kind, "invalidInput");
    assert!(root.join("keep").exists());
}

#[tokio::test]
async fn remote_chmod_sets_modes_recursively_skipping_links() {
    use std::os::unix::fs::PermissionsExt;
    let server = TestServer::start(None).await;
    let root = server.root().to_path_buf();
    let mode_of = |p: &str| {
        std::fs::symlink_metadata(root.join(p))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777
    };
    std::fs::write(root.join("outside.txt"), "x").unwrap();
    std::fs::set_permissions(root.join("outside.txt"), PermissionsExt::from_mode(0o600)).unwrap();
    std::fs::create_dir_all(root.join("site/assets")).unwrap();
    std::fs::write(root.join("site/assets/app.js"), "x").unwrap();
    std::fs::write(root.join("site/index.html"), "x").unwrap();
    std::os::unix::fs::symlink("../outside.txt", root.join("site/link")).unwrap();
    let f = fixture(&server, true);
    let target = remote(connect_with_password(&f, &server).await);

    let report = f
        .core
        .chmod(target, &["/site/index.html".into()], 0o640, false)
        .await
        .unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    assert_eq!(mode_of("site/index.html"), 0o640);

    let report = f
        .core
        .chmod(target, &["/site".into()], 0o750, true)
        .await
        .unwrap();
    assert!(report.failed.is_empty(), "{report:?}");
    for p in [
        "site",
        "site/assets",
        "site/assets/app.js",
        "site/index.html",
    ] {
        assert_eq!(mode_of(p), 0o750, "{p}");
    }
    assert_eq!(mode_of("outside.txt"), 0o600, "the link was not followed");

    // The entry reports the new mode.
    let entry = f.core.stat(target, "/site/index.html").await.unwrap();
    assert_eq!(entry.mode.unwrap() & 0o7777, 0o750);
}

#[tokio::test]
async fn remote_preview_reads_and_truncates() {
    let server = TestServer::start(None).await;
    let root = server.root();
    let text = "line one\nline two\n".repeat(1000);
    std::fs::write(root.join("log.txt"), &text).unwrap();
    std::fs::write(root.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
    std::fs::create_dir(root.join("dir")).unwrap();
    let f = fixture(&server, true);
    let target = remote(connect_with_password(&f, &server).await);

    let whole = f.core.preview(target, "/log.txt", 1 << 20).await.unwrap();
    assert_eq!(
        whole,
        Preview::Text {
            text: text.clone(),
            truncated: false,
            total_size: text.len() as u64,
        }
    );

    let head = f.core.preview(target, "/log.txt", 100).await.unwrap();
    assert_eq!(
        head,
        Preview::Text {
            text: text[..100].to_string(),
            truncated: true,
            total_size: text.len() as u64,
        }
    );

    assert_eq!(
        f.core.preview(target, "/blob.bin", 1024).await.unwrap(),
        Preview::Binary { total_size: 4 }
    );
    assert!(matches!(
        f.core.preview(target, "/dir", 1024).await,
        Err(CoreError::InvalidInput(_))
    ));
    assert!(matches!(
        f.core.preview(target, "/missing.txt", 1024).await,
        Err(CoreError::NotFound(_))
    ));
}
