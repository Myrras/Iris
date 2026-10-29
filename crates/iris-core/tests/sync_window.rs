//! Integration tests for syncs limited to recently changed files
//! ("Only files changed in"), against the hermetic in-process server in
//! `support/`: the local filtered walk with target lookups only, the
//! server search (a scripted `find` answer: the test server runs no
//! commands), its clock skew, and the fallback to a filtered SFTP walk.
//! All data is fictitious.

#![cfg(unix)]

mod support;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use iris_core::{
    AuthMethod, ChangedWithin, CompareRule, ConnectionProfile, Core, CoreEvent, ProfileId,
    SearchMethod, Secret, SessionId, SyncGroup, SyncMode, SyncOptions, SyncPlan, SyncScanStage,
    TransferDirection,
};
use tempfile::TempDir;

use support::{ExecResponder, TestServer, HOST, PASSWORD, USER};

const WAIT: Duration = Duration::from_secs(30);
/// The window starts here; "old" files are before it.
const SINCE: u64 = 1_600_000_000;
const REMOTE_DIR: &str = "/site";

struct Fixture {
    core: Arc<Core>,
    local: TempDir,
    events: Arc<Mutex<Vec<CoreEvent>>>,
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
                name: "Window test".into(),
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

    /// Run `plan` with its defaults; `(copied, failed)` once it is over.
    async fn run(&self, plan: &SyncPlan) -> (usize, usize) {
        self.core.run_sync(plan.plan_id, None).await.unwrap();
        let deadline = Instant::now() + WAIT;
        loop {
            let found = self.events.lock().unwrap().iter().find_map(|e| match e {
                CoreEvent::SyncFinished {
                    plan_id,
                    copied,
                    failed,
                    ..
                } if *plan_id == plan.plan_id => Some((*copied, *failed)),
                _ => None,
            });
            if let Some(found) = found {
                return found;
            }
            assert!(Instant::now() < deadline, "the sync never finished");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// The stages of the progress events seen so far, deduplicated.
    fn stages(&self) -> Vec<SyncScanStage> {
        let mut stages: Vec<SyncScanStage> = Vec::new();
        for event in self.events.lock().unwrap().iter() {
            if let CoreEvent::SyncProgress { stage, .. } = event {
                if stages.last() != Some(stage) {
                    stages.push(*stage);
                }
            }
        }
        stages
    }
}

fn write(path: &Path, content: &[u8], mtime: u64) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(mtime))
        .unwrap();
}

fn window(since: u64) -> SyncOptions {
    SyncOptions {
        changed_within: Some(ChangedWithin {
            since_unix: since as i64,
        }),
        ..SyncOptions::default()
    }
}

