//! Integration tests for dragging remote files out of the window: the
//! selection is downloaded into `<cacheDir>/dragout/<dragId>/` first (size
//! and file-count limits checked up front), then handed to the OS drag.
//! Runs against the hermetic in-process SFTP server in `support/` with a
//! temp cache dir. All data is fictitious.

#![cfg(unix)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use iris_core::{
    AuthMethod, ConnectionProfile, Core, CoreError, CoreEvent, DragOutId, DragOutLimits,
    IrisSettings, ProfileId, Secret, SecretKind, SessionId,
};
use tempfile::TempDir;

use support::{TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(20);

struct Fixture {
    core: Arc<Core>,
    cache: TempDir,
    profile: ProfileId,
    progress: Arc<Mutex<Vec<(DragOutId, u64, u64)>>>,
    _dir: TempDir,
}

impl Fixture {
    fn new(server: &TestServer) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        std::fs::write(&known_hosts, server.known_hosts_line()).unwrap();
        let core = Arc::new(Core::new());
        core.set_known_hosts_path(known_hosts);
        let cache = tempfile::tempdir().unwrap();
        core.set_cache_dir(cache.path().to_path_buf());
        core.save_settings(IrisSettings {
            reconnect_attempts: 0,
            ..IrisSettings::default()
        })
        .unwrap();
        let profile = core
            .save_profile(ConnectionProfile {
                id: ProfileId::new(),
                name: "Drag-out test".into(),
                host: HOST.into(),
                port: server.port,
                user: USER.into(),
                auth: AuthMethod::Password,
                start_dir: None,
                jump: None,
                favorites: Vec::new(),
            })
            .unwrap()
            .id;
        core.set_secret(profile, SecretKind::Password, Secret::new(PASSWORD))
            .unwrap();

        let progress = Arc::new(Mutex::new(Vec::new()));
        let mut rx = core.subscribe_events();
        let sink = Arc::clone(&progress);
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if let CoreEvent::DragOutProgress {
                    drag_id,
                    bytes_done,
                    total_bytes,
                } = event
                {
                    sink.lock()
                        .unwrap()
                        .push((drag_id, bytes_done, total_bytes));
                }
            }
        });
        Self {
            core,
            cache,
            profile,
            progress,
            _dir: dir,
        }
    }

    async fn connect(&self) -> SessionId {
        self.core.connect(self.profile, None, None).await.unwrap()
    }

    fn drag_root(&self) -> PathBuf {
        std::fs::canonicalize(self.cache.path())
            .unwrap()
            .join("dragout")
    }

    /// The preparations still on disk.
    fn leftovers(&self) -> Vec<PathBuf> {
        match std::fs::read_dir(self.drag_root()) {
            Ok(dir) => dir.map(|e| e.unwrap().path()).collect(),
            Err(_) => Vec::new(),
        }
    }

    async fn wait_gone(&self, what: &str) {
        let deadline = Instant::now() + WAIT;
        while !self.leftovers().is_empty() {
            assert!(Instant::now() < deadline, "{what}: {:?}", self.leftovers());
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

/// Deterministic sample bytes.
fn data(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

fn mtime(path: &Path) -> i64 {
    std::fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn set_mtime(path: &Path, secs: u64) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap();
}

#[tokio::test]
async fn files_and_folders_are_downloaded_into_the_drag_folder() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server);
    let session = f.connect().await;
    let root = server.root();
    let report = data(700_000, 1);
    std::fs::write(root.join("report.pdf"), &report).unwrap();
    set_mtime(&root.join("report.pdf"), 1_700_000_000);
    std::fs::create_dir_all(root.join("photos/2024")).unwrap();
    std::fs::write(root.join("photos/cover.jpg"), data(30_000, 2)).unwrap();
    std::fs::write(root.join("photos/2024/beach.jpg"), data(40_000, 3)).unwrap();
    // Links inside a folder are not followed (they could loop).
    std::os::unix::fs::symlink("..", root.join("photos/up")).unwrap();

    let id = DragOutId::new();
    let ready = f
        .core
        .prepare_drag_out(id, session, vec!["/report.pdf".into(), "/photos".into()])
        .await
        .unwrap();

    let dir = f.drag_root().join(id.to_string());
    assert_eq!(
        ready.paths,
        vec![
            dir.join("report.pdf").to_string_lossy().into_owned(),
            dir.join("photos").to_string_lossy().into_owned(),
        ]
    );
    assert_eq!(ready.files, 3);
    assert_eq!(ready.total_bytes, 770_000);
    assert_eq!(std::fs::read(dir.join("report.pdf")).unwrap(), report);
    assert_eq!(mtime(&dir.join("report.pdf")), 1_700_000_000);
    assert_eq!(
        std::fs::read(dir.join("photos/2024/beach.jpg")).unwrap(),
        data(40_000, 3)
    );
    assert_eq!(
        std::fs::read(dir.join("photos/cover.jpg")).unwrap(),
        data(30_000, 2)
    );
    assert!(!dir.join("photos/up").exists(), "folder links are skipped");

    // Progress for this drag only, ending at the total.
    let deadline = Instant::now() + WAIT;
    loop {
        let progress = f.progress.lock().unwrap().clone();
        if progress.last().map(|p| p.1) == Some(770_000) {
            assert!(progress.iter().all(|p| p.0 == id && p.2 == 770_000));
            assert!(progress.windows(2).all(|w| w[0].1 <= w[1].1));
            break;
        }
        assert!(Instant::now() < deadline, "progress: {progress:?}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Cancelled (not dropped): removed at once.
    f.core.finish_drag_out(id, false);
    assert!(f.leftovers().is_empty(), "{:?}", f.leftovers());
}

#[tokio::test]
async fn a_selection_over_the_limits_is_refused_before_downloading() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server);
    let session = f.connect().await;
    std::fs::create_dir(server.root().join("logs")).unwrap();
    for i in 0..5 {
        std::fs::write(
            server.root().join(format!("logs/day-{i}.log")),
            data(1000, i),
        )
        .unwrap();
    }

    f.core.set_drag_out_limits(DragOutLimits {
        max_bytes: 1_000_000,
        max_files: 4,
    });
    let err = f
        .core
        .prepare_drag_out(DragOutId::new(), session, vec!["/logs".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::TooLarge(_)), "{err:?}");
    assert_eq!(err.kind(), "tooLarge");
    assert!(f.leftovers().is_empty(), "{:?}", f.leftovers());

    f.core.set_drag_out_limits(DragOutLimits {
        max_bytes: 4_999,
        max_files: 500,
    });
    let err = f
        .core
        .prepare_drag_out(DragOutId::new(), session, vec!["/logs".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::TooLarge(_)), "{err:?}");
    assert!(
        f.progress.lock().unwrap().is_empty(),
        "nothing was downloaded"
    );

    // Exactly at the limits is fine.
    f.core.set_drag_out_limits(DragOutLimits {
        max_bytes: 5_000,
        max_files: 5,
    });
    let ready = f
        .core
        .prepare_drag_out(DragOutId::new(), session, vec!["/logs".into()])
        .await
        .unwrap();
    assert_eq!((ready.files, ready.total_bytes), (5, 5_000));
}

#[tokio::test]
async fn a_cancelled_preparation_stops_and_leaves_nothing_behind() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server);
    let session = f.connect().await;
    std::fs::write(server.root().join("video.mov"), data(3_000_000, 4)).unwrap();
    server.set_io_delay(Duration::from_millis(20));

    let id = DragOutId::new();
    let core = Arc::clone(&f.core);
    let preparing = tokio::spawn(async move {
        core.prepare_drag_out(id, session, vec!["/video.mov".into()])
            .await
    });
    // Wait for the download to be under way, then cancel.
    let deadline = Instant::now() + WAIT;
    while f.progress.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    f.core.cancel_drag_out(id);
    let err = preparing.await.unwrap().unwrap_err();
    assert!(matches!(err, CoreError::Cancelled), "{err:?}");
    assert!(f.leftovers().is_empty(), "{:?}", f.leftovers());
}

