//! Integration tests: exercise the public `iris-core` API exactly as the Tauri
//! shell (or any other adapter) would — no UI required.

use iris_core::{Core, CoreError, CoreEvent, IrisSettings};

#[test]
fn settings_persist_through_the_public_api() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("settings.json");

    let core = Core::new();
    core.set_settings_path(file.clone());
    assert_eq!(core.settings(), IrisSettings::default());

    let mut rx = core.subscribe_events();
    let mut next = core.settings();
    next.parallel_transfers = 8;
    next.editor_overrides
        .insert(".Log".into(), "/usr/bin/less".into());
    let saved = core.save_settings(next).unwrap();
    assert_eq!(saved.editor_overrides.get("log").unwrap(), "/usr/bin/less");
    assert_eq!(rx.try_recv().unwrap(), CoreEvent::SettingsChanged);

    // A fresh core on the same file sees the saved document.
    let restarted = Core::new();
    restarted.set_settings_path(file);
    assert_eq!(restarted.settings(), saved);
}

#[test]
fn invalid_settings_are_rejected() {
    let core = Core::new();
    let bad = IrisSettings {
        reconnect_attempts: 1000,
        ..IrisSettings::default()
    };
    assert!(matches!(
        core.save_settings(bad),
        Err(CoreError::InvalidInput(_))
    ));
}

// -- Local file operations ------------------------------------------------------

mod local_ops {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use iris_core::{Core, CoreError, CoreResult, FsTarget, Preview, Trash};

    /// Remembers what was trashed and deletes it from the temp dir, so the
    /// real Trash is never touched.
    #[derive(Default)]
    struct FakeTrash {
        trashed: Mutex<Vec<PathBuf>>,
    }

    impl Trash for FakeTrash {
        fn trash(&self, path: &Path) -> CoreResult<()> {
            let meta = std::fs::symlink_metadata(path)
                .map_err(|e| CoreError::from_io_at(e, &path.to_string_lossy()))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(path)?;
            } else {
                std::fs::remove_file(path)?;
            }
            self.trashed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn delete_trashes_each_path_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let folder = dir.path().join("folder");
        std::fs::write(&a, "x").unwrap();
        std::fs::create_dir_all(folder.join("inner")).unwrap();
        let missing = dir.path().join("missing");

        let trash = Arc::new(FakeTrash::default());
        let core = Core::new();
        core.set_trash(trash.clone());
        let report = core
            .delete(FsTarget::Local, &[s(&a), s(&missing), s(&folder)])
            .await
            .unwrap();

