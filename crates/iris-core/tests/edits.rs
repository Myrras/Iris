//! Integration tests for remote edit (open a remote file in a local editor,
//! upload each save, conflicts, deferred uploads, cleanup), against the
//! hermetic in-process SFTP server in `support/`, a fake opener and a temp
//! cache dir. The watcher is real (debounced to 50 ms here), so saves are
//! real file writes. All data is fictitious.

#![cfg(unix)]

mod support;

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use iris_core::{
    AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, CoreResult, EditId, EditInfo,
    EditResolution, EditStatus, IrisSettings, Opener, ProfileId, RemoteStamp, Secret, SecretKind,
    SessionId, SessionState,
};
use tempfile::TempDir;

use support::{TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(20);
const EDITOR_APP: &str = "/Applications/Fictional Editor.app";

/// Records what it was asked to open instead of opening anything.
#[derive(Default)]
struct FakeOpener {
    opened: Mutex<Vec<(PathBuf, Option<String>)>>,
    fail: Mutex<bool>,
}

impl Opener for FakeOpener {
    fn open(&self, path: &Path, app: Option<&str>) -> CoreResult<()> {
        if *self.fail.lock().unwrap() {
            return Err(CoreError::InvalidInput("no such application".into()));
        }
        self.opened
            .lock()
            .unwrap()
            .push((path.to_path_buf(), app.map(str::to_string)));
        Ok(())
    }

    fn reveal(&self, _path: &Path) -> CoreResult<()> {
        Ok(())
    }
}

struct Fixture {
    core: Arc<Core>,
    opener: Arc<FakeOpener>,
    cache: TempDir,
    profile: ProfileId,
    events: EventLog,
    _dir: TempDir,
}

impl Fixture {
    /// A core that trusts `server`, with a remembered password, a fake
    /// opener, a temp cache dir and `reconnect_attempts` retries every
    /// `backoff` step.
    fn new(server: &TestServer, reconnect_attempts: u32, backoff: Duration) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        std::fs::write(&known_hosts, server.known_hosts_line()).unwrap();
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts);
        core.set_reconnect_backoff_unit(backoff);
        core.set_edit_debounce(Duration::from_millis(50));
        let cache = tempfile::tempdir().unwrap();
        core.set_cache_dir(cache.path().to_path_buf());
        let opener = Arc::new(FakeOpener::default());
        core.set_opener(opener.clone());
        core.save_settings(IrisSettings {
            reconnect_attempts,
            editor_overrides: BTreeMap::from([("md".to_string(), EDITOR_APP.to_string())]),
            ..IrisSettings::default()
        })
        .unwrap();
        let profile = core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: "Edit test".into(),
                host: HOST.into(),
                port: server.port,
                user: USER.into(),
                auth: AuthMethod::Password,
                start_dir: None,
                jump: None,
            })
            .unwrap()
            .id;
        core.set_secret(profile, SecretKind::Password, Secret::new(PASSWORD))
            .unwrap();
        let events = EventLog::start(&core);
        Self {
            core,
            opener,
            cache,
            profile,
            events,
            _dir: dir,
        }
    }

    async fn connect(&self) -> SessionId {
        self.core.connect(self.profile, None, None).await.unwrap()
    }

    fn edit(&self, id: EditId) -> EditInfo {
        self.core
            .list_edits()
            .into_iter()
            .find(|e| e.id == id)
            .expect("the edit is open")
    }

    fn local(&self, id: EditId) -> PathBuf {
        PathBuf::from(self.edit(id).local_path)
    }

    /// Wait until the edit's status is `status`.
    async fn wait_status(&self, id: EditId, status: EditStatus) {
        let deadline = Instant::now() + WAIT;
        while self.edit(id).status != status {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {status:?}: {:?}",
                self.edit(id)
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

/// Every core event, in order.
struct EventLog(Arc<Mutex<Vec<CoreEvent>>>);

impl EventLog {
    fn start(core: &Core) -> Self {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut rx = core.subscribe_events();
        let sink = Arc::clone(&log);
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                sink.lock().unwrap().push(event);
            }
        });
        Self(log)
    }

    /// Wait for an event `pick` accepts, and forget it (and everything
    /// before it), so the next wait sees only newer events.
    async fn take<T>(&self, what: &str, pick: impl Fn(&CoreEvent) -> Option<T>) -> T {
        let deadline = Instant::now() + WAIT;
        loop {
            {
                let mut log = self.0.lock().unwrap();
                if let Some(at) = log.iter().position(|e| pick(e).is_some()) {
                    let found = pick(&log[at]).unwrap();
                    log.drain(..=at);
                    return found;
                }
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {:#?}",
                self.0.lock().unwrap()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn uploaded(&self, id: EditId) -> String {
        self.take("the upload", |e| match e {
            CoreEvent::EditUploaded { edit_id, path, .. } if *edit_id == id => Some(path.clone()),
            _ => None,
        })
        .await
    }

    async fn conflict(&self, id: EditId) -> (Option<RemoteStamp>, RemoteStamp) {
        self.take("the conflict", |e| match e {
            CoreEvent::EditConflict {
                edit_id,
                remote,
                baseline,
                ..
            } if *edit_id == id => Some((*remote, *baseline)),
            _ => None,
        })
        .await
    }

    fn edit_events(&self) -> Vec<CoreEvent> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    CoreEvent::EditUploaded { .. }
                        | CoreEvent::EditConflict { .. }
                        | CoreEvent::EditFailed { .. }
                )
            })
            .cloned()
            .collect()
    }
}

