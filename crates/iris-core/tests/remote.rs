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
    AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, EntryKind, FsTarget, LinkTargetKind,
    ProfileId, Secret, SessionId, SessionState,
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
            CoreEvent::SessionStateChanged { state, .. } => Some(*state),
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
            SessionState::Disconnected
        ]
    );
    // A requested disconnect carries no reason.
    assert!(matches!(
        events.last(),
        Some(CoreEvent::SessionStateChanged { reason: None, .. })
    ));
}

#[tokio::test]
async fn a_connection_closed_by_the_server_is_announced_once() {
    let server = TestServer::start(None).await;
    let f = fixture(&server, true);
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
                state: SessionState::Disconnected,
                reason: Some(_),
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
    // A late disconnect from the UI is a quiet no-op.
    f.core.disconnect(session).await.unwrap();
    assert!(drain(&mut rx).is_empty());
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
        vec![SessionState::Connecting, SessionState::Disconnected]
    );
    assert!(matches!(
        events.last(),
        Some(CoreEvent::SessionStateChanged { reason: Some(r), .. }) if r == "authentication failed"
    ));
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
    assert!(elapsed < Duration::from_secs(2), "listing took {elapsed:?}");
}
