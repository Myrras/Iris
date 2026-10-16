//! Integration tests for the transfer engine, against the hermetic
//! in-process SFTP server in `support/`. All data is fictitious.

#![cfg(unix)]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use iris_core::{
    AuthMethod, BatchId, BatchPhase, ConflictResolution, ConnectionProfile, Core, CoreError,
    CoreEvent, IrisSettings, ProfileId, Secret, SessionId, TransferDirection, TransferItem,
    TransferJob, TransferList, TransferRequest, TransferState,
};
use tempfile::TempDir;

use support::{TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    core: Arc<Core>,
    /// Local files live here.
    local: TempDir,
    profile: ProfileId,
    events: EventLog,
    _dir: TempDir,
}

impl Fixture {
    async fn new(server: &TestServer) -> (Self, SessionId) {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        std::fs::write(&known_hosts, server.known_hosts_line()).unwrap();
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts);
        let profile = core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: "Transfer test".into(),
                host: HOST.into(),
                port: server.port,
                user: USER.into(),
                auth: AuthMethod::Password,
                start_dir: None,
                jump: None,
            })
            .unwrap()
            .id;
        let events = EventLog::start(&core);
        let f = Self {
            core,
            local: tempfile::tempdir().unwrap(),
            profile,
            events,
            _dir: dir,
        };
        let session = f.connect().await;
        (f, session)
    }

    async fn connect(&self) -> SessionId {
        self.core
            .connect(self.profile, Some(Secret::new(PASSWORD)), None)
            .await
            .unwrap()
    }

    fn local(&self, name: &str) -> PathBuf {
        self.local.path().join(name)
    }

    fn local_dir(&self) -> String {
        self.local.path().to_string_lossy().into_owned()
    }

    fn parallel(&self, n: u32) {
        self.core
            .save_settings(IrisSettings {
                parallel_transfers: n,
                ..IrisSettings::default()
            })
            .unwrap();
    }

    fn upload(&self, session: SessionId, srcs: &[PathBuf], dst_dir: &str) -> BatchId {
        self.enqueue(
            session,
            TransferDirection::Upload,
            srcs.iter().map(|p| p.to_string_lossy().into_owned()),
            dst_dir,
        )
    }

    fn download(&self, session: SessionId, srcs: &[&str]) -> BatchId {
        self.enqueue(
            session,
            TransferDirection::Download,
            srcs.iter().map(|s| s.to_string()),
            &self.local_dir(),
        )
    }

    fn enqueue(
        &self,
        session_id: SessionId,
        direction: TransferDirection,
        srcs: impl Iterator<Item = String>,
        dst_dir: &str,
    ) -> BatchId {
        self.core
            .enqueue_transfers(TransferRequest {
                session_id,
                direction,
                items: srcs.map(|src| TransferItem { src }).collect(),
                dst_dir: dst_dir.into(),
            })
            .unwrap()
    }

    /// Poll the job list until `done` holds.
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

    /// Wait until nothing is active any more; returns the final list.
    async fn wait_idle(&self) -> TransferList {
        let deadline = Instant::now() + WAIT;
        while self.core.has_active_transfers() {
            assert!(
                Instant::now() < deadline,
                "transfers never settled: {:#?}",
                self.core.list_transfers()
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        self.core.list_transfers()
    }

    async fn wait_for_state(&self, id: iris_core::TransferId, state: TransferState) -> TransferJob {
        let list = self
            .wait_until(&format!("{state:?}"), |l| {
                l.jobs.iter().any(|j| j.id == id && j.state == state)
            })
            .await;
        list.jobs.into_iter().find(|j| j.id == id).unwrap()
    }
}

/// Every event the core publishes, collected in the background.
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

    fn conflicts(&self) -> Vec<CoreEvent> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, CoreEvent::TransferConflict { .. }))
            .cloned()
            .collect()
    }

    /// When each progress event of `job` arrived is not recorded, so the
    /// count is checked against the job's duration instead.
    fn progress_count(&self, job: iris_core::TransferId) -> usize {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, CoreEvent::TransferProgress { job_id, .. } if *job_id == job))
            .count()
    }

    /// `(bytes_done, size)` of each progress event of `job`, in order.
    fn progress(&self, job: iris_core::TransferId) -> Vec<(u64, u64)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                CoreEvent::TransferProgress {
                    job_id,
                    bytes_done,
                    size,
                    ..
                } if *job_id == job => Some((*bytes_done, *size)),
                _ => None,
            })
            .collect()
    }
}

