# CLAUDE.md — Iris

Guidance for AI agents (and humans) working in this repository.

## What Iris is

Iris is a cross-platform **desktop remote file manager over SSH** (in the spirit
of Forklift), built in **Rust + Tauri 2 + React + TypeScript + Vite**.
macOS-first; Windows kept in mind.

> Private on GitHub: https://github.com/RobbieMinderhoud/Iris.

## Boilerplate (shared skeleton)

Iris's shared skeleton — the Cargo workspace shape (a `*-core` crate with zero
Tauri dependency + a thin `src-tauri` IPC layer + a presentation-only React
frontend), the `justfile`, `scripts/sync-version.sh`, CI, the shared config
files, the design tokens, and the layering/IPC conventions — comes from a
standalone template:

- **Repo:** <https://github.com/RobbieMinderhoud/rust-application-boilerplate>
  (`../rust-application-boilerplate` locally). It is the **upstream** source of
  truth for the skeleton; Iris carries its domain (SSH connections, remote file
  browsing, transfers) on top.
- **Rule:** when a change here touches the **shared skeleton or conventions**
  (not Iris-specific domain code), also open a **PR against the boilerplate**
  so it stays current. App-specific code does not flow back.

## Status — v0.1

- ✅ **Phase 0 — Island shell.** Looks and feels like Podium
  (`../podium`, the reference for every UI piece; `../Selene` is a second
  one): same tokens, island layout, title bar, modals, toasts, settings dialog
  and dark/light/retro themes. The boilerplate demo (greet + notes) is gone.
  - Layout: title bar on the canvas; sidebar island (placeholder Connections
    section); Local + Remote pane islands side by side (the remote pane shows
    `WelcomeScreen`); collapsible transfer island underneath.
  - Core: `CoreError` (`io`/`config`/`invalidInput`), `CoreEvent` on a tokio
    broadcast bus (`Core::subscribe_events`, forwarded by
    `src-tauri/src/events.rs`), `IrisSettingsStore` (`settings.json` in the
    app data dir: `parallelTransfers`, `reconnectAttempts`,
    `editorOverrides`; commands `get_settings` / `save_settings`), and
    `Core::has_active_work()` for the close guard (always `false` until
    Phase 5 wires it to transfers).
  - UI prefs (theme, reduced motion, show hidden, preview cap) are
    localStorage-only (`themeStore` → `iris.theme`, `settingsStore` →
    `iris.settings`, `layoutStore` → `iris.layout`).
- 🚧 **Phase 1 — Connect & browse.** Backend done, UI pending.
  - Core: `connection/` (`ConnectionProfile` + `AuthMethod`
    `password | keyFile{path}`, kind-tagged so Phase 2 can add `agent` /
    `sshConfigHost`; `ProfileStore` → `profiles.json`, **never a secret
    field**, corrupt file moved to `profiles.json.bak`), `secret.rs`
    (`Secret`: redacted `Debug`/`Display`, no `Serialize`, zeroized on
    drop; passwords/passphrases are prompted per connect, keychain is
    Phase 2), `ssh/` (the only russh user besides `fs/sftp.rs`:
    `session.rs` connects with `nodelay`, authenticates, opens SFTP;
    `hostkey.rs` checks `known_hosts` — changed key = hard
    `hostKeyChanged`, no override path; unknown key = `HostKeyPrompt`
    event awaited via `Core::answer_host_key`, 120 s timeout = reject),
    `fs/` (`FileSystem` trait, `LocalFs`, `SftpFs`, `Entry`/`EntryKind`
    with symlink `target`/`targetKind`), `session_manager.rs`
    (`SessionId` → live session; a dropped connection removes itself and
    emits `disconnected` once).
  - `known_hosts` is **injected**: the shell sets `~/.ssh/known_hosts` in
    `setup`; a `Core` without it refuses to connect (`config`), so tests
    can never touch the real file. Tests use temp files only.
  - Tests: `crates/iris-core/tests/support/` is a hermetic in-process
    russh + russh-sftp server (127.0.0.1, ephemeral port, temp dir root,
    password + public-key auth, per-server host key); `tests/remote.rs`
    covers auth, host-key flows, listing/symlinks/hidden and the
    10,000-entry < 2 s listing.
  - IPC: `list_profiles` / `save_profile` / `delete_profile`,
    `connect` / `disconnect` / `answer_host_key`, `list_dir` / `stat` /
    `read_link` / `home_dir` (`target` = `{kind:"local"}` |
    `{kind:"remote",sessionId}`); events `profiles:changed`,
    `session:host-key-prompt`, `session:state-changed`.