/// A save as an editor does it in place.
fn save(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

#[tokio::test]
async fn opening_downloads_the_file_and_opens_it_with_the_editor_for_its_extension() {
    let server = TestServer::start(None).await;
    std::fs::create_dir(server.root().join("docs")).unwrap();
    std::fs::write(server.root().join("docs/Guide.MD"), "# Fictional guide\n").unwrap();
    std::fs::write(server.root().join("notes.txt"), "remember the milk\n").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;

    let md = f.core.open_remote(session, "/docs/Guide.MD").await.unwrap();
    let txt = f.core.open_remote(session, "/notes.txt").await.unwrap();

    let opened = f.opener.opened.lock().unwrap().clone();
    assert_eq!(
        opened,
        vec![
            (f.local(md), Some(EDITOR_APP.to_string())),
            (f.local(txt), None),
        ],
        "the md override (case-insensitive), the OS default otherwise"
    );
    let local = f.local(md);
    assert_eq!(
        std::fs::read_to_string(&local).unwrap(),
        "# Fictional guide\n"
    );
    assert_eq!(local.file_name().unwrap(), "Guide.MD");
    assert!(local.starts_with(f.cache.path().canonicalize().unwrap().join("edit")));
    let info = f.edit(md);
    assert_eq!(info.path, "/docs/Guide.MD");
    assert_eq!(info.status, EditStatus::Synced);
    assert_eq!(info.baseline.size, 18);
    assert!(info.baseline.mtime.is_some());
    assert!(!f.core.has_active_work(), "open files alone are no work");

    // Opening it again shows the same edit, without downloading again.
    save(&local, "local, unsaved to the server");
    let again = f.core.open_remote(session, "/docs/Guide.MD").await.unwrap();
    assert_eq!(again, md);
    assert_eq!(f.opener.opened.lock().unwrap().len(), 3);
    assert_eq!(
        std::fs::read_to_string(&local).unwrap(),
        "local, unsaved to the server"
    );
}

#[tokio::test]
async fn opening_needs_a_file_a_session_and_a_cache_dir() {
    let server = TestServer::start(None).await;
    std::fs::create_dir(server.root().join("docs")).unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;

    let err = f.core.open_remote(session, "/docs").await.unwrap_err();
    assert_eq!(err.kind(), "invalidInput", "{err:?}");
    let err = f
        .core
        .open_remote(session, "/missing.txt")
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "notFound", "{err:?}");
    let err = f
        .core
        .open_remote(SessionId::new(), "/notes.txt")
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "notConnected", "{err:?}");
    assert!(f.core.list_edits().is_empty());

    let bare = Core::new();
    let err = bare
        .open_remote(SessionId::new(), "/notes.txt")
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "config", "{err:?}");
}