/// Deterministic, fictitious bytes.
fn data(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    (0..len)
        .map(|_| {
            x = x
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (x >> 33) as u8
        })
        .collect()
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

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn job<'a>(list: &'a TransferList, src_suffix: &str) -> &'a TransferJob {
    list.jobs
        .iter()
        .find(|j| j.src.ends_with(src_suffix))
        .unwrap_or_else(|| panic!("no job for {src_suffix}: {list:#?}"))
}

const MTIME: u64 = 1_600_000_000;

// -- Single files -------------------------------------------------------------

#[tokio::test]
async fn an_upload_is_byte_identical_and_keeps_mtime_and_mode() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let content = data(1_500_000, 1);
    let src = f.local("report.bin");
    std::fs::write(&src, &content).unwrap();
    std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o640)).unwrap();
    set_mtime(&src, MTIME);
    // Slow enough to span several progress intervals.
    server.set_io_delay(Duration::from_millis(10));

    let started = Instant::now();
    f.upload(session, &[src], "/");
    let list = f.wait_idle().await;
    let elapsed = started.elapsed();

    let job = &list.jobs[0];
    assert_eq!(job.state, TransferState::Done, "{job:?}");
    assert_eq!(job.direction, TransferDirection::Upload);
    assert_eq!(job.dst, "/report.bin");
    assert_eq!(job.size, content.len() as u64);
    assert_eq!(job.bytes_done, job.size);
    let dst = server.root().join("report.bin");
    assert_eq!(std::fs::read(&dst).unwrap(), content);
    assert_eq!(mtime(&dst), MTIME);
    assert_eq!(mode(&dst), 0o640);

    // Progress is coalesced to at most ten events a second.
    let events = f.events.progress_count(job.id);
    let allowed = (elapsed.as_secs_f64() * 10.0).ceil() as usize + 1;
    assert!(
        events >= 1 && events <= allowed,
        "{events} events in {elapsed:?}"
    );
    assert_eq!(list.summary.total_bytes, content.len() as u64);
    assert_eq!(list.summary.done_bytes, content.len() as u64);
}

/// The bytes copied after the last throttled progress event used to go
/// unannounced: on a fast link the panel showed the first chunk until the job
/// changed state, while the server still had to confirm the end of the file.
/// The file was complete, the row showed (almost) nothing, and only a re-pull
/// (cancel) revealed 100 %.
#[tokio::test]
async fn an_upload_announces_all_its_bytes_before_the_server_confirms_the_file() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let content = data(2_000_000, 9);
    let src = f.local("upload.bin");
    std::fs::write(&src, &content).unwrap();
    server.set_close_delay(Duration::from_secs(2));

    f.upload(session, &[src], "/");
    let dst = server.root().join("upload.bin");
    let deadline = Instant::now() + WAIT;
    let job = loop {
        let list = f.core.list_transfers();
        if let Some(job) = list.jobs.first() {
            assert_ne!(
                job.state,
                TransferState::Done,
                "done before every byte was announced: {:?}",
                f.events.progress(job.id)
            );
            let complete = std::fs::metadata(&dst).is_ok_and(|m| m.len() == content.len() as u64);
            let announced = f.events.progress(job.id).last().copied();
            if complete && announced == Some((job.size, job.size)) {
                assert_eq!(job.state, TransferState::Running, "{job:?}");
                break job.clone();
            }
        }
        assert!(
            Instant::now() < deadline,
            "never announced the whole file: {:?}",
            f.core.list_transfers()
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let done = f.wait_for_state(job.id, TransferState::Done).await;
    assert_eq!(done.bytes_done, content.len() as u64);
    assert_eq!(std::fs::read(&dst).unwrap(), content);
}

#[tokio::test]
async fn a_download_is_byte_identical_and_keeps_mtime_and_mode() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let content = data(700_000, 2);
    let remote = server.root().join("photo.raw");
    std::fs::write(&remote, &content).unwrap();
    std::fs::set_permissions(&remote, std::fs::Permissions::from_mode(0o604)).unwrap();
    set_mtime(&remote, MTIME);

    f.download(session, &["/photo.raw"]);
    let list = f.wait_idle().await;

    let job = &list.jobs[0];
    assert_eq!(job.state, TransferState::Done, "{job:?}");
    let dst = f.local("photo.raw");
    assert_eq!(job.dst, dst.to_string_lossy());
    assert_eq!(std::fs::read(&dst).unwrap(), content);
    assert_eq!(mtime(&dst), MTIME);
    assert_eq!(mode(&dst), 0o604);
}

