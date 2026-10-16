//! Integration tests for folder sync (plan + run), against the hermetic
//! in-process SFTP server in `support/`. All data is fictitious.

#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use iris_core::{
    AuthMethod, BatchId, CompareRule, ConnectionProfile, Core, CoreError, CoreEvent, CoreResult,
    ProfileId, Secret, SessionId, SyncGroup, SyncMode, SyncOptions, SyncPlan, SyncPlanId,
    TransferDirection, Trash,
};
use tempfile::TempDir;

use support::{TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(30);
const MTIME: u64 = 1_600_000_000;

/// Removes what it is given from the temp dir and remembers it, so the
/// real Trash is never touched.
#[derive(Default)]
struct FakeTrash {
    trashed: Mutex<Vec<PathBuf>>,
}

impl Trash for FakeTrash {
    fn trash(&self, path: &Path) -> CoreResult<()> {
        let meta = std::fs::symlink_metadata(path)?;
        if meta.is_dir() {
            std::fs::remove_dir_all(path)?;
        } else {
            std::fs::remove_file(path)?;
        }
        self.trashed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

struct Fixture {
    core: Arc<Core>,
    /// The local folder being synced.
    local: TempDir,
    trash: Arc<FakeTrash>,
    events: Arc<Mutex<Vec<CoreEvent>>>,
    _dir: TempDir,
}

/// The remote folder being synced (below the server root).
const REMOTE_DIR: &str = "/site";

impl Fixture {
    async fn new(server: &TestServer) -> (Self, SessionId) {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        std::fs::write(&known_hosts, server.known_hosts_line()).unwrap();
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts);
        let trash = Arc::new(FakeTrash::default());
        core.set_trash(trash.clone());
        let profile = core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: "Sync test".into(),
                host: HOST.into(),
                port: server.port,
                user: USER.into(),
                auth: AuthMethod::Password,
                start_dir: None,
                jump: None,
            })
            .unwrap()
            .id;
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut rx = core.subscribe_events();
        let sink = Arc::clone(&events);
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                sink.lock().unwrap().push(event);
            }
        });
        std::fs::create_dir_all(server.root().join("site")).unwrap();
        let session = core
            .connect(profile, Some(Secret::new(PASSWORD)), None)
            .await
            .unwrap();
        let f = Self {
            core,
            local: tempfile::tempdir().unwrap(),
            trash,
            events,
            _dir: dir,
        };
        (f, session)
    }

    fn local_dir(&self) -> String {
        self.local.path().to_string_lossy().into_owned()
    }

    async fn plan(
        &self,
        session: SessionId,
        direction: TransferDirection,
        options: SyncOptions,
    ) -> SyncPlan {
        self.core
            .plan_sync(session, direction, &self.local_dir(), REMOTE_DIR, options)
            .await
            .unwrap()
    }

    /// Wait for the run of `plan_id` to finish; returns its event.
    async fn finished(&self, plan_id: SyncPlanId) -> Finished {
        let deadline = Instant::now() + WAIT;
        loop {
            let found = self.events.lock().unwrap().iter().find_map(|e| match e {
                CoreEvent::SyncFinished {
                    plan_id: id,
                    batch_id,
                    copied,
                    failed,
                    cancelled,
                    deleted,
                    kept,
                    note,
                    ..
                } if *id == plan_id => Some(Finished {
                    batch_id: *batch_id,
                    copied: *copied,
                    failed: *failed,
                    cancelled: *cancelled,
                    deleted: *deleted,
                    kept: *kept,
                    note: note.clone(),
                }),
                _ => None,
            });
            if let Some(found) = found {
                return found;
            }
            assert!(
                Instant::now() < deadline,
                "the sync never finished: {:#?}",
                self.core.list_transfers()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Run with the defaults and wait for the end.
    async fn run(&self, plan: &SyncPlan) -> Finished {
        let batch = self.core.run_sync(plan.plan_id, None).await.unwrap();
        let finished = self.finished(plan.plan_id).await;
        assert_eq!(finished.batch_id, batch);
        finished
    }
}

#[derive(Debug)]
struct Finished {
    batch_id: BatchId,
    copied: usize,
    failed: usize,
    cancelled: usize,
    deleted: usize,
    kept: usize,
    note: Option<String>,
}

fn write(path: &Path, content: &[u8], mtime: u64) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
    set_mtime(path, mtime);
}

fn set_mtime(path: &Path, secs: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap();
}

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn group(plan: &SyncPlan, path: &str) -> Option<SyncGroup> {
    plan.items.iter().find(|i| i.path == path).map(|i| i.group)
}

/// Every listed item's path with its group.
fn groups(plan: &SyncPlan) -> Vec<(String, SyncGroup)> {
    plan.items
        .iter()
        .map(|i| (i.path.clone(), i.group))
        .collect()
}

/// No item of the plan would copy anything.
fn nothing_to_copy(plan: &SyncPlan) -> bool {
    plan.items.iter().all(|i| {
        !matches!(
            i.group,
            SyncGroup::New
                | SyncGroup::Changed
                | SyncGroup::TargetNewer
                | SyncGroup::DifferentSizeSameDate
        )
    })
}

fn mirror() -> SyncOptions {
    SyncOptions {
        mode: SyncMode::Mirror,
        ..SyncOptions::default()
    }
}

/// local: new.txt, changed.txt, same.txt, docs/deep.txt
/// remote: changed.txt (older, other content), same.txt (identical),
/// extra.txt, old/inner.txt
fn upload_fixture(f: &Fixture, server: &TestServer) {
    let local = f.local.path();
    let remote = server.root().join("site");
    write(&local.join("new.txt"), b"brand new", MTIME);
    write(&local.join("changed.txt"), b"version two", MTIME + 60);
    write(&local.join("same.txt"), b"unchanged", MTIME);
    write(&local.join("docs/deep.txt"), b"deep file", MTIME);
    write(&remote.join("changed.txt"), b"version one", MTIME);
    write(&remote.join("same.txt"), b"unchanged", MTIME);
    write(&remote.join("extra.txt"), b"only remote", MTIME);
    write(&remote.join("old/inner.txt"), b"stale", MTIME);
}

#[tokio::test]
async fn an_upload_update_copies_new_and_changed_and_keeps_the_rest() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    upload_fixture(&f, &server);
    let remote = server.root().join("site");

    let plan = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    assert_eq!(
        groups(&plan),
        vec![
            ("changed.txt".into(), SyncGroup::Changed),
            ("docs".into(), SyncGroup::New),
            ("docs/deep.txt".into(), SyncGroup::New),
            ("extra.txt".into(), SyncGroup::TargetOnly),
            ("new.txt".into(), SyncGroup::New),
            ("old".into(), SyncGroup::TargetOnly),
            ("old/inner.txt".into(), SyncGroup::TargetOnly),
        ]
    );
    assert_eq!(plan.totals.get(SyncGroup::Same).files, 1);
    assert_eq!(plan.totals.get(SyncGroup::New).files, 2);
    assert!(plan
        .items
        .iter()
        .all(|i| i.group != SyncGroup::TargetOnly || !i.selected));

    let done = f.run(&plan).await;
    assert_eq!((done.copied, done.failed, done.deleted), (3, 0, 0));
    assert_eq!(std::fs::read(remote.join("new.txt")).unwrap(), b"brand new");
    assert_eq!(
        std::fs::read(remote.join("changed.txt")).unwrap(),
        b"version two"
    );
    assert_eq!(mtime(&remote.join("changed.txt")), MTIME + 60);
    assert_eq!(
        std::fs::read(remote.join("docs/deep.txt")).unwrap(),
        b"deep file"
    );
    // Target-only items stay in Update mode.
    assert!(remote.join("extra.txt").exists());
    assert!(remote.join("old/inner.txt").exists());
    // No conflict was asked for the changed file.
    assert!(!f
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, CoreEvent::TransferConflict { .. })));

    // Byte-identical with the dates kept: a second comparison finds
    // nothing to copy.
    let again = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    assert!(nothing_to_copy(&again), "{:#?}", again.items);
    assert_eq!(again.totals.get(SyncGroup::Same).files, 4);
}

