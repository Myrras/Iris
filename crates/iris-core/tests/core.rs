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