#[tokio::test]
async fn an_empty_file_transfers() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let src = f.local("empty.txt");
    std::fs::write(&src, b"").unwrap();
    f.upload(session, &[src], "/");
    let list = f.wait_idle().await;
    assert_eq!(list.jobs[0].state, TransferState::Done);
    assert_eq!(std::fs::read(server.root().join("empty.txt")).unwrap(), b"");
}

#[tokio::test]
async fn a_missing_source_fails_the_job() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    f.download(session, &["/no-such-file.txt"]);
    let list = f.wait_idle().await;
    let job = &list.jobs[0];
    assert_eq!(job.state, TransferState::Failed);
    assert_eq!(job.error.as_ref().unwrap().kind, "notFound");
}

// -- Folders ------------------------------------------------------------------

#[tokio::test]
async fn a_folder_upload_creates_the_tree_and_skips_folder_links() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let root = f.local("project");
    std::fs::create_dir_all(root.join("src/deep")).unwrap();
    std::fs::create_dir_all(root.join("empty")).unwrap();
    std::fs::write(root.join("readme.md"), data(1000, 3)).unwrap();
    std::fs::write(root.join("src/main.rs"), data(300_000, 4)).unwrap();
    std::fs::write(root.join("src/deep/data.bin"), data(600_000, 5)).unwrap();
    std::os::unix::fs::symlink("readme.md", root.join("readme-link.md")).unwrap();
    std::os::unix::fs::symlink("src", root.join("src-link")).unwrap();
    std::fs::create_dir(server.root().join("uploads")).unwrap();

    f.upload(session, std::slice::from_ref(&root), "/uploads");
    let list = f.wait_idle().await;

    let dst = server.root().join("uploads/project");
    assert!(dst.join("empty").is_dir(), "empty folders are created too");
    for file in ["readme.md", "src/main.rs", "src/deep/data.bin"] {
        assert_eq!(
            std::fs::read(dst.join(file)).unwrap(),
            std::fs::read(root.join(file)).unwrap(),
            "{file}"
        );
    }
    // A link to a file is copied as the file.
    let link = std::fs::symlink_metadata(dst.join("readme-link.md")).unwrap();
    assert!(link.is_file());
    assert_eq!(
        std::fs::read(dst.join("readme-link.md")).unwrap(),
        data(1000, 3)
    );
    // A link to a folder is skipped, with the reason.
    assert!(!dst.join("src-link").exists());
    let skipped = job(&list, "src-link");
    assert_eq!(skipped.state, TransferState::Skipped);
    assert!(skipped.error.as_ref().unwrap().message.contains("folders"));
    let done = list
        .jobs
        .iter()
        .filter(|j| j.state == TransferState::Done)
        .count();
    assert_eq!(done, 4, "{list:#?}");
    assert_eq!(
        job(&list, "data.bin").dst,
        "/uploads/project/src/deep/data.bin"
    );
}