fn groups(plan: &SyncPlan) -> Vec<(String, SyncGroup)> {
    plan.items
        .iter()
        .map(|i| (i.path.clone(), i.group))
        .collect()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// A stand-in for the server's shell: `date +%s` answers our clock moved
/// by `skew`; `sh` gets the search script and answers what GNU `find`
/// would print for it, from the server's real folder (the root, the
/// cutoff and the `-name` prunes are read from the script). Every script
/// it was given is kept.
fn fake_find(server: &TestServer, skew: i64, scripts: Arc<Mutex<Vec<String>>>) -> ExecResponder {
    let base = server.root().to_path_buf();
    Arc::new(move |command: &str, stdin: &[u8]| match command {
        "date +%s" => Some((format!("{}\n", now() + skew).into_bytes(), 0)),
        "sh" => {
            let script = String::from_utf8(stdin.to_vec()).unwrap();
            scripts.lock().unwrap().push(script.clone());
            let root = between(&script, "find -H '", "' -mindepth").unwrap();
            let newer: i64 = between(&script, "-type f -newermt @", " ")
                .unwrap()
                .parse()
                .unwrap();
            let head = between(&script, "-mindepth 1 ", "-type d").unwrap();
            let prunes: Vec<String> = head
                .split("-name '")
                .skip(1)
                .map(|rest| rest.split('\'').next().unwrap().to_string())
                .collect();
            let mut out = b"IRIS-FIND\0".to_vec();
            let real = base.join(root.trim_start_matches('/'));
            emit(&real, "", newer, &prunes, &mut out);
            out.extend_from_slice(b"IRIS-END\x000\0");
            Some((out, 0))
        }
        _ => None,
    })
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = text.find(start)? + start.len();
    let len = text[from..].find(end)?;
    Some(&text[from..from + len])
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime()
}

/// What the script's `find` prints below `dir` (`rel` = its `%P`).
fn emit(dir: &Path, rel: &str, newer: i64, prunes: &[String], out: &mut Vec<u8>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if prunes
            .iter()
            .any(|p| p == &name || (p == ".*" && name.starts_with('.')))
        {
            continue;
        }
        let path = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let meta = std::fs::symlink_metadata(entry.path()).unwrap();
        let mut record = |fields: [&str; 4]| {
            for field in fields {
                out.extend_from_slice(field.as_bytes());
                out.push(0);
            }
        };
        let mtime = format!("{}.0000000000", mtime_of(&meta));
        if meta.file_type().is_symlink() {
            let kind = match std::fs::metadata(entry.path()) {
                Ok(m) if m.is_dir() => "d",
                Ok(_) => "f",
                Err(_) => "N",
            };
            record(["L", &path, kind, &mtime]);
        } else if meta.is_dir() {
            emit(&entry.path(), &path, newer, prunes, out);
        } else if mtime_of(&meta) > newer {
            record(["F", &path, &meta.len().to_string(), &mtime]);
        }
    }
}

#[tokio::test]
async fn an_upload_within_a_window_looks_up_only_the_changed_files() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    write(&local.join("new.txt"), b"brand new", SINCE + 10);
    write(&local.join("changed.txt"), b"version two", SINCE + 20);
    write(&local.join("docs/fresh.md"), b"# fresh", SINCE + 5);
    write(&local.join("old.txt"), b"untouched", SINCE - 100);
    write(&local.join("node_modules/dep.js"), b"excluded", SINCE + 30);
    write(&remote.join("changed.txt"), b"version one", SINCE - 50);
    write(
        &remote.join("old.txt"),
        b"other text, never compared",
        SINCE - 500,
    );
    for i in 0..20 {
        write(&remote.join(format!("lots/{i}.txt")), b"remote only", SINCE);
    }
    std::fs::create_dir_all(remote.join("docs")).unwrap();
    server.reset_listing_stats();

    let plan = f
        .plan(session, TransferDirection::Upload, window(SINCE))
        .await;
    assert_eq!(
        groups(&plan),
        vec![
            ("changed.txt".into(), SyncGroup::Changed),
            ("docs/fresh.md".into(), SyncGroup::New),
            ("new.txt".into(), SyncGroup::New),
        ]
    );
    let info = plan.window.unwrap();
    assert_eq!(info.since_unix, SINCE as i64);
    assert_eq!(info.method, SearchMethod::Walk);
    assert_eq!(info.clock_skew_secs, None);
    // The target was only looked up: no folder of it was listed, and no
    // command was run (the source is local).
    assert_eq!(server.listings(), 0);
    assert!(server.exec_commands().is_empty());
    assert_eq!(
        f.stages(),
        vec![SyncScanStage::Scanning, SyncScanStage::Checking]
    );

    let (copied, failed) = f.run(&plan).await;
    assert_eq!((copied, failed), (3, 0));
    assert_eq!(
        std::fs::read(remote.join("changed.txt")).unwrap(),
        b"version two"
    );
    assert_eq!(
        std::fs::read(remote.join("docs/fresh.md")).unwrap(),
        b"# fresh"
    );
    assert!(!remote.join("node_modules").exists());
    assert_eq!(
        std::fs::read(remote.join("old.txt")).unwrap(),
        b"other text, never compared"
    );
}

