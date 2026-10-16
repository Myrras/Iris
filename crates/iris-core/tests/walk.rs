//! Folder tree walks over SFTP: how many listings run at once, and a
//! benchmark of a sync comparison and a folder transfer's walk against a
//! server with a network delay (the hermetic server in `support/`). All
//! data is fictitious.

#![cfg(unix)]

mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use iris_core::{
    AuthMethod, ConnectionProfile, Core, IrisSettings, ProfileId, Secret, SessionId, SyncOptions,
    TransferDirection, TransferItem, TransferList, TransferRequest,
};
use tempfile::TempDir;

use support::{TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(300);

struct Fixture {
    core: Arc<Core>,
    local: TempDir,
    profile: ProfileId,
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
                name: "Walk test".into(),
                host: HOST.into(),
                port: server.port,
                user: USER.into(),
                auth: AuthMethod::Password,
                start_dir: None,
                jump: None,
            })
            .unwrap()
            .id;
        let f = Self {
            core,
            local: tempfile::tempdir().unwrap(),
            profile,
            _dir: dir,
        };
        let session = f
            .core
            .connect(f.profile, Some(Secret::new(PASSWORD)), None)
            .await
            .unwrap();
        (f, session)
    }

    fn local_dir(&self) -> String {
        self.local.path().to_string_lossy().into_owned()
    }

    async fn wait_until(&self, what: &str, done: impl Fn(&TransferList) -> bool) -> TransferList {
        let deadline = Instant::now() + WAIT;
        loop {
            let list = self.core.list_transfers();
            if done(&list) {
                return list;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

/// A tree of `top` folders, each with `mid` subfolders, each with `leaf`
/// subfolders; every folder holds `files` small files. Returns (folders,
/// files).
fn make_tree(root: &Path, top: usize, mid: usize, leaf: usize, files: usize) -> (usize, usize) {
    let mut folders = 0;
    let mut count = 0;
    let mut fill = |dir: &Path| {
        std::fs::create_dir_all(dir).unwrap();
        folders += 1;
        for f in 0..files {
            std::fs::write(dir.join(format!("file-{f}.txt")), b"fictitious").unwrap();
            count += 1;
        }
    };
    for t in 0..top {
        let t_dir = root.join(format!("dir-{t}"));
        fill(&t_dir);
        for m in 0..mid {
            let m_dir = t_dir.join(format!("sub-{m}"));
            fill(&m_dir);
            for l in 0..leaf {
                fill(&m_dir.join(format!("leaf-{l}")));
            }
        }
    }
    (folders, count)
}

/// Comparing for a sync lists remote folders concurrently, but never more
/// than the walker's limit at once.
#[tokio::test]
async fn a_sync_comparison_lists_folders_concurrently_within_the_limit() {
    let server = TestServer::start(None).await;
    let (folders, files) = make_tree(&server.root().join("tree"), 4, 4, 4, 1);
    // Slow listings, so concurrent ones overlap.
    server.set_list_delay(Duration::from_millis(20));
    let (f, session) = Fixture::new(&server).await;
    server.reset_listing_stats();
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &f.local_dir(),
            "/tree",
            SyncOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(plan.items.len(), folders + files);
    assert_eq!(server.listings(), folders + 1, "each folder listed once");
    let max = server.max_open_dirs();
    assert!(max > 1, "listings overlapped: {max}");
    assert!(
        max <= iris_core::REMOTE_LISTINGS,
        "at most the limit: {max}"
    );
}

/// The time a sync comparison and a folder download's walk take for
/// ~500 folders / 3,000 files on a server 5 ms (round trip) away. Run with
/// `cargo test -p iris-core --release --test walk -- --ignored --nocapture`
/// (`IRIS_WALK_LIST_DELAY_MS=2` adds server-side time per listing).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn walk_benchmark() {
    let server = TestServer::start(None).await;
    // 10 + 70 + 420 = 500 folders, 6 files each = 3,000 files.
    let (folders, files) = make_tree(&server.root().join("tree"), 10, 7, 6, 6);
    server.set_latency(Duration::from_micros(2500));
    // Server-side time per listing (a slow disk), when asked for.
    if let Some(ms) = std::env::var("IRIS_WALK_LIST_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        server.set_list_delay(Duration::from_millis(ms));
    }
    let (f, session) = Fixture::new(&server).await;
    f.core
        .save_settings(IrisSettings {
            parallel_transfers: 1,
            ..IrisSettings::default()
        })
        .unwrap();

    let started = Instant::now();
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &f.local_dir(),
            "/tree",
            SyncOptions::default(),
        )
        .await
        .unwrap();
    let sync = started.elapsed();
    assert_eq!(plan.items.len(), folders + files);

    let started = Instant::now();
    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Download,
            items: vec![TransferItem {
                src: "/tree".into(),
            }],
            dst_dir: f.local_dir(),
        })
        .unwrap();
    f.wait_until("every file found", |l| {
        l.jobs.iter().filter(|j| !j.folder).count() >= files
    })
    .await;
    let download = started.elapsed();
    f.core.cancel_all_transfers();

    // Upload the downloaded-or-not local copy of the same tree: the walk is
    // local, the destination folders are made remotely.
    let upload_src = tempfile::tempdir().unwrap();
    make_tree(&upload_src.path().join("tree"), 10, 7, 6, 6);
    std::fs::create_dir_all(server.root().join("upload")).unwrap();
    let started = Instant::now();
    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Upload,
            items: vec![TransferItem {
                src: upload_src
                    .path()
                    .join("tree")
                    .to_string_lossy()
                    .into_owned(),
            }],
            dst_dir: "/upload".into(),
        })
        .unwrap();
    f.wait_until("every file found", |l| {
        l.jobs
            .iter()
            .filter(|j| !j.folder && j.direction == TransferDirection::Upload)
            .count()
            >= files
    })
    .await;
    let upload = started.elapsed();
    f.core.cancel_all_transfers();

    eprintln!(
        "walk benchmark ({folders} folders, {files} files, 5 ms round trip): \
         sync compare {sync:?}, download walk {download:?}, upload walk {upload:?}"
    );
}