/// A folder transfer counts everything first: no job exists while it
/// counts, then all of them appear at once with the totals known.
#[tokio::test]
async fn a_folder_is_counted_before_any_job_is_queued() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let mut expected_bytes = 0;
    let mut expected_files = 0;
    for dir in ["album", "album/2024", "album/2024/june", "album/2025"] {
        std::fs::create_dir_all(server.root().join(dir)).unwrap();
        for i in 0..3 {
            let len = 1000 + i * 10;
            std::fs::write(
                server.root().join(format!("{dir}/pic-{i}.jpg")),
                data(len, 1),
            )
            .unwrap();
            expected_bytes += len as u64;
            expected_files += 1;
        }
    }
    // Slow listings, so the count can be watched.
    server.set_list_delay(Duration::from_millis(40));

    let batch_id = f.download(session, &["/album"]);
    let mut saw_counting = false;
    let deadline = Instant::now() + WAIT;
    loop {
        let list = f.core.list_transfers();
        let batch = list.batches.iter().find(|b| b.batch_id == batch_id);
        if let Some(batch) = batch {
            if batch.phase == BatchPhase::Counting {
                saw_counting = true;
                assert!(list.jobs.is_empty(), "no jobs while counting: {list:#?}");
                assert!(list.summary.eta_secs.is_none());
            }
        }
        // All jobs at once: never a part of them.
        assert!(
            list.jobs.is_empty() || list.jobs.len() == expected_files,
            "{list:#?}"
        );
        if !f.core.has_active_transfers() && !list.jobs.is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert!(saw_counting, "the batch was counting first");
    let list = f.core.list_transfers();
    let batch = list
        .batches
        .iter()
        .find(|b| b.batch_id == batch_id)
        .unwrap();
    assert_eq!(batch.phase, BatchPhase::Done);
    assert_eq!(batch.total_files, expected_files as u64);
    assert_eq!(batch.total_bytes, expected_bytes);
    assert_eq!(batch.done_files, expected_files as u64);
    assert_eq!(batch.counted_files, expected_files as u64);
    assert_eq!(batch.counted_bytes, expected_bytes);
    assert_eq!(batch.counted_folders, 4);
    // The counting events grow and end at the totals.
    let counts: Vec<(u64, u64, u64)> = f
        .events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            CoreEvent::BatchCounting {
                batch_id: id,
                files,
                bytes,
                folders,
            } if *id == batch_id => Some((*files, *bytes, *folders)),
            _ => None,
        })
        .collect();
    assert!(counts.windows(2).all(|w| w[0] <= w[1]), "{counts:?}");
    assert_eq!(
        counts.last(),
        Some(&(expected_files as u64, expected_bytes, 4))
    );
}

/// Cancelling a batch while it counts ends it without a single job.
#[tokio::test]
async fn cancelling_while_counting_queues_nothing() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    for dir in ["a", "a/b", "a/b/c"] {
        std::fs::create_dir_all(server.root().join(dir)).unwrap();
        std::fs::write(server.root().join(format!("{dir}/f.txt")), "fictitious").unwrap();
    }
    server.set_list_delay(Duration::from_millis(200));
    let batch_id = f.download(session, &["/a"]);
    f.wait_until("counting", |l| {
        l.batches
            .iter()
            .any(|b| b.batch_id == batch_id && b.phase == BatchPhase::Counting)
    })
    .await;
    f.core.cancel_batch(batch_id).unwrap();
    let list = f.wait_idle().await;
    assert!(list.jobs.is_empty(), "{list:#?}");
    assert!(!f.local("a/b").exists(), "no folders made");
}

/// A destination folder that cannot be made becomes a failed placeholder;
/// the rest of the tree is copied.
#[tokio::test]
async fn a_folder_that_cannot_be_made_fails_on_its_own() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let root = f.local("site");
    std::fs::create_dir_all(root.join("css")).unwrap();
    std::fs::create_dir_all(root.join("img/icons")).unwrap();
    std::fs::write(root.join("index.html"), "fictitious").unwrap();
    std::fs::write(root.join("css/main.css"), "fictitious").unwrap();
    std::fs::write(root.join("img/logo.png"), "fictitious").unwrap();
    std::fs::write(root.join("img/icons/a.svg"), "fictitious").unwrap();
    // A file where the `img` folder should go.
    std::fs::create_dir_all(server.root().join("www/site")).unwrap();
    std::fs::write(server.root().join("www/site/img"), "in the way").unwrap();

    f.upload(session, std::slice::from_ref(&root), "/www");
    let list = f.wait_idle().await;
    let failed: Vec<&TransferJob> = list
        .jobs
        .iter()
        .filter(|j| j.state == TransferState::Failed)
        .collect();
    assert_eq!(failed.len(), 1, "{list:#?}");
    assert!(failed[0].folder && failed[0].src.ends_with("site/img"));
    let done: Vec<&str> = list
        .jobs
        .iter()
        .filter(|j| j.state == TransferState::Done)
        .map(|j| j.dst.as_str())
        .collect();
    assert_eq!(done, ["/www/site/css/main.css", "/www/site/index.html"]);
}

