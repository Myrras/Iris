//! Integration tests for keeping a session alive across dropped
//! connections: automatic reconnects (same session id, paused transfers
//! resumed), giving up, the manual reconnect, and the transfer calls around
//! it (retry, cancel on disconnect and quit). Against the hermetic
//! in-process server in `support/`; all data is fictitious.

#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iris_core::{
    AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, Credentials, FsTarget, IrisSettings,
    ProfileId, Secret, SecretKind, SessionId, SessionState, TransferDirection, TransferItem,
    TransferList, TransferRequest, TransferState,
};
use tempfile::TempDir;

use support::{random_key, TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    core: Arc<Core>,
    profile: ProfileId,
    known_hosts: std::path::PathBuf,
    local: TempDir,
    states: StateLog,
    _dir: TempDir,
}

impl Fixture {
    /// A core that trusts `server`, retries `attempts` times with a 10 ms
    /// backoff step, and has a password profile for it (remembered when
    /// `remember`).
    fn new(server: &TestServer, attempts: u32, remember: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        std::fs::write(&known_hosts, server.known_hosts_line()).unwrap();
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts.clone());
        core.set_reconnect_backoff_unit(Duration::from_millis(10));
        core.save_settings(IrisSettings {
            reconnect_attempts: attempts,
            ..IrisSettings::default()
        })
        .unwrap();
        let profile = core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: "Reconnect test".into(),
                host: HOST.into(),
                port: server.port,
                user: USER.into(),
                auth: AuthMethod::Password,
                start_dir: None,
                jump: None,
            })
            .unwrap()
            .id;
        if remember {
            core.set_secret(profile, SecretKind::Password, Secret::new(PASSWORD))
                .unwrap();
        }
        let states = StateLog::start(&core);
        Self {
            core,
            profile,
            known_hosts,
            local: tempfile::tempdir().unwrap(),
            states,
            _dir: dir,
        }
    }

    async fn connect(&self) -> SessionId {
        self.core
            .connect(self.profile, Some(Secret::new(PASSWORD)), None)
            .await
            .unwrap()
    }

    fn local_dir(&self) -> String {
        self.local.path().to_string_lossy().into_owned()
    }

    fn download(&self, session_id: SessionId, src: &str, dst_dir: &str) {
        self.core
            .enqueue_transfers(TransferRequest {
                session_id,
                direction: TransferDirection::Download,
                items: vec![TransferItem { src: src.into() }],
                dst_dir: dst_dir.into(),
            })
            .unwrap();
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&TransferList) -> bool) -> TransferList {
        let deadline = Instant::now() + WAIT;
        loop {
            let list = self.core.list_transfers();
            if done(&list) {
                return list;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {list:#?}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn wait_idle(&self) -> TransferList {
        self.wait_until("the transfers to settle", |_| {
            !self.core.has_active_transfers()
        })
        .await
    }
}

/// The session states the core announced, in order.
struct StateLog(Arc<Mutex<Vec<(SessionId, SessionState)>>>);

impl StateLog {
    fn start(core: &Core) -> Self {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut rx = core.subscribe_events();
        let sink = Arc::clone(&log);
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if let CoreEvent::SessionStateChanged {
                    session_id, state, ..
                } = event
                {
                    sink.lock().unwrap().push((session_id, state));
                }
            }
        });
        Self(log)
    }

    fn of(&self, session: SessionId) -> Vec<SessionState> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| *id == session)
            .map(|(_, s)| s.clone())
            .collect()
    }

    /// Wait until `session` reaches a state `done` accepts; returns it.
    async fn wait_for(
        &self,
        session: SessionId,
        what: &str,
        done: impl Fn(&SessionState) -> bool,
    ) -> SessionState {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(state) = self.of(session).into_iter().rev().find(|s| done(s)) {
                return state;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {:#?}",
                self.of(session)
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Wait for `session`'s connect to be logged (events arrive on another
    /// task), then forget everything so far.
    async fn clear_after_connect(&self, session: SessionId) {
        self.wait_for(session, "the connect", |s| *s == SessionState::Connected)
            .await;
        self.0.lock().unwrap().clear();
    }

    /// Forget everything logged so far.
    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

fn is_disconnected(state: &SessionState) -> bool {
    matches!(state, SessionState::Disconnected { .. })
}

fn reason(state: &SessionState) -> String {
    match state {
        SessionState::Disconnected { reason } => reason.clone().unwrap_or_default(),
        other => panic!("not disconnected: {other:?}"),
    }
}

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

fn remote(session_id: SessionId) -> FsTarget {
    FsTarget::Remote { session_id }
}

#[tokio::test]
async fn a_dropped_connection_reconnects_and_the_download_finishes_on_the_same_session() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 5, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    let content = data(4 * 1024 * 1024, 7);
    std::fs::write(server.root().join("archive.bin"), &content).unwrap();
    server.set_io_delay(Duration::from_millis(5));

    f.download(session, "/archive.bin", &f.local_dir());
    let list = f
        .wait_until("progress", |l| {
            l.jobs.first().is_some_and(|j| j.bytes_done > 0)
        })
        .await;
    let job = list.jobs[0].id;
    f.states.clear_after_connect(session).await;
    server.kill_all();
    server.set_io_delay(Duration::ZERO);

    f.states
        .wait_for(session, "the reconnect", |s| *s == SessionState::Connected)
        .await;
    let states = f.states.of(session);
    assert_eq!(
        states[0],
        SessionState::Reconnecting {
            attempt: 1,
            max_attempts: 5,
            next_retry_in_secs: 1,
        },
        "{states:#?}"
    );
    assert!(
        !states.iter().any(is_disconnected),
        "never down: {states:#?}"
    );
    assert_eq!(f.core.sessions(), vec![session], "the same session id");

    let list = f
        .wait_until("the resumed download", |l| {
            l.jobs
                .iter()
                .any(|j| j.id == job && j.state == TransferState::Done)
        })
        .await;
    assert_eq!(list.jobs[0].session_id, session);
    assert_eq!(
        std::fs::read(f.local.path().join("archive.bin")).unwrap(),
        content
    );
    // Browsing works again on the same id.
    f.core.list_dir(remote(session), "/").await.unwrap();
}

#[tokio::test]
async fn a_server_that_closes_the_connection_is_reconnected_too() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 3, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.states.clear_after_connect(session).await;

    server.disconnect_all().await;
    f.states
        .wait_for(session, "the reconnect", |s| *s == SessionState::Connected)
        .await;
    f.core.list_dir(remote(session), "/").await.unwrap();
}

#[tokio::test]
async fn reconnecting_gives_up_after_the_set_attempts_and_retry_brings_it_back() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 3, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.states.clear_after_connect(session).await;

    server.set_refusing(true);
    server.kill_all();
    let down = f
        .states
        .wait_for(session, "giving up", is_disconnected)
        .await;
    assert!(
        reason(&down).starts_with("could not reconnect after 3 attempts"),
        "{down:?}"
    );
    let reconnecting: Vec<(u32, u64)> = f
        .states
        .of(session)
        .into_iter()
        .filter_map(|s| match s {
            SessionState::Reconnecting {
                attempt,
                max_attempts: 3,
                next_retry_in_secs,
            } => Some((attempt, next_retry_in_secs)),
            _ => None,
        })
        .collect();
    assert_eq!(
        reconnecting,
        vec![(1, 1), (1, 0), (2, 2), (2, 0), (3, 4), (3, 0)],
        "each attempt announces its wait, then that it runs"
    );
    assert!(f.core.sessions().is_empty());
    assert!(matches!(
        f.core.list_dir(remote(session), "/").await,
        Err(CoreError::NotConnected)
    ));

    // The server is back: Retry revives the same session id.
    server.set_refusing(false);
    f.states.clear();
    f.core
        .reconnect(session, Credentials::default())
        .await
        .unwrap();
    f.states
        .wait_for(session, "the reconnect", |s| *s == SessionState::Connected)
        .await;
    assert_eq!(
        f.states.of(session),
        vec![SessionState::Connecting, SessionState::Connected]
    );
    assert_eq!(f.core.sessions(), vec![session]);
    f.core.list_dir(remote(session), "/").await.unwrap();
}