- ✅ **Window chrome** (as in Podium): `App.tsx`'s `<header>` is the title
  bar on Windows and macOS (`data-tauri-drag-region` makes the strip
  draggable). Windows turns the native decorations off (`"decorations":
  false`) and draws its own minimize/maximize/close in `WindowControls.tsx`
  (polling `isMaximized()` on `onResized` to track Aero Snap). macOS keeps its
  decorations with `"titleBarStyle": "Overlay"` and `"hiddenTitle": true`, so
  the native traffic lights are drawn over the strip's top-left corner;
  `.titlebarMac` leaves 78px of room and the brand is centered. macOS also
  keeps its native *menu bar* (⌘, opens Settings via `menu:open-settings` —
  see the `setup` hook's `#[cfg(target_os = "macos")]` block); elsewhere a
  title-bar gear and Ctrl+, open it. Linux keeps its native title bar.
  `src-tauri/tauri.windows.conf.json` / `tauri.macos.conf.json` are RFC 7396
  merge patches over `tauri.conf.json` — a JSON *array* replaces wholesale,
  so each repeats the whole `windows[0]` object. The window-state plugin is
  registered without `StateFlags::DECORATIONS`, otherwise its restore
  overrides the platform config's decorations.
- ✅ **Close guard**: `CloseRequested` (red button) and `ExitRequested`
  (Cmd+Q) are blocked while `Core::has_active_work()`; the webview gets
  `window:close-requested`, shows `CloseWarningModal`, and "Close anyway"
  calls `window_confirm_close` (arms `AppState::force_close`, exits).

## Tech stack

| Concern     | Choice                                                    |
| ----------- | -------------------------------------------------------- |
| Shell / UI  | Tauri 2 + React 19 + TypeScript + Vite                   |
| Core        | Plain Rust crate, zero Tauri dependency                  |
| SSH / SFTP  | `russh` 0.64 (`ring` backend) + `russh-sftp` 3, behind `ssh/` |
| FE state    | Zustand 5 (no data-fetching lib; call IPC, then resync)  |
| Motion      | CSS tokens (`--dur-*`/`--ease-*`), reduced-motion guard  |
| Icons       | `lucide-react`, only via `src/components/icons.tsx`      |
| Tests       | `cargo test` (core + integration) · Vitest + jsdom + RTL |

## Architecture

A Cargo **workspace**. `iris-core` holds all domain logic and has **zero Tauri
dependency** (plain-`cargo test`-able). `src-tauri` is a thin IPC adapter. `src/`
is the React app (presentation only).

```
scripts/
  sync-version.sh            # propagates the version to tauri.conf.json + package.json
  next-version.sh, changelog.sh  # CI release helpers (+ *.test.sh)
crates/iris-core/src/
  lib.rs      # Core — THE single entry point (all mutation goes through it)
  error.rs    # CoreError / CoreResult + CoreError::kind (app-owned text, never secrets)
  events.rs   # CoreEvent + SessionState + EventBus (tokio broadcast)
  settings.rs # IrisSettings + IrisSettingsStore (settings.json, atomic write)
  persist.rs  # shared atomic JSON write (temp file + rename)
  ids.rs      # UUID newtypes (uuid_newtype!): ProfileId, SessionId, HostKeyRequestId
  secret.rs   # Secret: redacted, non-serializable, zeroized password/passphrase
  connection/ # ConnectionProfile + AuthMethod; store.rs = ProfileStore (profiles.json)
  ssh/        # russh wrapper: session.rs (connect/auth/SFTP), hostkey.rs (known_hosts + prompts)
  fs/         # FileSystem trait, Entry/EntryKind/FsTarget; local.rs, sftp.rs
  session_manager.rs  # SessionId → live SshSession; drop-on-close callback
crates/iris-core/tests/
  core.rs     # integration test over the public API — no UI required
  remote.rs   # connect/browse against the in-process SFTP server (unix only)
  support/    # hermetic russh + russh-sftp test server
src-tauri/
  tauri.conf.json                # base config
  tauri.{macos,windows}.conf.json  # per-OS window chrome (merge patches)
src-tauri/src/
  main.rs     # binary entry → iris_lib::run()
  lib.rs      # Tauri builder, plugins, macOS menu, close guard, commands
  state.rs    # AppState: Arc<Core> + force_close flag
  error.rs    # IpcError { kind, message } ← CoreError
  events.rs   # forwards CoreEvents to the webview (app.emit, Lagged-safe)
  commands/   # thin shims: settings.rs, connection.rs (profiles), session.rs
              # (connect/disconnect/answer_host_key), fs.rs (list_dir/stat/
              # read_link/home_dir), window.rs
src/
  App.tsx     # the shell: title bar, sidebar, Local/Remote panes, transfers
  components/ # Sidebar, PaneIsland, TransferPanel, WelcomeScreen, Modal,
              # Toasts, SettingsModal, CloseWarningModal, WindowControls,
              # StatusDot, LogoMark, icons (lucide wrapper; import from here)
  ipc/        # commands.ts (typed wrappers), types.ts (wire types), events.ts
  state/      # Zustand stores: theme, settings (UI prefs), settingsRequest,
              # layout, toast — mirror the backend; don't guess
  lib/        # framework-agnostic helpers (log, motion/usePresence, platform)
  styles/     # tokens.css (design tokens) + global.css (resets/primitives)
```

### The core contract

`Core` (`crates/iris-core/src/lib.rs`) is the **single entry point**: all domain
state and mutation live behind it. It is `Send + Sync` and cheap to share (hold
it behind an `Arc`); interior mutability keeps the public API `&self`.

### Tauri IPC contract

Commands return `Result<T, IpcError>` where `IpcError = { kind, message }`.
`kind` is a stable, machine-readable camelCase category the frontend branches
on; `message` is human-readable, sanitized, **app-owned text — never secrets**.
`CoreError` maps to `IpcError` via `From`; IPC-only failures (bad input, parse
errors) use `IpcError::new` / `IpcError::invalid_input`.

> ⚠️ **Wire casing:** everything on the wire is **camelCase** — Tauri maps
> camelCase JS argument keys to snake_case Rust parameters, and structs use
> `#[serde(rename_all = "camelCase")]`. Ids are plain UUID strings
> (`#[serde(transparent)]`). Keep the hand-written types in `src/ipc/types.ts`
> in lockstep with the Rust serde derives whenever either side changes.

### Frontend

Stores (Zustand) are the single place the UI learns about backend state: an
action calls a typed IPC wrapper, then **re-reads from the backend** so the store
mirrors the core rather than optimistically guessing. Components reference design
**tokens** (`src/styles/tokens.css`), never hard-coded colors/durations/easings.

## Build, run, test

Prefer `just` (run `just` to list recipes). The Tauri CLI is the local
`@tauri-apps/cli` dev-dependency, so use `pnpm tauri …` (no global install).

```
just dev            # run the app (Vite + Tauri, hot reload)
just build          # production bundle
just check          # cargo check --workspace
just test           # cargo test --workspace + frontend vitest
just test-core      # iris-core tests only
just lint           # clippy -D warnings + eslint
just format         # rustfmt + prettier
just version 0.2.0  # bump + sync version across all manifests (emergencies only; CI bumps on merge)
just version-check  # verify versions are in sync
```

CI (`.github/workflows/ci.yml`) is one `macos-latest` job: rustfmt, clippy
`-D warnings`, `cargo test --workspace`, then typecheck, ESLint, Vitest, and a
production `pnpm build`. A stub `dist/` is created first so
`tauri::generate_context!` compiles. A PR-only `changelog` job requires an
`## [Unreleased]` entry, and a `release` job turns every merge to `main` into a
tagged GitHub Release (see _Versioning & CI_).

## Conventions

- **Rust:** `#![forbid(unsafe_code)]` in every crate; `cargo clippy -- -D
  warnings` must pass; `cargo fmt`. Comment the _why_ of non-obvious logic.
- **Layering (always-on):** all domain logic belongs in `iris-core`; `src-tauri`
  only (de)serializes and forwards. If a command handler grows logic, move it
  down. The core must keep compiling without Tauri.
- **Security (always-on):** `CoreError`/`IpcError` messages are app-owned text —
  never terminal output, file contents, or secrets. Don't log secrets above
  `DEBUG`. In tests/fixtures use **only fictitious** sample data.
- **Motion:** timing comes from the `--dur-*` / `--ease-*` tokens — no raw
  values in components. Animate only `transform`/`opacity` in hot paths; keep
  the reduced-motion guard working.
- **Casing:** wire casing is fixed (camelCase; see the IPC contract);
  `src/ipc/types.ts` tracks the Rust serde derives.

## Versioning & CI

- **SemVer.** The `[workspace.package]` version in the root `Cargo.toml` is the
  single source of truth; `scripts/sync-version.sh` propagates it to
  `tauri.conf.json` and `package.json` (`just version-check` detects drift).
- **`CHANGELOG.md`** follows _Keep a Changelog_ and lists **only functional
  (user-facing) changes**. Every PR adds its entry under `## [Unreleased]`; the
  PR-only `changelog` job in `ci.yml` fails unless the PR touches
  `CHANGELOG.md` and that section holds at least one `- ` entry
  (`scripts/changelog.sh unreleased`). It also runs the release-script tests
  (`scripts/*.test.sh`).
- **Releasing is automatic: every merge to `main` is a release.** Before
  merging, set a `minor` or `major` label on the PR if it warrants more than a
  patch. The `release` job in `ci.yml` runs after `ci` on each push to `main`
  (its own non-cancelling `release` concurrency group; the workflow never
  cancels runs on `main`, so no merge is left without a version). It checks out
  `main` itself, not the pushed sha, so a queued second run sees the first
  one's bump; an empty `## [Unreleased]` means already released, and it exits.
  Otherwise the version is the latest `v*` tag bumped by
  `scripts/next-version.sh` — **patch by default**, `minor`/`major` when the
  merged PR carries that label (`major` wins); with no `v*` tag yet, the first
  release ships the `Cargo.toml` version as-is. It renames `## [Unreleased]` to
  `## [X.Y.Z] - date` (`scripts/changelog.sh release`), runs
  `sync-version.sh --set` and `cargo update --workspace` (Cargo.lock), commits
  `Release vX.Y.Z [skip ci]` to `main` as `github-actions[bot]`, pushes it with
  the annotated tag `vX.Y.Z` (`--atomic`), creates the GitHub Release with the
  section as notes, and dispatches `build.yml` on the tag.
- **Bundle build** (`.github/workflows/build.yml`): a matrix over macOS and
  Windows, each building natively. macOS packages the `.app` + APFS `.dmg`
  (`scripts/make-dmg.sh`); Windows the NSIS `.exe`. Runs on
  `workflow_dispatch` only; on a tag ref (the release job's dispatch) it
  attaches the installers to that tag's GitHub Release. There is deliberately
  **no tag trigger**: a deploy-key push fires workflows, and GitHub's docs don't
  say whether `[skip ci]` on the release commit also covers the tag in the same
  push, so the explicit dispatch is the one build per release. A hand-pushed
  tag builds with `gh workflow run build.yml --ref vX.Y.Z`.
- **Protected `main`** (optional, one-off setup per repo): the release job must
  push to `main`, which a ruleset requiring PRs would block (`GH013`); GitHub
  refuses the Actions app as a bypass actor on a user-owned repo (an org-owned repo can add the Actions app as a bypass actor instead), so
  `GITHUB_TOKEN` cannot get through. Create the labels `minor` and `major`,
  then add a **deploy key with write access** and its private half as the
  secret **`RELEASE_DEPLOY_KEY`**:
  `ssh-keygen -t ed25519 -N '' -C release -f release_key`,
  `gh repo deploy-key add release_key.pub --allow-write --title 'CI release'`,
  `gh secret set RELEASE_DEPLOY_KEY < release_key`, delete both key files, and
  add **DeployKey** to the `main` ruleset's bypass list. The release job checks
  out with that key, so its push goes over SSH and through the bypass. Without
  the secret, `ssh-key` is empty and `actions/checkout` falls back to
  `GITHUB_TOKEN` over HTTPS: fine for an unprotected `main`; the job's first
  step then logs a `::warning::` with these setup commands rather than failing.
  A deploy-key push triggers workflows (a `GITHUB_TOKEN` push does not), hence
  `[skip ci]` on the release commit. Rotating the key = new deploy key +
  `gh secret set RELEASE_DEPLOY_KEY`, then delete the old key.
- **Never bump the version or create a tag by hand**; `just version` is for
  emergencies only.