/// Copy the shape of `src` (folders and empty files; links and the rest
/// left out) into `dst`. Only reads `src`.
fn mirror_shape(src: &Path, dst: &Path) -> (usize, usize) {
    let (mut folders, mut files) = (1, 0);
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap().flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            let (d, f) = mirror_shape(&entry.path(), &to);
            folders += d;
            files += f;
        } else if kind.is_file() {
            std::fs::write(&to, b"").unwrap();
            files += 1;
        }
    }
    (folders, files)
}

/// A sync comparison of a real project's shape (`$IRIS_WALK_BENCH_DIR`,
/// mirrored as empty files) on a server 5 ms (round trip) away. Run with
/// `IRIS_WALK_BENCH_DIR=… cargo test -p iris-core --release --test walk
/// project_shape_benchmark -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn project_shape_benchmark() {
    let Ok(src) = std::env::var("IRIS_WALK_BENCH_DIR") else {
        return;
    };
    let server = TestServer::start(None).await;
    let (folders, files) = mirror_shape(Path::new(&src), &server.root().join("project"));
    server.set_latency(Duration::from_micros(2500));
    let (f, session) = Fixture::new(&server).await;
    let started = Instant::now();
    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &f.local_dir(),
            "/project",
            SyncOptions::default(),
        )
        .await
        .unwrap();
    eprintln!(
        "project shape ({folders} folders, {files} files, 5 ms round trip): \
         sync compare {:?} ({} items)",
        started.elapsed(),
        plan.items.len()
    );
}

/// A folder download walks its tree concurrently and still copies every
/// file into the right folder.
#[tokio::test]
async fn a_folder_download_lists_folders_concurrently() {
    let server = TestServer::start(None).await;
    let (_, files) = make_tree(&server.root().join("tree"), 3, 3, 2, 2);
    server.set_list_delay(Duration::from_millis(20));
    let (f, session) = Fixture::new(&server).await;
    server.reset_listing_stats();
    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Download,
            items: vec![TransferItem {
                src: "/tree".into(),
            }],
            dst_dir: f.local_dir(),
        })
        .unwrap();
    let list = f
        .wait_until("every file copied", |l| {
            !f.core.has_active_transfers() && !l.jobs.is_empty()
        })
        .await;
    assert_eq!(list.jobs.len(), files);
    assert!(list
        .jobs
        .iter()
        .all(|j| j.state == iris_core::TransferState::Done));
    let max = server.max_open_dirs();
    assert!(max > 1, "listings overlapped: {max}");
    assert!(max <= iris_core::REMOTE_LISTINGS, "{max}");
    for (t, m, l) in [(0, 0, 0), (2, 2, 1)] {
        let rel = format!("tree/dir-{t}/sub-{m}/leaf-{l}/file-1.txt");
        assert_eq!(
            std::fs::read(f.local.path().join(&rel)).unwrap(),
            b"fictitious",
            "{rel}"
        );
    }
}