#[tokio::test]
async fn a_user_disconnect_does_not_reconnect() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 5, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.states.clear_after_connect(session).await;

    f.core.disconnect(session).await.unwrap();
    // Longer than the first backoff step (10 ms here).
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        f.states.of(session),
        vec![SessionState::Disconnected { reason: None }]
    );
    assert!(f.core.sessions().is_empty());
    let err = f
        .core
        .reconnect(session, Credentials::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotConnected), "{err:?}");
}

#[tokio::test]
async fn a_reconnect_that_needs_a_password_stops_and_retry_takes_one() {
    let server = TestServer::start(None).await;
    // The password is typed, not remembered: a reconnect has none.
    let f = Fixture::new(&server, 5, false);
    let session = f.connect().await;
    f.states.clear_after_connect(session).await;

    server.kill_all();
    let down = f
        .states
        .wait_for(session, "giving up", is_disconnected)
        .await;
    assert!(reason(&down).contains("password"), "{down:?}");
    let attempts = f
        .states
        .of(session)
        .iter()
        .filter(|s| {
            matches!(
                s,
                SessionState::Reconnecting {
                    next_retry_in_secs: 0,
                    ..
                }
            )
        })
        .count();
    assert_eq!(attempts, 1, "no point in trying again without a password");

    // Retry without a password asks for one; with it, the session is back.
    let err = f
        .core
        .reconnect(session, Credentials::default())
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::PasswordRequired), "{err:?}");
    f.core
        .reconnect(
            session,
            Credentials {
                password: Some(Secret::new(PASSWORD)),
                ..Credentials::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(f.core.sessions(), vec![session]);
}

#[tokio::test]
async fn a_changed_host_key_stops_reconnecting() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 5, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.states.clear_after_connect(session).await;

    // known_hosts now records another key for the server.
    let other = random_key();
    let name = format!("[{HOST}]:{}", server.port);
    std::fs::write(
        &f.known_hosts,
        format!("{name} {}\n", other.public_key().to_openssh().unwrap()),
    )
    .unwrap();
    server.kill_all();
    let down = f
        .states
        .wait_for(session, "giving up", is_disconnected)
        .await;
    assert!(reason(&down).contains("host key"), "{down:?}");
}