        assert_eq!(report.succeeded, vec![s(&a), s(&folder)]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].path, s(&missing));
        assert_eq!(report.failed[0].kind, "notFound");
        assert_eq!(*trash.trashed.lock().unwrap(), vec![a, folder]);
    }

    #[tokio::test]
    async fn the_root_is_never_deleted() {
        let trash = Arc::new(FakeTrash::default());
        let core = Core::new();
        core.set_trash(trash.clone());
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let report = core
            .delete(FsTarget::Local, &[root.to_string()])
            .await
            .unwrap();
        assert!(report.succeeded.is_empty());
        assert_eq!(report.failed[0].kind, "invalidInput");
        assert!(trash.trashed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn mkdir_rename_and_preview_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::new();
        let folder = dir.path().join("untitled folder");
        core.mkdir(FsTarget::Local, &s(&folder)).await.unwrap();
        assert!(matches!(
            core.mkdir(FsTarget::Local, &s(&folder)).await,
            Err(CoreError::AlreadyExists(_))
        ));
        let renamed = dir.path().join("Reports");
        core.rename(FsTarget::Local, &s(&folder), &s(&renamed))
            .await
            .unwrap();
        assert!(renamed.is_dir());

        let note = renamed.join("q3.txt");
        std::fs::write(&note, "fictional numbers").unwrap();
        assert_eq!(
            core.preview(FsTarget::Local, &s(&note), 8).await.unwrap(),
            Preview::Text {
                text: "fictiona".into(),
                truncated: true,
                total_size: 17,
            }
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn chmod_reports_per_path_and_validates_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.sh");
        std::fs::write(&a, "").unwrap();
        let core = Core::new();
        let missing = s(&dir.path().join("missing"));
        let report = core
            .chmod(FsTarget::Local, &[s(&a), missing.clone()], 0o750, false)
            .await
            .unwrap();
        assert_eq!(report.succeeded, vec![s(&a)]);
        assert_eq!(report.failed[0].path, missing);
        assert_eq!(
            std::fs::metadata(&a).unwrap().permissions().mode() & 0o7777,
            0o750
        );
        assert!(matches!(
            core.chmod(FsTarget::Local, &[s(&a)], 0o17777, false).await,
            Err(CoreError::InvalidInput(_))
        ));
    }
}

// -- Open local files and reveal ----------------------------------------------

mod open_local {
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use iris_core::{Core, CoreResult, IrisSettings, Opener};

    /// Records what it was asked to open or reveal; nothing is launched.
    #[derive(Default)]
    struct FakeOpener {
        opened: Mutex<Vec<(PathBuf, Option<String>)>>,
        revealed: Mutex<Vec<PathBuf>>,
    }

    impl Opener for FakeOpener {
        fn open(&self, path: &Path, app: Option<&str>) -> CoreResult<()> {
            self.opened
                .lock()
                .unwrap()
                .push((path.to_path_buf(), app.map(str::to_string)));
            Ok(())
        }

        fn reveal(&self, path: &Path) -> CoreResult<()> {
            self.revealed.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }
    }

    fn core() -> (Core, Arc<FakeOpener>, tempfile::TempDir) {
        let core = Core::new();
        let opener = Arc::new(FakeOpener::default());
        core.set_opener(opener.clone());
        core.save_settings(IrisSettings {
            editor_overrides: [(
                "csv".to_string(),
                "/Applications/Fictional Sheets.app".into(),
            )]
            .into(),
            ..IrisSettings::default()
        })
        .unwrap();
        (core, opener, tempfile::tempdir().unwrap())
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn opens_with_the_override_for_the_extension_or_the_os_default() {
        let (core, opener, dir) = core();
        let csv = dir.path().join("Data.CSV");
        let txt = dir.path().join("notes.txt");
        std::fs::write(&csv, "a,b\n").unwrap();
        std::fs::write(&txt, "x").unwrap();

        core.open_local(&s(&csv)).unwrap();
        core.open_local(&s(&txt)).unwrap();
        // "Open with default app" skips the override.
        core.open_local_default(&s(&csv)).unwrap();

        assert_eq!(
            *opener.opened.lock().unwrap(),
            vec![
                (
                    csv.clone(),
                    Some("/Applications/Fictional Sheets.app".into())
                ),
                (txt, None),
                (csv, None),
            ]
        );
    }

    #[test]
    fn opens_an_application_bundle_but_not_a_folder() {
        let (core, opener, dir) = core();
        let app = dir.path().join("Fictional.app");
        let folder = dir.path().join("folder");
        std::fs::create_dir(&app).unwrap();
        std::fs::create_dir(&folder).unwrap();

        core.open_local(&s(&app)).unwrap();
        assert_eq!(opener.opened.lock().unwrap().len(), 1);

        let err = core.open_local(&s(&folder)).unwrap_err();
        assert_eq!(err.kind(), "invalidInput");
        assert_eq!(opener.opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn refuses_missing_and_relative_paths_without_calling_the_opener() {
        let (core, opener, dir) = core();
        let missing = dir.path().join("gone.txt");

        let err = core.open_local(&s(&missing)).unwrap_err();
        assert_eq!(err.kind(), "notFound");
        // The message names the file, not the folder it was in.
        assert_eq!(err.to_string(), "not found: gone.txt");
        assert_eq!(
            core.open_local("notes.txt").unwrap_err().kind(),
            "invalidInput"
        );
        assert_eq!(
            core.open_local("../notes.txt").unwrap_err().kind(),
            "invalidInput"
        );
        assert_eq!(
            core.open_local_default("").unwrap_err().kind(),
            "invalidInput"
        );
        assert_eq!(
            core.reveal_local("notes.txt").unwrap_err().kind(),
            "invalidInput"
        );
        assert_eq!(
            core.reveal_local(&s(&missing)).unwrap_err().kind(),
            "notFound"
        );

        assert!(opener.opened.lock().unwrap().is_empty());
        assert!(opener.revealed.lock().unwrap().is_empty());
    }

    #[test]
    fn reveal_hands_files_and_folders_to_the_opener() {
        let (core, opener, dir) = core();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();

        core.reveal_local(&s(&file)).unwrap();
        core.reveal_local(&s(dir.path())).unwrap();

        assert_eq!(
            *opener.revealed.lock().unwrap(),
            vec![file, dir.path().to_path_buf()]
        );
    }

    #[test]
    fn a_bare_core_cannot_open_or_reveal() {
        let core = Core::new();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(core.open_local(&s(&file)).unwrap_err().kind(), "config");
        assert_eq!(core.reveal_local(&s(&file)).unwrap_err().kind(), "config");
    }
}
