//! The desktop shell: a thin Tauri 2 IPC adapter over `iris-core`.
//!
//! This crate owns no domain logic — it (de)serializes command arguments, holds
//! the live application state, forwards work to `iris-core`, and re-emits the
//! core's lifecycle events to the webview (`events.rs`).
//!
//! ## Logging & secrets
//! Logging is configured via `tauri-plugin-log` (a global `log` logger at
//! `INFO`); `tracing` events fall through to it (the `tracing/log` feature).
//! Never log secrets or untrusted output above `DEBUG`.

#![forbid(unsafe_code)]

mod commands;
mod error;
mod events;
mod opener;
mod state;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};

use crate::state::AppState;

/// Global event the webview listens for to raise the "active work" close
/// warning. Emitted when a close/exit is blocked because the core still has
/// work in flight (see [`iris_core::Core::has_active_work`]).
const CLOSE_REQUESTED_EVENT: &str = "window:close-requested";

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Persist window size/position across runs. Decorations excluded: its
        // on_window_ready restore runs after the platform config is applied
        // and, with default StateFlags, would reassert the native title bar
        // (a persisted `"decorated": true` in .window-state.json) on every
        // launch.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS,
                )
                .build(),
        )
        // Native open-file picker (the connection form's key-file field,
        // editor apps, the "Download to…" folder).
        .plugin(tauri_plugin_dialog::init())
        // Native drag of files out of the window (Finder / Explorer). The
        // webview starts it once rows leave the window: local files as they
        // are, remote ones after `prepare_drag_out` downloaded them.
        .plugin(tauri_plugin_drag::init())
        // Logging sinks: stdout (dev), the per-OS log directory (support), and
        // the webview console (in-app diagnostics).
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .manage(AppState::new())
        // Warn before the red close button quits Iris while work is in flight.
        // `prevent_close` keeps the window; the webview shows the warning and
        // calls `window_confirm_close` to go through with it. Cmd+Q / app-quit
        // takes the `RunEvent::ExitRequested` path below instead.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.force_close.load(Ordering::SeqCst) || !state.core.has_active_work() {
                    return;
                }
                api.prevent_close();
                if let Err(e) = window.emit(CLOSE_REQUESTED_EVENT, ()) {
                    tracing::warn!("failed to emit close-requested to webview: {e}");
                }
            }
        })
        .setup(|app| {
            // macOS: native menu bar with Settings… (⌘,) in the app menu; the
            // other platforms use the in-app title-bar gear instead. The menu
            // item emits a Tauri event the frontend listens for.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

                let settings = MenuItem::with_id(
                    app,
                    "settings",
                    "Settings\u{2026}", // "Settings…"
                    true,
                    Some("CmdOrCtrl+,"),
                )?;
                let app_menu = SubmenuBuilder::new(app, "Iris")
                    .about(None)
                    .separator()
                    .item(&settings)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                // Setting a custom menu replaces the default one, so Edit must
                // be re-added or Cmd+C/V/X stop working in the webview.
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .separator()
                    .select_all()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id() == "settings" {
                        let _ = app.emit("menu:open-settings", ());
                    }
                });
            }

            let state = app.state::<AppState>();
            // Global settings and saved connections persist in the app data
            // dir.
            let data_dir = app.path().app_data_dir()?;
            state.core.set_settings_path(data_dir.join("settings.json"));
            state.core.set_profiles_path(data_dir.join("profiles.json"));
            // Host keys are checked against (and learned into) the user's
            // OpenSSH known_hosts. Without a home folder connecting reports
            // a config error instead of guessing a location.
            match iris_core::ssh::hostkey::default_known_hosts_path() {
                Some(path) => state.core.set_known_hosts_path(path),
                None => tracing::warn!("no home folder; known_hosts is not configured"),
            }
            // `~/.ssh/config` for config-host profiles and jump aliases.
            if let Some(path) = iris_core::ssh_config::default_ssh_config_path() {
                state.core.set_ssh_config_path(path);
            }
            // The user's ssh-agent, and remembered secrets in the OS
            // keychain.
            state.core.set_agent(iris_core::AgentLocation::System);
            state
                .core
                .set_secret_store(Arc::new(iris_core::KeychainStore::new()));
            // Remote edit and drag out: local copies live in the app cache
            // dir (leftovers of an earlier run are removed here); edited
            // files open in the user's editor.
            match app.path().app_cache_dir() {
                Ok(dir) => state.core.set_cache_dir(dir),
                Err(e) => tracing::warn!("no cache dir; remote edit is unavailable: {e}"),
            }
            state.core.set_opener(Arc::new(opener::DesktopOpener));
            // Forward core lifecycle events to the webview for the app's
            // whole lifetime.
            events::spawn_forwarder(app.handle().clone(), Arc::clone(&state.core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::connection::list_profiles,
            commands::connection::save_profile,
            commands::connection::delete_profile,
            commands::connection::set_secret,
            commands::connection::clear_secret,
            commands::connection::list_ssh_config_hosts,
            commands::session::connect,
            commands::session::reconnect,
            commands::session::disconnect,
            commands::session::answer_host_key,
            commands::fs::list_dir,
            commands::fs::stat,
            commands::fs::read_link,
            commands::fs::home_dir,
            commands::fs::mkdir,
            commands::fs::rename,
            commands::fs::delete,
            commands::fs::chmod,
            commands::fs::preview,
            commands::transfers::enqueue_transfers,
            commands::transfers::cancel_transfer,
            commands::transfers::retry_transfer,
            commands::transfers::cancel_batch,
            commands::transfers::resolve_conflict,
            commands::transfers::list_transfers,
            commands::transfers::clear_finished,
            commands::transfers::has_active_transfers,
            commands::edit::open_remote,
            commands::edit::resolve_edit,
            commands::edit::list_edits,
            commands::edit::close_edit,
            commands::open::open_local,
            commands::open::reveal_local,
            commands::drag_out::prepare_drag_out,
            commands::drag_out::cancel_drag_out,
            commands::drag_out::finish_drag_out,
            commands::sync::plan_sync,
            commands::sync::run_sync,
            commands::sync::discard_sync_plan,
            commands::window::window_confirm_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Quitting: stop watching edited files and delete their local
        // copies, and the files downloaded for drags out of the window.
        if let RunEvent::Exit = event {
            let core = &app_handle.state::<AppState>().core;
            core.close_all_edits();
            core.clean_drag_outs();
            return;
        }
        // Cmd+Q / app-quit path (the window's CloseRequested guard covers the
        // red close button). Warn instead of quitting while work is in
        // flight, unless the user already confirmed via
        // `window_confirm_close`.
        if let RunEvent::ExitRequested { api, .. } = event {
            let state = app_handle.state::<AppState>();
            if !state.force_close.load(Ordering::SeqCst) && state.core.has_active_work() {
                api.prevent_exit();
                if let Some(window) = app_handle.get_webview_window("main") {
                    if let Err(e) = window.emit(CLOSE_REQUESTED_EVENT, ()) {
                        tracing::warn!("failed to emit close-requested to webview: {e}");
                    }
                }
            }
        }
    });
}