#[tokio::test]
async fn a_download_update_mirrors_the_server_into_the_local_folder() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    write(&remote.join("report.txt"), b"quarterly numbers", MTIME);
    write(&remote.join("img/logo.svg"), b"<svg/>", MTIME + 5);
    write(&local.join("report.txt"), b"draft", MTIME - 100);
    write(&local.join("notes.txt"), b"mine", MTIME);
    std::fs::set_permissions(
        remote.join("img/logo.svg"),
        std::fs::Permissions::from_mode(0o640),
    )
    .unwrap();

    let plan = f
        .plan(session, TransferDirection::Download, SyncOptions::default())
        .await;
    assert_eq!(group(&plan, "report.txt"), Some(SyncGroup::Changed));
    assert_eq!(group(&plan, "img/logo.svg"), Some(SyncGroup::New));
    assert_eq!(group(&plan, "notes.txt"), Some(SyncGroup::TargetOnly));

    let done = f.run(&plan).await;
    assert_eq!((done.copied, done.failed), (2, 0));
    assert_eq!(
        std::fs::read(local.join("report.txt")).unwrap(),
        b"quarterly numbers"
    );
    assert_eq!(mtime(&local.join("img/logo.svg")), MTIME + 5);
    assert_eq!(
        std::fs::metadata(local.join("img/logo.svg"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o640
    );
    assert!(local.join("notes.txt").exists());

    let again = f
        .plan(session, TransferDirection::Download, SyncOptions::default())
        .await;
    assert!(nothing_to_copy(&again), "{:#?}", again.items);
}

#[tokio::test]
async fn mirror_deletes_target_only_items_after_the_copies() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    upload_fixture(&f, &server);
    let remote = server.root().join("site");

    let plan = f.plan(session, TransferDirection::Upload, mirror()).await;
    assert!(plan
        .items
        .iter()
        .filter(|i| i.group == SyncGroup::TargetOnly)
        .all(|i| i.selected));
    let done = f.run(&plan).await;
    // extra.txt, and old/ as a whole.
    assert_eq!((done.copied, done.deleted, done.kept), (3, 2, 0));
    assert!(!remote.join("extra.txt").exists());
    assert!(!remote.join("old").exists());
    assert!(remote.join("same.txt").exists());
    assert_eq!(std::fs::read(remote.join("new.txt")).unwrap(), b"brand new");

    let again = f.plan(session, TransferDirection::Upload, mirror()).await;
    assert!(again.items.is_empty(), "{:#?}", again.items);
}