#[tokio::test]
async fn an_editor_that_fails_to_open_closes_the_edit_again() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("notes.txt"), "x").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    *f.opener.fail.lock().unwrap() = true;

    let err = f.core.open_remote(session, "/notes.txt").await.unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
    assert!(f.core.list_edits().is_empty());
    assert!(!f
        .cache
        .path()
        .join("edit")
        .join(session.to_string())
        .exists());
}

#[tokio::test]
async fn a_save_is_uploaded_and_becomes_the_new_baseline() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("notes.txt"), "first draft\n").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/notes.txt").await.unwrap();
    let local = f.local(id);

    save(&local, "second draft, a little longer\n");
    assert_eq!(f.events.uploaded(id).await, "/notes.txt");
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "second draft, a little longer\n"
    );
    let info = f.edit(id);
    assert_eq!(info.status, EditStatus::Synced);
    assert_eq!(info.baseline.size, 30);

    // The new baseline holds: the next save uploads without a conflict.
    save(&local, "third\n");
    f.events.uploaded(id).await;
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "third\n"
    );
    assert!(
        !f.events
            .edit_events()
            .iter()
            .any(|e| matches!(e, CoreEvent::EditConflict { .. })),
        "{:#?}",
        f.events.edit_events()
    );
}

#[tokio::test]
async fn a_save_through_a_temp_file_and_rename_is_detected() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("config.yml"), "debug: false\n").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/config.yml").await.unwrap();
    let local = f.local(id);

    // What many editors do: write a sibling temp file, rename it over.
    let temp = local.with_file_name(".config.yml.swp-tmp");
    std::fs::write(&temp, "debug: true\nverbose: true\n").unwrap();
    std::fs::rename(&temp, &local).unwrap();

    f.events.uploaded(id).await;
    assert_eq!(
        std::fs::read_to_string(server.root().join("config.yml")).unwrap(),
        "debug: true\nverbose: true\n"
    );
    // Twice: the watch survives the file being replaced.
    std::fs::write(&temp, "debug: true\n").unwrap();
    std::fs::rename(&temp, &local).unwrap();
    f.events.uploaded(id).await;
    assert_eq!(
        std::fs::read_to_string(server.root().join("config.yml")).unwrap(),
        "debug: true\n"
    );
}

/// Open `/notes.txt`, change it on the server, save locally: a conflict.
async fn conflicted(f: &Fixture, server: &TestServer) -> (SessionId, EditId) {
    std::fs::write(server.root().join("notes.txt"), "original\n").unwrap();
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/notes.txt").await.unwrap();
    let baseline = f.edit(id).baseline;

    std::fs::write(server.root().join("notes.txt"), "changed by a colleague\n").unwrap();
    save(&f.local(id), "my local change\n");
    let (remote, was) = f.events.conflict(id).await;
    assert_eq!(was, baseline);
    assert_eq!(remote.map(|r| r.size), Some(23));
    assert_eq!(f.edit(id).status, EditStatus::Conflict);
    assert!(
        f.core.has_active_work(),
        "an unanswered conflict holds work"
    );
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "changed by a colleague\n",
        "nothing is uploaded before the answer"
    );
    (session, id)
}

#[tokio::test]
async fn a_conflict_answered_with_overwrite_uploads_anyway() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let (_, id) = conflicted(&f, &server).await;

    f.core.resolve_edit(id, EditResolution::Overwrite).unwrap();
    assert_eq!(f.events.uploaded(id).await, "/notes.txt");
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "my local change\n"
    );
    assert_eq!(f.edit(id).status, EditStatus::Synced);
    assert!(!f.core.has_active_work());
}