/// While bytes move, the summary says how long the rest will take.
#[tokio::test]
async fn the_summary_has_an_eta_while_copying() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    std::fs::write(server.root().join("big.iso"), data(3 * 1024 * 1024, 2)).unwrap();
    server.set_io_delay(Duration::from_millis(4));
    f.download(session, &["/big.iso"]);
    let list = f
        .wait_until("an ETA", |l| l.summary.eta_secs.is_some())
        .await;
    assert!(list.summary.eta_secs.unwrap() > 0);
    assert_eq!(list.batches[0].phase, BatchPhase::Transferring);
    f.core.cancel_all_transfers();
}

#[tokio::test]
async fn a_folder_download_merges_into_an_existing_folder() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let remote = server.root().join("site");
    std::fs::create_dir_all(remote.join("assets/img")).unwrap();
    std::fs::write(remote.join("index.html"), data(2000, 6)).unwrap();
    std::fs::write(remote.join("assets/img/logo.png"), data(400_000, 7)).unwrap();
    std::fs::create_dir_all(remote.join("assets/empty")).unwrap();
    // The destination folder already exists (with another file in it).
    std::fs::create_dir_all(f.local("site/assets")).unwrap();
    std::fs::write(f.local("site/keep.txt"), b"mine").unwrap();

    f.download(session, &["/site"]);
    let list = f.wait_idle().await;

    assert!(
        list.jobs.iter().all(|j| j.state == TransferState::Done),
        "{list:#?}"
    );
    assert_eq!(list.jobs.len(), 2);
    assert_eq!(
        std::fs::read(f.local("site/assets/img/logo.png")).unwrap(),
        data(400_000, 7)
    );
    assert_eq!(
        std::fs::read(f.local("site/index.html")).unwrap(),
        data(2000, 6)
    );
    assert!(f.local("site/assets/empty").is_dir());
    assert_eq!(std::fs::read(f.local("site/keep.txt")).unwrap(), b"mine");
}

// -- Parallelism --------------------------------------------------------------

#[tokio::test]
async fn no_more_jobs_run_at_once_than_the_setting_allows() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    f.parallel(2);
    server.set_io_delay(Duration::from_millis(3));
    let srcs: Vec<PathBuf> = (0..6)
        .map(|i| {
            let p = f.local(&format!("part-{i}.bin"));
            std::fs::write(&p, data(256 * 1024, 10 + i)).unwrap();
            p
        })
        .collect();

    f.upload(session, &srcs, "/");
    let list = f.wait_idle().await;

    assert!(list.jobs.iter().all(|j| j.state == TransferState::Done));
    assert_eq!(server.max_open_files(), 2, "two run at once, never more");
    for (i, src) in srcs.iter().enumerate() {
        let name = src.file_name().unwrap();
        assert_eq!(
            std::fs::read(server.root().join(name)).unwrap(),
            data(256 * 1024, 10 + i as u64)
        );
    }

    // A changed setting applies to the next batch.
    f.parallel(1);
    server.reset_max_open_files();
    let downloads = f.local("downloads");
    std::fs::create_dir(&downloads).unwrap();
    f.enqueue(
        session,
        TransferDirection::Download,
        ["/part-0.bin", "/part-1.bin", "/part-2.bin"]
            .into_iter()
            .map(String::from),
        &downloads.to_string_lossy(),
    );
    let list = f.wait_idle().await;
    assert!(list.jobs.iter().all(|j| j.state == TransferState::Done));
    assert_eq!(server.max_open_files(), 1);
}

// -- Cancel and resume --------------------------------------------------------