/// A comparison announces how far its walk got, under the plan id it was
/// given.
#[tokio::test]
async fn a_sync_comparison_reports_its_progress() {
    let server = TestServer::start(None).await;
    let (folders, files) = make_tree(&server.root().join("tree"), 3, 3, 3, 2);
    // Long enough for more than one throttled event.
    server.set_list_delay(Duration::from_millis(15));
    let (f, session) = Fixture::new(&server).await;
    let mut rx = f.core.subscribe_events();
    let plan_id = iris_core::SyncPlanId::new();
    let plan = f
        .core
        .plan_sync_as(
            plan_id,
            session,
            TransferDirection::Download,
            &f.local_dir(),
            "/tree",
            SyncOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(plan.plan_id, plan_id);
    let mut seen = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if let iris_core::CoreEvent::SyncProgress {
            plan_id: id,
            folders_scanned,
            files_seen,
        } = event
        {
            assert_eq!(id, plan_id);
            seen.push((folders_scanned, files_seen));
        }
    }
    assert!(!seen.is_empty(), "progress was reported");
    assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
    let (last_folders, last_files) = *seen.last().unwrap();
    // Both sides count: the remote tree plus the (empty) local folder.
    assert!(last_folders <= folders as u64 + 2, "{seen:?}");
    assert!(last_files <= files as u64, "{seen:?}");

    // The id is taken while the plan is kept.
    let err = f
        .core
        .plan_sync_as(
            plan_id,
            session,
            TransferDirection::Download,
            &f.local_dir(),
            "/tree",
            SyncOptions::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
}

/// One unreadable subfolder fails on its own: the rest of the tree is
/// walked, for a download (a failed placeholder to retry) and for a sync
/// comparison (the folder is skipped, so nothing under it is touched).
#[tokio::test]
async fn an_unreadable_subfolder_does_not_stop_the_walk() {
    use std::os::unix::fs::PermissionsExt;
    let server = TestServer::start(None).await;
    make_tree(&server.root().join("tree"), 3, 2, 0, 1);
    let locked = server.root().join("tree/dir-1");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let (f, session) = Fixture::new(&server).await;

    let plan = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &f.local_dir(),
            "/tree",
            SyncOptions::default(),
        )
        .await
        .unwrap();
    let item = plan.items.iter().find(|i| i.path == "dir-1").unwrap();
    assert_eq!(item.group, iris_core::SyncGroup::Skipped, "{item:?}");
    assert!(plan
        .items
        .iter()
        .any(|i| i.path == "dir-2/sub-1/file-0.txt"));
    assert!(!plan.items.iter().any(|i| i.path.starts_with("dir-1/")));

    f.core
        .enqueue_transfers(TransferRequest {
            session_id: session,
            direction: TransferDirection::Download,
            items: vec![TransferItem {
                src: "/tree".into(),
            }],
            dst_dir: f.local_dir(),
        })
        .unwrap();
    let list = f
        .wait_until("the walk to end", |l| {
            !f.core.has_active_transfers() && !l.jobs.is_empty()
        })
        .await;
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    let failed: Vec<_> = list
        .jobs
        .iter()
        .filter(|j| j.state == iris_core::TransferState::Failed)
        .collect();
    assert_eq!(failed.len(), 1, "{list:#?}");
    assert!(failed[0].folder && failed[0].src == "/tree/dir-1");
    // dir-0, dir-2 and their two subfolders each hold one file.
    let done = list
        .jobs
        .iter()
        .filter(|j| j.state == iris_core::TransferState::Done)
        .count();
    assert_eq!(done, 6, "{list:#?}");
}