#[tokio::test]
async fn a_download_mirror_moves_local_extras_to_the_trash() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    write(&remote.join("keep.txt"), b"server copy", MTIME);
    write(&local.join("keep.txt"), b"server copy", MTIME);
    write(&local.join("leftover.log.txt"), b"old", MTIME);
    write(&local.join(".git/HEAD"), b"ref", MTIME);

    let plan = f.plan(session, TransferDirection::Download, mirror()).await;
    assert_eq!(group(&plan, ".git"), Some(SyncGroup::Excluded));
    let done = f.run(&plan).await;
    assert_eq!(done.deleted, 1);
    assert_eq!(
        *f.trash.trashed.lock().unwrap(),
        vec![local.join("leftover.log.txt")]
    );
    // Excluded by default, so never deleted.
    assert!(local.join(".git/HEAD").exists());
}

#[tokio::test]
async fn a_failed_copy_stops_every_mirror_delete() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    upload_fixture(&f, &server);
    let remote = server.root().join("site");
    // The server cannot overwrite it.
    std::fs::set_permissions(
        remote.join("changed.txt"),
        std::fs::Permissions::from_mode(0o444),
    )
    .unwrap();

    let plan = f.plan(session, TransferDirection::Upload, mirror()).await;
    let done = f.run(&plan).await;
    assert_eq!(done.failed, 1, "{done:?}");
    assert_eq!((done.deleted, done.kept), (0, 2));
    assert!(done.note.is_some());
    assert!(remote.join("extra.txt").exists());
    assert!(remote.join("old/inner.txt").exists());
    // The other copies went through.
    assert!(remote.join("new.txt").exists());
}

#[tokio::test]
async fn unticked_items_are_left_alone() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    upload_fixture(&f, &server);
    let remote = server.root().join("site");

    let plan = f.plan(session, TransferDirection::Upload, mirror()).await;
    // Only new.txt and extra.txt stay ticked.
    let ticked = vec!["new.txt".to_string(), "extra.txt".to_string()];
    f.core.run_sync(plan.plan_id, Some(ticked)).await.unwrap();
    let done = f.finished(plan.plan_id).await;
    assert_eq!((done.copied, done.deleted), (1, 1));
    assert!(remote.join("new.txt").exists());
    assert!(!remote.join("docs").exists());
    assert_eq!(
        std::fs::read(remote.join("changed.txt")).unwrap(),
        b"version one"
    );
    assert!(!remote.join("extra.txt").exists());
    assert!(remote.join("old/inner.txt").exists());
}