#[tokio::test]
async fn a_dropped_drag_is_cleaned_up_after_the_grace_period_and_on_quit() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server);
    let session = f.connect().await;
    std::fs::write(server.root().join("notes.txt"), b"fictional notes").unwrap();
    f.core.set_drag_out_grace(Duration::from_millis(100));

    let dropped = DragOutId::new();
    f.core
        .prepare_drag_out(dropped, session, vec!["/notes.txt".into()])
        .await
        .unwrap();
    let started = Instant::now();
    f.core.finish_drag_out(dropped, true);
    // The file manager that took the drop may still be copying.
    assert_eq!(f.leftovers().len(), 1);
    f.wait_gone("the grace period ends").await;
    assert!(started.elapsed() >= Duration::from_millis(100));

    // Quitting removes what is still there.
    f.core
        .prepare_drag_out(DragOutId::new(), session, vec!["/notes.txt".into()])
        .await
        .unwrap();
    assert_eq!(f.leftovers().len(), 1);
    f.core.clean_drag_outs();
    assert!(f.leftovers().is_empty());
}

#[tokio::test]
async fn leftovers_of_an_earlier_run_are_removed_at_startup() {
    let cache = tempfile::tempdir().unwrap();
    let stale = cache
        .path()
        .join("dragout/0b3c2a52-7a47-4c1f-9a4e-0a3c2b1d9e8f");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("old.bin"), b"left behind").unwrap();
    let core = Core::new();
    core.set_cache_dir(cache.path().to_path_buf());
    assert!(!cache.path().join("dragout").exists());
}

#[tokio::test]
async fn preparing_needs_a_session_a_cache_dir_and_safe_items() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server);
    let err = f
        .core
        .prepare_drag_out(DragOutId::new(), SessionId::new(), vec!["/a".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotConnected), "{err:?}");

    let session = f.connect().await;
    let err = f
        .core
        .prepare_drag_out(DragOutId::new(), session, vec!["/missing.txt".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "{err:?}");
    let err = f
        .core
        .prepare_drag_out(DragOutId::new(), session, Vec::new())
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::InvalidInput(_)), "{err:?}");
    assert!(f.leftovers().is_empty());

    let bare = Core::new();
    let err = bare
        .prepare_drag_out(DragOutId::new(), session, vec!["/a".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::Config(_)), "{err:?}");
}

#[tokio::test]
async fn the_same_drag_id_cannot_be_prepared_twice_at_once() {
    let server = TestServer::start(None).await;
    let f = Fixture::new(&server);
    let session = f.connect().await;
    std::fs::write(server.root().join("big.iso"), data(2_000_000, 5)).unwrap();
    server.set_io_delay(Duration::from_millis(20));
    let id = DragOutId::new();
    let core = Arc::clone(&f.core);
    let first = tokio::spawn(async move {
        core.prepare_drag_out(id, session, vec!["/big.iso".into()])
            .await
    });
    let deadline = Instant::now() + WAIT;
    while f.progress.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "no progress");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let err = f
        .core
        .prepare_drag_out(id, session, vec!["/big.iso".into()])
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::InvalidInput(_)), "{err:?}");
    f.core.cancel_drag_out(id);
    assert!(first.await.unwrap().is_err());
}