fn is_waiting_for(attempt: u32) -> impl Fn(&SessionState) -> bool {
    move |s| {
        matches!(s, SessionState::Reconnecting { attempt: a, next_retry_in_secs, .. }
            if *a == attempt && *next_retry_in_secs > 0)
    }
}

#[tokio::test]
async fn a_failed_retry_now_goes_back_to_the_remaining_automatic_attempts() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 4, true);
    // Long enough waits to press "Retry now" during one.
    f.core
        .set_reconnect_backoff_unit(Duration::from_millis(200));
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.states.clear_after_connect(session).await;

    server.set_refusing(true);
    server.kill_all();
    f.states
        .wait_for(session, "the wait for attempt 2", is_waiting_for(2))
        .await;
    f.states.clear();
    let err = f
        .core
        .reconnect(session, Credentials::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "connectFailed", "{err:?}");

    // The manual try took attempt 2's place; attempt 3 of 4 is next.
    f.states
        .wait_for(session, "attempt 3", is_waiting_for(3))
        .await;
    let states = f.states.of(session);
    assert_eq!(states[0], SessionState::Connecting, "{states:#?}");
    assert_eq!(
        states[1],
        SessionState::Reconnecting {
            attempt: 3,
            max_attempts: 4,
            next_retry_in_secs: 4,
        },
        "{states:#?}"
    );
    assert!(!states.iter().any(is_disconnected), "{states:#?}");

    // The loop carries on as before and gets through once it can.
    server.set_refusing(false);
    f.states
        .wait_for(session, "the reconnect", |s| *s == SessionState::Connected)
        .await;
    assert_eq!(f.core.sessions(), vec![session]);
}