#[tokio::test]
async fn the_compare_rule_still_decides_within_the_window() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    // Changed within the window, but the server copy is newer still.
    write(&local.join("a.txt"), b"local", SINCE + 10);
    write(&remote.join("a.txt"), b"server", SINCE + 3600);
    // Same date, another size.
    write(&local.join("b.txt"), b"longer local", SINCE + 10);
    write(&remote.join("b.txt"), b"short", SINCE + 10);
    let options = SyncOptions {
        rule: CompareRule::NewerOnly,
        ..window(SINCE)
    };
    let plan = f.plan(session, TransferDirection::Upload, options).await;
    assert_eq!(
        groups(&plan),
        vec![
            ("a.txt".into(), SyncGroup::TargetNewer),
            ("b.txt".into(), SyncGroup::DifferentSizeSameDate),
        ]
    );
}

#[tokio::test]
async fn a_download_without_commands_walks_with_the_filter() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    write(&remote.join("report.txt"), b"quarterly numbers", SINCE + 60);
    write(&remote.join("img/logo.svg"), b"<svg/>", SINCE + 5);
    write(&remote.join("archive/2019.txt"), b"old", SINCE - 1);
    write(&remote.join(".git/HEAD"), b"ref", SINCE + 10);
    write(&local.join("report.txt"), b"draft", SINCE - 100);
    write(&local.join("notes.txt"), b"mine", SINCE + 10);
    server.reset_listing_stats();

    let plan = f
        .plan(session, TransferDirection::Download, window(SINCE))
        .await;
    assert_eq!(
        groups(&plan),
        vec![
            ("img".into(), SyncGroup::New),
            ("img/logo.svg".into(), SyncGroup::New),
            ("report.txt".into(), SyncGroup::Changed),
        ]
    );
    let info = plan.window.unwrap();
    assert_eq!(info.method, SearchMethod::Walk);
    assert_eq!(info.clock_skew_secs, None);
    // The clock was asked for and refused, so no search was tried.
    assert_eq!(server.exec_commands(), vec!["date +%s".to_string()]);
    assert!(server.listings() > 0, "walked over SFTP");

    let (copied, failed) = f.run(&plan).await;
    assert_eq!((copied, failed), (2, 0));
    assert_eq!(
        std::fs::read(local.join("report.txt")).unwrap(),
        b"quarterly numbers"
    );
    assert!(!local.join("archive").exists());
    assert!(local.join("notes.txt").exists());
}

#[tokio::test]
async fn a_download_searches_the_server_and_follows_its_clock() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let local = f.local.path();
    let remote = server.root().join("site");
    // The server's clock is ten minutes ahead: its "since" is SINCE + 600.
    let skew = 600;
    write(&remote.join("new.txt"), b"brand new", SINCE + 700);
    write(&remote.join("docs/deep.txt"), b"deep", SINCE + 601);
    write(
        &remote.join("early.txt"),
        b"before the server's cutoff",
        SINCE + 300,
    );
    write(
        &remote.join("node_modules/dep.js"),
        b"excluded",
        SINCE + 900,
    );
    write(&remote.join("target.txt"), b"linked", SINCE + 800);
    std::os::unix::fs::symlink("target.txt", remote.join("link.txt")).unwrap();
    std::os::unix::fs::symlink("docs", remote.join("docs-link")).unwrap();
    write(&local.join("new.txt"), b"older local", SINCE);
    let scripts = Arc::new(Mutex::new(Vec::new()));
    server.set_exec(Some(fake_find(&server, skew, Arc::clone(&scripts))));
    server.reset_listing_stats();

    let plan = f
        .plan(session, TransferDirection::Download, window(SINCE))
        .await;
    let info = plan.window.unwrap();
    assert_eq!(info.method, SearchMethod::ServerFind);
    let measured = info.clock_skew_secs.unwrap();
    assert!((skew - 2..=skew + 2).contains(&measured), "{measured}");
    let script = scripts.lock().unwrap()[0].clone();
    assert!(
        script.contains(&format!("-newermt @{}", SINCE as i64 + measured - 1)),
        "{script}"
    );
    assert!(script.contains("-name 'node_modules'"), "{script}");
    assert_eq!(
        groups(&plan),
        vec![
            ("docs".into(), SyncGroup::New),
            ("docs/deep.txt".into(), SyncGroup::New),
            // Made just now: its own date is within the window.
            ("docs-link".into(), SyncGroup::Skipped),
            ("link.txt".into(), SyncGroup::New),
            ("new.txt".into(), SyncGroup::Changed),
            ("target.txt".into(), SyncGroup::New),
        ]
    );
    // No SFTP walk: only lookups (the link's target) went over SFTP.
    assert_eq!(server.listings(), 0);
    assert_eq!(server.exec_commands(), vec!["date +%s", "sh"]);
    assert_eq!(
        f.stages(),
        vec![SyncScanStage::Searching, SyncScanStage::Checking]
    );

    let (copied, failed) = f.run(&plan).await;
    assert_eq!((copied, failed), (4, 0));
    assert_eq!(std::fs::read(local.join("new.txt")).unwrap(), b"brand new");
    assert_eq!(std::fs::read(local.join("link.txt")).unwrap(), b"linked");
    assert!(!local.join("early.txt").exists());
    assert!(!local.join("node_modules").exists());
}