#[tokio::test]
async fn a_cancelled_upload_leaves_a_partial_file_that_resume_completes() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let content = data(4 * 1024 * 1024, 20);
    let src = f.local("backup.tar");
    std::fs::write(&src, &content).unwrap();
    server.set_io_delay(Duration::from_millis(5));

    f.upload(session, std::slice::from_ref(&src), "/");
    let list = f
        .wait_until("progress", |l| {
            l.jobs.first().is_some_and(|j| j.bytes_done > 0)
        })
        .await;
    let id = list.jobs[0].id;
    assert!(f.core.has_active_transfers());
    assert!(f.core.has_active_work(), "the close guard sees transfers");
    f.core.cancel_transfer(id).unwrap();
    f.wait_for_state(id, TransferState::Cancelled).await;
    assert!(!f.core.has_active_transfers());

    let partial = std::fs::read(server.root().join("backup.tar")).unwrap();
    assert!(
        !partial.is_empty() && partial.len() < content.len(),
        "{}",
        partial.len()
    );
    assert_eq!(partial[..], content[..partial.len()]);

    // Cancelling a finished job changes nothing.
    f.core.cancel_transfer(id).unwrap();

    // Sending it again finds the partial file; resume appends the rest.
    server.set_io_delay(Duration::ZERO);
    f.upload(session, &[src], "/");
    let list = f
        .wait_until("a conflict", |l| {
            l.jobs
                .iter()
                .any(|j| j.state == TransferState::NeedsDecision)
        })
        .await;
    let again = list
        .jobs
        .iter()
        .find(|j| j.state == TransferState::NeedsDecision)
        .unwrap();
    let conflicts = f.events.conflicts();
    assert!(matches!(
        &conflicts[..],
        [CoreEvent::TransferConflict { job_id, src, dst, .. }]
            if *job_id == again.id
                && src.size == content.len() as u64
                && dst.size == partial.len() as u64
                && dst.path == "/backup.tar"
    ));
    f.core
        .resolve_conflict(again.id, ConflictResolution::Resume, false)
        .unwrap();
    let done = f.wait_for_state(again.id, TransferState::Done).await;
    assert_eq!(done.bytes_done, content.len() as u64);
    assert_eq!(
        std::fs::read(server.root().join("backup.tar")).unwrap(),
        content
    );
}

#[tokio::test]
async fn a_dropped_connection_pauses_and_resume_paused_completes_the_download() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let content = data(4 * 1024 * 1024, 21);
    std::fs::write(server.root().join("video.mp4"), &content).unwrap();
    server.set_io_delay(Duration::from_millis(5));

    f.download(session, &["/video.mp4"]);
    let list = f
        .wait_until("progress", |l| {
            l.jobs.first().is_some_and(|j| j.bytes_done > 0)
        })
        .await;
    let id = list.jobs[0].id;
    server.disconnect_all().await;

    let paused = f.wait_for_state(id, TransferState::Paused).await;
    assert!(paused.bytes_done > 0 && paused.bytes_done < content.len() as u64);
    assert!(f.core.has_active_transfers(), "a paused job is still work");
    let partial = std::fs::metadata(f.local("video.mp4")).unwrap().len();
    assert!(partial < content.len() as u64);

    // Reconnect (a new session) and carry on where it stopped.
    server.set_io_delay(Duration::ZERO);
    let session2 = f.connect().await;
    assert_eq!(f.core.resume_paused_on(session, session2), 1);
    let done = f.wait_for_state(id, TransferState::Done).await;
    assert_eq!(done.session_id, session2);
    assert_eq!(std::fs::read(f.local("video.mp4")).unwrap(), content);
    assert!(
        f.events.conflicts().is_empty(),
        "resuming its own file is no conflict"
    );
}

#[tokio::test]
async fn cancelling_a_batch_cancels_running_and_queued_jobs() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    f.parallel(1);
    server.set_io_delay(Duration::from_millis(5));
    let srcs: Vec<PathBuf> = (0..4)
        .map(|i| {
            let p = f.local(&format!("big-{i}.bin"));
            std::fs::write(&p, data(2 * 1024 * 1024, 30 + i)).unwrap();
            p
        })
        .collect();

    let batch = f.upload(session, &srcs, "/");
    f.wait_until("a running job", |l| {
        l.jobs.len() == 4 && l.jobs.iter().any(|j| j.bytes_done > 0)
    })
    .await;
    f.core.cancel_batch(batch).unwrap();
    let list = f.wait_idle().await;
    assert!(
        list.jobs
            .iter()
            .all(|j| j.state == TransferState::Cancelled),
        "{list:#?}"
    );
    assert!(
        !server.root().join("big-3.bin").exists(),
        "queued jobs never started"
    );

    // Clearing drops the finished jobs.
    f.core.clear_finished_transfers();
    assert!(f.core.list_transfers().jobs.is_empty());
    assert!(matches!(
        f.core.cancel_batch(BatchId::new()),
        Err(CoreError::NotFound(_))
    ));
}