#[tokio::test]
async fn a_failed_retry_now_on_the_last_attempt_gives_up() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 2, true);
    f.core
        .set_reconnect_backoff_unit(Duration::from_millis(200));
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.states.clear_after_connect(session).await;

    server.set_refusing(true);
    server.kill_all();
    f.states
        .wait_for(session, "the wait for attempt 2", is_waiting_for(2))
        .await;
    f.states.clear();
    f.core
        .reconnect(session, Credentials::default())
        .await
        .unwrap_err();
    let down = f
        .states
        .wait_for(session, "giving up", is_disconnected)
        .await;
    assert!(
        reason(&down).starts_with("could not reconnect after 2 attempts"),
        "{down:?}"
    );
    assert!(
        !f.states
            .of(session)
            .iter()
            .any(|s| matches!(s, SessionState::Reconnecting { .. })),
        "no attempts were left"
    );
}

#[tokio::test]
async fn a_folder_walk_cut_off_by_a_drop_continues_after_a_reconnect() {
    let server = TestServer::start(None).await;
    // No automatic reconnect: the cut-off state can be looked at first.
    let f = Fixture::new(&server, 0, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    let mut files = Vec::new();
    for dir in ["photos", "photos/2024", "photos/2024/summer", "photos/2025"] {
        std::fs::create_dir_all(server.root().join(dir)).unwrap();
        for i in 0..2 {
            let name = format!("{dir}/img-{i}.jpg");
            let content = data(20_000 + i * 1000, name.len() as u64);
            std::fs::write(server.root().join(&name), &content).unwrap();
            files.push((name, content));
        }
    }
    server.set_list_delay(Duration::from_millis(300));

    f.download(session, "/photos", &f.local_dir());
    // The first folder is listed (its files are queued), the next listing
    // is under way when the connection dies.
    f.wait_until("the first files", |l| !l.jobs.is_empty())
        .await;
    server.kill_all();
    server.set_list_delay(Duration::ZERO);
    f.states
        .wait_for(session, "the drop", is_disconnected)
        .await;

    let list = f
        .wait_until("the walk to stop", |l| {
            l.jobs.iter().all(|j| j.state != TransferState::Running)
                && l.jobs.iter().any(|j| j.folder)
        })
        .await;
    let placeholders: Vec<_> = list.jobs.iter().filter(|j| j.folder).collect();
    assert!(
        placeholders
            .iter()
            .all(|j| j.state == TransferState::Paused),
        "{list:#?}"
    );
    assert!(
        list.jobs.iter().all(|j| j.state != TransferState::Failed),
        "nothing failed: {list:#?}"
    );
    assert!(f.core.has_active_transfers(), "placeholders are work");

    f.core
        .reconnect(session, Credentials::default())
        .await
        .unwrap();
    let list = f.wait_idle().await;
    assert!(
        list.jobs
            .iter()
            .all(|j| j.state == TransferState::Done && !j.folder),
        "{list:#?}"
    );
    assert_eq!(list.jobs.len(), files.len());
    for (name, content) in &files {
        assert_eq!(
            &std::fs::read(f.local.path().join(name)).unwrap(),
            content,
            "{name}"
        );
    }
}

#[tokio::test]
async fn a_failed_download_can_be_retried() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 0, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    let content = data(300_000, 3);
    std::fs::write(server.root().join("report.pdf"), &content).unwrap();
    // A destination Iris may not write into.
    let dst = f.local.path().join("locked");
    std::fs::create_dir(&dst).unwrap();
    std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o555)).unwrap();

    f.download(session, "/report.pdf", &dst.to_string_lossy());
    let list = f.wait_idle().await;
    let job = list.jobs[0].clone();
    assert_eq!(job.state, TransferState::Failed, "{job:?}");
    assert!(!job.folder);
    assert!(!f.core.has_active_work());

    std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.core.retry_transfer(job.id).unwrap();
    let list = f.wait_idle().await;
    assert_eq!(list.jobs.len(), 1);
    assert_eq!(list.jobs[0].state, TransferState::Done, "{list:#?}");
    assert!(list.jobs[0].error.is_none());
    assert_eq!(std::fs::read(dst.join("report.pdf")).unwrap(), content);

    // Only failed jobs can be retried.
    let err = f.core.retry_transfer(job.id).unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
    let err = f
        .core
        .retry_transfer(iris_core::TransferId::new())
        .unwrap_err();
    assert_eq!(err.kind(), "notFound");
}