#[tokio::test]
async fn an_unusable_server_search_falls_back_to_the_walk() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let remote = server.root().join("site");
    write(&remote.join("new.txt"), b"brand new", SINCE + 10);
    write(&remote.join("old.txt"), b"old", SINCE - 10);
    // BusyBox: `find: unrecognized: -printf`, so find exits 1 at once.
    let busybox: ExecResponder = Arc::new(|command: &str, _stdin: &[u8]| match command {
        "date +%s" => Some((format!("{}\n", now()).into_bytes(), 0)),
        "sh" => Some((b"IRIS-FIND\0IRIS-END\x001\0".to_vec(), 0)),
        _ => None,
    });
    server.set_exec(Some(busybox));
    let plan = f
        .plan(session, TransferDirection::Download, window(SINCE))
        .await;
    let info = plan.window.unwrap();
    assert_eq!(info.method, SearchMethod::Walk);
    assert_eq!(info.clock_skew_secs, None, "the clocks agree");
    assert_eq!(groups(&plan), vec![("new.txt".into(), SyncGroup::New)]);
    assert!(server.listings() > 0);

    // Output that stops halfway (a dropped pipe) is no better.
    let cut: ExecResponder = Arc::new(|command: &str, _stdin: &[u8]| match command {
        "date +%s" => Some((b"garbage\n".to_vec(), 0)),
        "sh" => Some((b"IRIS-FIND\0F\0new.txt\0".to_vec(), 0)),
        _ => None,
    });
    server.set_exec(Some(cut));
    let plan = f
        .plan(session, TransferDirection::Download, window(SINCE))
        .await;
    assert_eq!(plan.window.unwrap().method, SearchMethod::Walk);
    assert_eq!(groups(&plan), vec![("new.txt".into(), SyncGroup::New)]);
}

#[tokio::test]
async fn mirror_and_future_windows_are_refused() {
    let server = TestServer::start(None).await;
    let (f, session) = Fixture::new(&server).await;
    let mirror = SyncOptions {
        mode: SyncMode::Mirror,
        ..window(SINCE)
    };
    let err = f
        .core
        .plan_sync(
            session,
            TransferDirection::Upload,
            &f.local_dir(),
            REMOTE_DIR,
            mirror,
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
    assert!(err.to_string().contains("Mirror"), "{err}");
    let future = window(now() as u64 + 3600);
    let err = f
        .core
        .plan_sync(
            session,
            TransferDirection::Download,
            &f.local_dir(),
            REMOTE_DIR,
            future,
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "invalidInput");
}