// -- Conflicts ----------------------------------------------------------------

#[tokio::test]
async fn each_conflict_answer_does_what_it_says() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let remote = |name: &str| server.root().join(name);
    let names = [
        "replace.txt",
        "skip.txt",
        "both.txt",
        "resume.txt",
        "same.txt",
        "longer.txt",
    ];
    let srcs: Vec<PathBuf> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let p = f.local(name);
            std::fs::write(&p, data(100_000, 40 + i as u64)).unwrap();
            p
        })
        .collect();
    let src_of = |name: &str| std::fs::read(f.local(name)).unwrap();
    std::fs::write(remote("replace.txt"), b"old").unwrap();
    std::fs::write(remote("skip.txt"), b"keep me").unwrap();
    std::fs::write(remote("both.txt"), b"original").unwrap();
    std::fs::write(remote("both (2).txt"), b"taken").unwrap();
    std::fs::write(remote("resume.txt"), &src_of("resume.txt")[..30_000]).unwrap();
    let same = data(100_000, 99);
    std::fs::write(remote("same.txt"), &same).unwrap();
    std::fs::write(remote("longer.txt"), data(150_000, 98)).unwrap();

    f.upload(session, &srcs, "/");
    let list = f
        .wait_until("six conflicts", |l| {
            l.jobs.len() == 6
                && l.jobs
                    .iter()
                    .all(|j| j.state == TransferState::NeedsDecision)
        })
        .await;
    assert_eq!(f.events.conflicts().len(), 6);
    let answers = [
        ("replace.txt", ConflictResolution::Replace),
        ("skip.txt", ConflictResolution::Skip),
        ("both.txt", ConflictResolution::KeepBoth),
        ("resume.txt", ConflictResolution::Resume),
        ("same.txt", ConflictResolution::Resume),
        ("longer.txt", ConflictResolution::Resume),
    ];
    for (name, answer) in answers {
        f.core
            .resolve_conflict(job(&list, name).id, answer, false)
            .unwrap();
    }
    let list = f.wait_idle().await;

    assert_eq!(
        std::fs::read(remote("replace.txt")).unwrap(),
        src_of("replace.txt")
    );
    assert_eq!(job(&list, "skip.txt").state, TransferState::Skipped);
    assert_eq!(std::fs::read(remote("skip.txt")).unwrap(), b"keep me");
    // Keep both: the first free number, the original untouched.
    assert_eq!(job(&list, "both.txt").dst, "/both (3).txt");
    assert_eq!(
        std::fs::read(remote("both (3).txt")).unwrap(),
        src_of("both.txt")
    );
    assert_eq!(std::fs::read(remote("both.txt")).unwrap(), b"original");
    assert_eq!(std::fs::read(remote("both (2).txt")).unwrap(), b"taken");
    // Resume appends to a shorter destination ...
    assert_eq!(
        std::fs::read(remote("resume.txt")).unwrap(),
        src_of("resume.txt")
    );
    // ... counts an equal-sized one as done, leaving it alone ...
    assert_eq!(job(&list, "same.txt").state, TransferState::Done);
    assert_eq!(std::fs::read(remote("same.txt")).unwrap(), same);
    // ... and replaces a larger one.
    assert_eq!(
        std::fs::read(remote("longer.txt")).unwrap(),
        src_of("longer.txt")
    );
    for name in [
        "replace.txt",
        "both.txt",
        "resume.txt",
        "same.txt",
        "longer.txt",
    ] {
        assert_eq!(job(&list, name).state, TransferState::Done, "{name}");
    }

    // Only a waiting job takes an answer.
    let done = job(&list, "replace.txt").id;
    assert!(matches!(
        f.core
            .resolve_conflict(done, ConflictResolution::Skip, false),
        Err(CoreError::InvalidInput(_))
    ));
    assert!(matches!(
        f.core.resolve_conflict(
            iris_core::TransferId::new(),
            ConflictResolution::Skip,
            false
        ),
        Err(CoreError::NotFound(_))
    ));
}