#[tokio::test]
async fn a_plan_with_nothing_ticked_is_refused_and_kept() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    upload_fixture(&f, &server);
    let plan = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    let err = f
        .core
        .run_sync(plan.plan_id, Some(Vec::new()))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
    // Still there: the defaults run.
    f.run(&plan).await;
    // A plan runs once.
    let err = f.core.run_sync(plan.plan_id, None).await.unwrap_err();
    assert_eq!(err.kind(), "notFound");
}

#[tokio::test]
async fn plans_are_dropped_on_disconnect_and_expire() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    upload_fixture(&f, &server);

    let plan = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    f.core.disconnect(session).await.unwrap();
    let err = f.core.run_sync(plan.plan_id, None).await.unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");

    let (f, session) = Fixture::new(&server).await;
    let plan = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    f.core.set_sync_plan_ttl(Duration::ZERO);
    let err = f.core.run_sync(plan.plan_id, None).await.unwrap_err();
    assert!(err.to_string().contains("expired"), "{err}");

    // A discarded plan is gone too.
    f.core.set_sync_plan_ttl(Duration::from_secs(600));
    let plan = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    f.core.discard_sync_plan(plan.plan_id);
    assert!(f.core.run_sync(plan.plan_id, None).await.is_err());
}

#[tokio::test]
async fn a_target_changed_after_the_plan_is_not_deleted() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let remote = server.root().join("site");
    write(&remote.join("extra.txt"), b"only remote", MTIME);
    write(&remote.join("old/inner.txt"), b"stale", MTIME);
    write(&remote.join("gone.txt"), b"bye", MTIME);

    let plan = f.plan(session, TransferDirection::Upload, mirror()).await;
    // Someone edits one file and adds one to the folder meanwhile.
    write(
        &remote.join("extra.txt"),
        b"edited on the server",
        MTIME + 30,
    );
    write(&remote.join("old/new-upload.txt"), b"fresh", MTIME);

    let done = f.run(&plan).await;
    assert_eq!((done.deleted, done.kept), (1, 2), "{done:?}");
    assert!(done.note.unwrap().contains("changed since the comparison"));
    assert!(!remote.join("gone.txt").exists());
    assert!(remote.join("extra.txt").exists());
    assert!(remote.join("old/inner.txt").exists());
    assert!(remote.join("old/new-upload.txt").exists());
}

#[tokio::test]
async fn compare_rules_and_options_apply_to_real_folders() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    write(&local.join("a.txt"), b"same size", MTIME);
    write(&remote.join("a.txt"), b"SAME SIZE", MTIME + 3600);
    write(&local.join(".env"), b"KEY=demo", MTIME);
    write(&remote.join(".cache"), b"remote only", MTIME);
    write(&local.join("big.bin"), &vec![7u8; 2 * 1024 * 1024], MTIME);
    std::fs::create_dir(local.join("empty")).unwrap();

    let options = SyncOptions {
        mode: SyncMode::Mirror,
        rule: CompareRule::SizeOnly,
        skip_hidden: true,
        copy_empty_folders: false,
        max_file_size_mb: Some(1),
        ..SyncOptions::default()
    };
    let plan = f.plan(session, TransferDirection::Upload, options).await;
    assert_eq!(group(&plan, "a.txt"), None, "same size: same");
    assert_eq!(group(&plan, ".env"), Some(SyncGroup::Excluded));
    assert_eq!(group(&plan, ".cache"), Some(SyncGroup::Excluded));
    assert_eq!(group(&plan, "big.bin"), Some(SyncGroup::Skipped));
    assert_eq!(group(&plan, "empty"), Some(SyncGroup::New));
    // Only the empty folder is left, and empty folders are not made.
    let err = f.core.run_sync(plan.plan_id, None).await.unwrap_err();
    assert_eq!(err.kind(), "invalidInput");

    let plan = f
        .plan(session, TransferDirection::Upload, SyncOptions::default())
        .await;
    // The server copy is an hour newer: protected.
    assert_eq!(group(&plan, "a.txt"), Some(SyncGroup::TargetNewer));
    let done = f.run(&plan).await;
    assert_eq!(done.cancelled, 0);
    assert_eq!(std::fs::read(remote.join("a.txt")).unwrap(), b"SAME SIZE");
    assert!(remote.join("empty").is_dir());
    assert!(remote.join(".env").exists());
}