#[tokio::test]
async fn a_conflict_answered_with_discard_reloads_the_server_copy() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let (_, id) = conflicted(&f, &server).await;
    let local = f.local(id);

    f.core.resolve_edit(id, EditResolution::Discard).unwrap();
    f.wait_status(id, EditStatus::Synced).await;
    assert_eq!(
        std::fs::read_to_string(&local).unwrap(),
        "changed by a colleague\n"
    );
    assert_eq!(f.edit(id).baseline.size, 23);

    // Re-baselined: the next save goes straight up.
    save(&local, "on top of the colleague's version\n");
    f.events.uploaded(id).await;
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "on top of the colleague's version\n"
    );
}

#[tokio::test]
async fn a_conflict_answered_with_save_copy_uploads_next_to_the_original() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("notes (edited).txt"), "an older copy\n").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let (_, id) = conflicted(&f, &server).await;

    f.core.resolve_edit(id, EditResolution::SaveCopy).unwrap();
    assert_eq!(f.events.uploaded(id).await, "/notes (edited 2).txt");
    let read = |name: &str| std::fs::read_to_string(server.root().join(name)).unwrap();
    assert_eq!(read("notes (edited 2).txt"), "my local change\n");
    assert_eq!(read("notes.txt"), "changed by a colleague\n");
    assert_eq!(read("notes (edited).txt"), "an older copy\n");
    assert_eq!(f.edit(id).path, "/notes (edited 2).txt");

    // The edit follows the copy from now on.
    save(&f.local(id), "more local changes\n");
    assert_eq!(f.events.uploaded(id).await, "/notes (edited 2).txt");
    assert_eq!(read("notes (edited 2).txt"), "more local changes\n");
    assert_eq!(read("notes.txt"), "changed by a colleague\n");
}

#[tokio::test]
async fn a_deleted_server_copy_is_a_conflict_too() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("notes.txt"), "original\n").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/notes.txt").await.unwrap();

    std::fs::remove_file(server.root().join("notes.txt")).unwrap();
    save(&f.local(id), "still mine\n");
    let (remote, _) = f.events.conflict(id).await;
    assert_eq!(remote, None);
    f.core.resolve_edit(id, EditResolution::Overwrite).unwrap();
    f.events.uploaded(id).await;
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "still mine\n"
    );
}

#[tokio::test]
async fn resolving_needs_an_open_conflict() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("notes.txt"), "x").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/notes.txt").await.unwrap();

    let err = f
        .core
        .resolve_edit(id, EditResolution::Overwrite)
        .unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
    let err = f
        .core
        .resolve_edit(EditId::new(), EditResolution::Overwrite)
        .unwrap_err();
    assert_eq!(err.kind(), "notFound");
}

#[tokio::test]
async fn a_failed_upload_is_reported_and_the_next_save_tries_again() {
    let server = TestServer::start(None).await;
    let remote = server.root().join("locked.txt");
    std::fs::write(&remote, "read only\n").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/locked.txt").await.unwrap();
    let local = f.local(id);

    // The server refuses the write (the test runs as the file's owner,
    // so a read-only mode is what stops it).
    std::fs::set_permissions(&remote, std::fs::Permissions::from_mode(0o444)).unwrap();
    save(&local, "edited\n");
    let (kind, message) = f
        .events
        .take("the failure", |e| match e {
            CoreEvent::EditFailed {
                edit_id,
                kind,
                message,
                ..
            } if *edit_id == id => Some((kind.clone(), message.clone())),
            _ => None,
        })
        .await;
    assert_eq!(kind, "permissionDenied", "{message}");
    assert!(!message.contains("edited"), "no file contents in errors");
    assert_eq!(f.edit(id).status, EditStatus::Failed);

    std::fs::set_permissions(&remote, std::fs::Permissions::from_mode(0o644)).unwrap();
    save(&local, "edited again\n");
    f.events.uploaded(id).await;
    assert_eq!(std::fs::read_to_string(&remote).unwrap(), "edited again\n");
}