#[tokio::test]
async fn apply_to_all_decides_later_conflicts_without_asking() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    f.parallel(1);
    // The first item conflicts; while it waits, a slow one runs; the later
    // conflicts only come up after the answer.
    let names = ["a-first.txt", "b-slow.bin", "c-later.txt", "d-later.txt"];
    let srcs: Vec<PathBuf> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let p = f.local(name);
            let len = if name.ends_with(".bin") {
                2 * 1024 * 1024
            } else {
                5000
            };
            std::fs::write(&p, data(len, 50 + i as u64)).unwrap();
            p
        })
        .collect();
    for name in ["a-first.txt", "c-later.txt", "d-later.txt"] {
        std::fs::write(server.root().join(name), b"stale").unwrap();
    }
    server.set_io_delay(Duration::from_millis(5));

    f.upload(session, &srcs, "/");
    let list = f
        .wait_until("the first conflict", |l| {
            l.jobs
                .iter()
                .any(|j| j.state == TransferState::NeedsDecision)
        })
        .await;
    let first = list
        .jobs
        .iter()
        .find(|j| j.state == TransferState::NeedsDecision)
        .unwrap();
    assert!(first.src.ends_with("a-first.txt"));
    f.core
        .resolve_conflict(first.id, ConflictResolution::Replace, true)
        .unwrap();
    let list = f.wait_idle().await;

    assert!(
        list.jobs.iter().all(|j| j.state == TransferState::Done),
        "{list:#?}"
    );
    assert_eq!(
        f.events.conflicts().len(),
        1,
        "later conflicts were not asked"
    );
    for (i, name) in names.iter().enumerate() {
        let len = if name.ends_with(".bin") {
            2 * 1024 * 1024
        } else {
            5000
        };
        assert_eq!(
            std::fs::read(server.root().join(name)).unwrap(),
            data(len, 50 + i as u64),
            "{name}"
        );
    }
}

#[tokio::test]
async fn apply_to_all_also_answers_the_conflicts_already_waiting() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let srcs: Vec<PathBuf> = (0..3)
        .map(|i| {
            let p = f.local(&format!("doc-{i}.txt"));
            std::fs::write(&p, data(1000, 60 + i)).unwrap();
            std::fs::write(server.root().join(format!("doc-{i}.txt")), b"theirs").unwrap();
            p
        })
        .collect();

    f.upload(session, &srcs, "/");
    let list = f
        .wait_until("three conflicts", |l| {
            l.jobs.len() == 3
                && l.jobs
                    .iter()
                    .all(|j| j.state == TransferState::NeedsDecision)
        })
        .await;
    f.core
        .resolve_conflict(list.jobs[1].id, ConflictResolution::Skip, true)
        .unwrap();
    let list = f.wait_idle().await;
    assert!(list.jobs.iter().all(|j| j.state == TransferState::Skipped));
    for i in 0..3 {
        assert_eq!(
            std::fs::read(server.root().join(format!("doc-{i}.txt"))).unwrap(),
            b"theirs"
        );
    }
}

// -- Validation ---------------------------------------------------------------

#[tokio::test]
async fn enqueue_checks_its_request() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let request = |session_id, items: Vec<TransferItem>| TransferRequest {
        session_id,
        direction: TransferDirection::Upload,
        items,
        dst_dir: "/".into(),
    };
    let item = TransferItem {
        src: f.local("x").to_string_lossy().into_owned(),
    };
    assert!(matches!(
        f.core.enqueue_transfers(request(session, vec![])),
        Err(CoreError::InvalidInput(_))
    ));
    assert!(matches!(
        f.core
            .enqueue_transfers(request(SessionId::new(), vec![item])),
        Err(CoreError::NotConnected)
    ));
    assert!(!f.core.has_active_transfers());
}