#[tokio::test]
async fn a_selected_item_that_was_missing_is_walked_again_on_retry() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 0, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();

    f.download(session, "/later", &f.local_dir());
    let list = f.wait_idle().await;
    let job = list.jobs[0].clone();
    assert_eq!(job.state, TransferState::Failed, "{job:?}");
    assert!(job.folder, "a placeholder for the selected item");

    // It turns up as a folder; the retry lists it.
    std::fs::create_dir(server.root().join("later")).unwrap();
    std::fs::write(server.root().join("later/notes.txt"), "fictitious").unwrap();
    f.core.retry_transfer(job.id).unwrap();
    let list = f.wait_idle().await;
    assert_eq!(list.jobs.len(), 1, "{list:#?}");
    assert_eq!(list.jobs[0].state, TransferState::Done);
    assert_eq!(
        std::fs::read_to_string(f.local.path().join("later/notes.txt")).unwrap(),
        "fictitious"
    );
}

#[tokio::test]
async fn retrying_needs_a_connected_session() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 0, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    f.download(session, "/missing.txt", &f.local_dir());
    let job = f.wait_idle().await.jobs[0].clone();
    assert_eq!(job.state, TransferState::Failed);

    server.kill_all();
    f.states
        .wait_for(session, "the drop", is_disconnected)
        .await;
    let err = f.core.retry_transfer(job.id).unwrap_err();
    assert_eq!(err.kind(), "notConnected");
}

#[tokio::test]
async fn disconnecting_cancels_the_sessions_transfers() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 5, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    std::fs::write(server.root().join("big.iso"), data(2 * 1024 * 1024, 9)).unwrap();
    server.set_io_delay(Duration::from_millis(5));
    f.download(session, "/big.iso", &f.local_dir());
    f.wait_until("progress", |l| {
        l.jobs.first().is_some_and(|j| j.bytes_done > 0)
    })
    .await;

    f.core.disconnect(session).await.unwrap();
    let list = f.wait_idle().await;
    assert_eq!(list.jobs[0].state, TransferState::Cancelled, "{list:#?}");
    assert!(!f.core.has_active_work());
}

#[tokio::test]
async fn confirming_quit_cancels_all_work() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 5, true);
    let session = f.core.connect(f.profile, None, None).await.unwrap();
    for name in ["a.bin", "b.bin", "c.bin"] {
        std::fs::write(server.root().join(name), data(1024 * 1024, 5)).unwrap();
    }
    server.set_io_delay(Duration::from_millis(5));
    f.core
        .save_settings(IrisSettings {
            parallel_transfers: 1,
            ..f.core.settings()
        })
        .unwrap();
    for name in ["/a.bin", "/b.bin", "/c.bin"] {
        f.download(session, name, &f.local_dir());
    }
    f.wait_until("one running, the rest queued", |l| {
        l.jobs.len() == 3 && l.jobs.iter().any(|j| j.state == TransferState::Running)
    })
    .await;
    assert!(f.core.has_active_work(), "the close guard would warn");

    f.core.cancel_all_transfers();
    let list = f.wait_idle().await;
    assert!(
        list.jobs
            .iter()
            .all(|j| j.state == TransferState::Cancelled),
        "{list:#?}"
    );
    assert!(!f.core.has_active_work(), "nothing holds the quit back");
}