#[tokio::test]
async fn a_save_while_reconnecting_waits_for_the_connection() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("notes.txt"), "before the drop\n").unwrap();
    // Plenty of attempts with a 100 ms step, so it keeps reconnecting while
    // the server refuses.
    let f = Fixture::new(&server, 20, Duration::from_millis(100));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/notes.txt").await.unwrap();

    server.set_refusing(true);
    server.kill_all();
    f.events
        .take("reconnecting", |e| match e {
            CoreEvent::SessionStateChanged {
                state: SessionState::Reconnecting { .. },
                ..
            } => Some(()),
            _ => None,
        })
        .await;
    save(&f.local(id), "saved while the link was down\n");
    f.wait_status(id, EditStatus::WaitingForConnection).await;
    assert!(f.core.has_active_work(), "a parked save holds work");
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "before the drop\n"
    );

    server.set_refusing(false);
    f.events.uploaded(id).await;
    assert_eq!(
        std::fs::read_to_string(server.root().join("notes.txt")).unwrap(),
        "saved while the link was down\n"
    );
    assert_eq!(f.edit(id).status, EditStatus::Synced);
    assert!(!f.core.has_active_work());
}

#[tokio::test]
async fn disconnecting_closes_the_sessions_edits_and_deletes_their_copies() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("a.txt"), "a").unwrap();
    std::fs::write(server.root().join("b.txt"), "b").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let one = f.connect().await;
    let other = f.connect().await;
    let a = f.core.open_remote(one, "/a.txt").await.unwrap();
    let b = f.core.open_remote(other, "/b.txt").await.unwrap();
    let (local_a, local_b) = (f.local(a), f.local(b));

    f.core.disconnect(one).await.unwrap();
    assert!(!local_a.exists());
    assert!(!local_a.parent().unwrap().parent().unwrap().exists());
    assert_eq!(f.core.list_edits().len(), 1);
    assert!(local_b.exists(), "other sessions keep theirs");

    // Closing one edit deletes its copy; the other session's folder goes
    // with its last edit.
    f.core.close_edit(b).await.unwrap();
    assert!(!local_b.exists());
    assert!(!local_b.parent().unwrap().parent().unwrap().exists());
    assert!(f.core.list_edits().is_empty());
    assert_eq!(f.core.close_edit(b).await.unwrap_err().kind(), "notFound");
    // No uploads happened along the way.
    assert!(
        f.events.edit_events().is_empty(),
        "{:#?}",
        f.events.edit_events()
    );
}

#[tokio::test]
async fn quitting_closes_every_edit_and_a_new_start_removes_leftovers() {
    let server = TestServer::start(None).await;
    std::fs::write(server.root().join("a.txt"), "a").unwrap();
    let f = Fixture::new(&server, 0, Duration::from_millis(10));
    let session = f.connect().await;
    let id = f.core.open_remote(session, "/a.txt").await.unwrap();
    let local = f.local(id);

    f.core.close_all_edits();
    assert!(!local.exists());
    assert!(!f.cache.path().join("edit").exists());
    assert!(f.core.list_edits().is_empty());

    // A crash leaves copies behind; the next start's `set_cache_dir` clears
    // them (and nothing else in the cache dir).
    let stale = f.cache.path().join("edit/old-session/0123456789abcdef");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("draft.txt"), "left behind").unwrap();
    std::fs::write(f.cache.path().join("other.bin"), "keep").unwrap();
    let next = Core::new();
    next.set_cache_dir(f.cache.path().to_path_buf());
    assert!(!f.cache.path().join("edit").exists());
    assert!(f.cache.path().join("other.bin").exists());
}
