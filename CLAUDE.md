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
frontend), the `justfile`, CI (shared via ci-workflows), the shared config
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
    `editorOverrides`, `syncExcludes`; commands `get_settings` / `save_settings`), and
    `Core::has_active_work()` for the close guard (= active transfers since
    Phase 4).
  - UI prefs (theme, reduced motion, show hidden, preview cap) are
    localStorage-only (`themeStore` → `iris.theme`, `settingsStore` →
    `iris.settings`, `layoutStore` → `iris.layout`).
- ✅ **Phase 1 — Connect & browse.** Backend and UI done.
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
  - UI: `useCoreEvents` (mounted once in `App`) feeds the events into
    `profilesStore` / `sessionStore` / `promptStore`. `ConnectionSidebar`
    lists profiles (`ConnectionRow` + `StatusDot` from the latest session;
    click connects or shows the live session; context menu connect /
    disconnect / edit / delete-with-confirm). `ConnectionForm` (opened via
    `connectionFormStore`) validates inline (`lib/connectionForm.ts`
    mirrors `ConnectionProfile::normalized`); the key file comes from the
    native picker (`@tauri-apps/plugin-dialog`, `dialog:default`).
    `lib/connect.ts` is the one connect flow: password profiles prompt
    first, key files prompt for a passphrase only on `passphraseRequired`;
    a wrong secret keeps `SecretPrompt` open, `hostKeyChanged` raises the
    blocking `HostKeyChangedDialog`. `promptStore` is a queue rendered by
    `PromptHost`; host-key prompts jump ahead of secret prompts (a busy
    password prompt would otherwise block its own connect) and are dropped
    when their session turns `disconnected` (backend timeout). Secrets live
    only in `SecretPrompt`'s local state and are cleared on submit.
  - Panes: `Pane` (Local/Remote) + `paneStore` (per pane: target, path,
    entries, sort, filter, hidden override, selection/anchor/cursor, Back
    history; listings are tokened so a stale one never wins; a failed
    navigation toasts and keeps the folder). `FileTable` is TanStack Table
    (column model) + TanStack Virtual (rows), like Selene's `ResultsGrid`.
    Pure rules in `lib/entries.ts` (folders first, natural names),
    `lib/selection.ts` (click/Cmd/Shift/arrows), `lib/path.ts`
    (breadcrumb, Up), `lib/fileFormat.ts` (size, `drwxr-xr-x`),
    `lib/dateFormat.ts` (compact Finder-style Modified label, full
    timestamp as tooltip). Columns fit the pane: Name stretches from
    120px, Size/Modified/Permissions are fixed (64/108/84px); only a pane
    narrower than their sum scrolls sideways. Remote pane: `WelcomeScreen` without a session, a
    Reconnect notice when it dropped. jsdom has no layout: tests that need
    virtualised rows call `stubViewport()` (`src/test/viewport.ts`).
- ✅ **Phase 2 — Auth complete.** Backend and UI done.
  - `AuthMethod` adds `agent` and `sshConfigHost{alias}`; `ConnectionProfile`
    adds `jump: null | {kind:"profile",profileId} | {kind:"alias",alias}`
    (alias = config host or `[user@]host[:port]`; a profile cannot jump
    through itself). Old `profiles.json` files load unchanged.
  - `connection/route.rs` turns a profile into `Hop`s (jumps first, target
    last): profile jump wins, else the config `ProxyJump` (OpenSSH order:
    first entry with its own config jumps, then each next through the
    previous); profile jumps chain; loops and > 8 hops are `invalidInput`.
    For `sshConfigHost` the config's HostName/User/Port win and the profile
    fields are fallbacks. The SSH config is only read when a hop needs it.
  - `ssh_config.rs` wraps `ssh2-config`: concrete `Host` aliases only
    (patterns skipped), `Match` blocks stripped before parsing, unsupported
    directives logged at DEBUG by name, `%h %n %r %p %u %d %%` expanded in
    HostName/IdentityFile. Path **injected** (`Core::set_ssh_config_path`;
    unset/missing = empty config).
  - `ssh/session.rs` walks the hops: TCP for the first, a `direct-tcpip`
    channel on the previous hop for every next one, each with its own host
    key check and login; jump handles live as long as the session and any
    hop that drops ends the session once (shared `OnClosed`). Jump failures
    are `jumpHost` (host key verdicts keep their own kind). Logins:
    password, key file, agent (each identity, certificates too) and config
    identities (each file, missing ones skipped, then the agent;
    `passphraseRequired` / wrong passphrase reported when nothing got in).
  - `ssh/agent.rs`: `AgentLocation::System` (Unix `SSH_AUTH_SOCK`; Windows
    `SSH_AUTH_SOCK` pipe, then the OpenSSH pipe, then Pageant —
    compile-gated, **not yet run on Windows**) or `Path` (tests). Unset in
    a fresh `Core` (= no agent); the shell sets `System`.
  - `secrets.rs`: `SecretStore` trait, `KeychainStore` (`keyring` 3,
    service `iris`, account `<profileId>/password|passphrase`) and
    `MemorySecretStore`. A fresh `Core` uses memory; the shell installs the
    keychain, so tests never touch it. `Core::connect_with(Credentials
    {password, passphrase, remember})` falls back to stored secrets, stores
    the given ones after a successful login when `remember`; jump profiles
    use their stored secrets. `delete_profile` deletes its secrets.
    New kinds: `passwordRequired`, `agent`, `keychain`, `jumpHost`.
  - IPC: `connect` takes `remember`; new `set_secret` / `clear_secret`
    (`kind: "password" | "passphrase"`) and `list_ssh_config_hosts`.
  - UI: `ConnectionForm` auth switch Password / Key file / SSH agent / SSH
    config (config host picker prefills host/port/user and shows keys +
    ProxyJump), a jump host select (saved connections, config hosts,
    "Other host…" text) and "Forget saved password and passphrase" when
    editing. `lib/connect.ts` always connects without secrets first and
    prompts on `passwordRequired` / `passphraseRequired`; a refused stored
    secret re-prompts with a notice and "remember" ticked (unticking it
    clears the stored one). `SecretPrompt` has "Remember in keychain".
  - Tests: `support/` adds hidden servers reachable only through a jump
    server's `direct-tcpip` (in-memory pipe) and an in-process agent
    (`russh::keys::agent::server` on a temp socket); `tests/auth.rs` covers
    agent, config hosts, jump chains, per-hop host keys, remembered secrets
    and a no-secret-leak sweep. `tests/ssh_integration.rs` (Docker,
    `#[ignore]`d) runs against `linuxserver/openssh-server` (jump container
    with forwarding enabled by a custom init script): `just
    test-integration`, nightly `.github/workflows/integration.yml`.
- ✅ **Phase 3 — File operations & preview.** Backend and UI done.
  - `FileSystem` adds `mkdir`, `rename` (never overwrites: `alreadyExists`;
    a case-only rename of the same entry is allowed), `remove` (folders
    with contents; symlinks themselves), `chmod(mode, recursive)` (≤
    `0o7777`; recursion skips symlinks, opening modes go top-down and
    closing ones bottom-up) and `read_range(path, offset, max_bytes)`.
    `LocalFs::remove` goes to a `Trash` (`fs/trash.rs`: `SystemTrash` via
    the `trash` crate, NSFileManager on macOS so no Finder automation
    prompt); `Core::set_trash` swaps it, so tests use a fake and never touch
    the real Trash. `SftpFs::remove` is permanent: an iterative walk on
    LSTAT/READDIR kinds, never following links. SFTP mkdir/rename check the
    target first (servers answer an existing name with a generic failure).
  - `Core::delete` / `Core::chmod` take a path list and return a
    `BatchReport { succeeded, failed: [{path, kind, message}] }`: one
    failure does not stop the rest, a lost session (`notConnected`) fails
    the call. Root folders are never deleted (`invalidInput`). An
    `on_fs!` macro in `lib.rs` dispatches every fs call to the local or
    remote side (and drops a lost session).
  - `preview.rs`: `Preview = text{text,truncated,totalSize} |
    image{mime,dataBase64,totalSize} | binary{totalSize} |
    tooLarge{totalSize}`. Reads 8 KB first; images need extension *and*
    magic bytes (png/jpeg/gif/webp; over the cap → `tooLarge`); SVG is an
    image when it fits (rendered via `<img>` data URL only), else text;
    text = NUL-free UTF-8, capped at `min(maxBytes, 1 MiB)` with a cut
    multi-byte character dropped; `maxBytes` 1 B–128 MiB. New kind:
    `alreadyExists`; new dep `base64`.
  - IPC: `mkdir`, `rename(from,to)`, `delete(paths)`, `chmod(paths, mode,
    recursive?)`, `preview(path, maxBytes)` (TS: `deletePaths` wraps
    `delete`).
  - UI: `paneStore` owns the ops (`newFolder`, `startRename` /
    `commitRename` / `cancelRename`, `remove`, `chmod`), each re-reading the
    folder after; `editing` per pane, `active` pane (Preview follows its
    `focusedEntry`), `actionTargets` = selection or cursor. `FileTable`
    shows the inline `RenameField` (basename preselected; Enter/blur commit,
    Escape cancels) and reports right-clicks; `Pane` owns the shortcuts
    from the **keymap** (`lib/keymap.ts`, see below; `isMac` picks ⌘ vs
    Ctrl; Enter renames on macOS; typing a name selects the first visible
    row starting with it, `lib/typeAhead`: 1 s buffer, closest match, Space
    joins the name while typing; bound combinations are tried first, so
    they never type-select). Defaults: ⌘P / ⌘L (Ctrl+P / Ctrl+L), a click
    on the empty breadcrumb bar or a double-click on it turn the breadcrumb
    into `GoToField`: absolute or relative paths, `~` (`homeDir`), `stat` →
    folder opens with Back, file opens its folder selected
    (`paneStore.goTo`), errors stay inline; Tab completes folders from a
    per-open cached listing; closed while the remote session is not
    connected. ⌘R refreshes, ⌘F focuses and selects the filter (Escape
    there clears it and returns focus to the table). Every pane shortcut
    and the type-ahead
    ignore keys from inputs via `isEditableTarget`; with nothing focused the
    active pane still takes its ⌘/Ctrl/Option ones, on `document`), the
    `ContextMenu` (items show their binding),
    `DeleteConfirmModal` (remote: permanent/danger tone; local:
    Trash/warning tone; Enter confirms) and `ChmodDialog` (Get Info + rwx
    grid ⇄ octal, recursive for folders). `PreviewPanel` is the island right
    of the panes (`layoutStore.previewOpen`, persisted, default **open**;
    closed = **no layout space**: a fixed-position `RevealHandle` slides in
    from the right edge when `lib/previewReveal.looksPreviewable` (listing-only
    guess: image ext within the cap, known text ext, extensionless/dot file,
    non-empty; no remote read while closed) or when the pointer is within
    `EDGE_REVEAL_PX` of the edge, lingering `HANDLE_HIDE_DELAY_MS`) at the
    stored `--preview-w` (resizable, see *Resizable islands*) whatever it shows,
    debounced 120ms, size cap from `settingsStore.preview.maxSizeMb`.
    Tests: `tests/remote.rs` covers mkdir/rename/delete/chmod/preview over
    SFTP (the `support/` server now serves open/read/mkdir/rmdir/remove/
    rename/setstat); `tests/core.rs` the local batch ops with a fake trash.
- ✅ **Phase 4 — Transfer engine.** Backend and UI done.
  - `transfer/` (`TransferManager`, owned by `Core`): one registry behind a
    mutex holds every `TransferJob {id, batchId, sessionId, direction:
    upload|download, src, dst, size, bytesDone, state, error}`; all state
    changes happen there and are published. States: `queued → running →
    done | failed | skipped | needsDecision | paused | cancelled`;
    `needsDecision → queued` (`resolve_conflict`), `paused → queued`
    (`resume_paused`), any unfinished → `cancelled`. `error {kind,message}`
    is set on `failed` and on Iris' own `skipped` (folder links, broken
    links, sockets/devices, unsafe names).
  - `expand.rs`: `enqueue` validates, returns the `BatchId` and counts the
    items in a spawned task (see *Count before copying*), then makes the
    destination folders (existing OK) and queues every job at once. A
    selected link is followed; links to folders inside a tree are skipped
    (loops). Names from listings must be one plain segment
    (`naming::is_safe_name`) so a server cannot steer a download outside
    its folder.
  - Scheduling: `Shared::pump` starts queued jobs FIFO while `running <
    parallelTransfers` — a counting semaphore whose size is re-read at
    every acquisition (`Core::save_settings` / `set_settings_path` call
    `set_parallelism`). `needsDecision` frees its slot.
  - `worker.rs`: per running job, an SFTP channel from the per-session pool
    (`SshSession::open_sftp_channel`; never shared by two running jobs),
    STAT source + destination, conflict check (`resolution` of the job,
    else the batch's apply-to-all `policy`, else `TransferConflict` event),
    then 256 KiB reads/writes (russh-sftp's `File` pipelines up to 16
    requests), `CancellationToken` per job (child of the batch token),
    mtime + permission bits (`& 0o777`) copied at the end. Data goes
    straight to the final path. `Resume` appends from the destination size
    (equal = `done` untouched, larger = replaced); `KeepBoth` →
    `naming::keep_both_name` (`a (2).txt`, `a.tar (2).gz`, `.env (2)`).
    `NotConnected` (or a session that is gone) → `paused` with progress
    kept and the job marked as owning its partial file, so `resume_paused`
    / `resume_paused_on(old, new)` append without asking.
  - Progress: `TransferProgress` throttled to one per 100 ms per job
    (`progress::Throttle`, leading edge), plus `Shared::flush_progress` once
    the last chunk is handed over, before CLOSE/SETSTAT (else a file copied
    between two ticks showed its first chunk until the server confirmed
    the file); speeds from a 3 s moving window
    (`progress::SpeedMeter`, also the aggregate in `list_transfers`'
    `summary`). `TransfersUpdated` is a re-pull signal (coalesced during
    expansion, on `clear_finished`, and by the shell's forwarder when the
    bus lagged); the bus holds 4096 events.
  - `fs/`: transfer primitives on `LocalFs` / `SftpFs` (`metadata`
    following links, `open_reader`/`open_writer(offset)`, `set_times`,
    `mkdir_all`), unified by `transfer/side.rs`. `sftp::io_err` classifies
    read/write errors without server text (broken channel = `notConnected`).
  - IPC: `enqueue_transfers(request)`, `cancel_transfer(jobId)`,
    `cancel_batch(batchId)`, `resolve_conflict(jobId, resolution,
    applyToAll?)`, `list_transfers`, `clear_finished`,
    `has_active_transfers`; events `transfers:updated`,
    `transfer:job-changed`, `transfer:progress`, `transfer:conflict`.
    A reconnect calls `resume_paused` (Phase 5).
  - Tests: `support/` serves writes/setstat-mtime, counts concurrently open
    files and can delay READ/WRITE; `tests/transfers.rs` covers byte-exact
    up/downloads with mtime/mode, trees, the parallelism limit, cancel →
    partial → resume, connection drop → paused → resume over a new
    session, every conflict answer, apply-to-all and progress coalescing;
    the Docker test adds parallel tree transfers and a killed connection.
  - Frontend: `transferStore` holds jobs by id + discovery order, the
    core's summary and per-job speeds. `useCoreEvents` feeds it:
    `transfer:job-changed` → `applyJob`, `transfer:progress` →
    `applyProgress`, and both `transfers:updated` and job changes schedule
    a `listTransfers` re-pull throttled to 250 ms (`RESYNC_MS`; the summary
    has no event). Totals shown live are computed from the jobs
    (`lib/transferFormat.transferTotals`). When a batch's last unfinished
    job finishes, the destination pane is re-read. `transfer:conflict` goes
    into the `promptStore` queue (`ConflictDialog`, Selene ConflictModal
    look; closing = Skip; Resume only when dst < src); apply-to-all drops
    the batch's other queued conflicts, and a job leaving `needsDecision`
    drops its own. `TransferPanel` (bottom island): header summary +
    total `ProgressBar` (Selene `OperationProgress`), Cancel all, Clear
    finished; an always-virtualised job list (ProcessRow look,
    `StatusDot` tones). A new batch un-collapses it (`enqueue`).
  - Pane actions: toolbar Upload (Local) / Download (Remote), the context
    menu, ⇧⌘U / ⇧⌘D (Ctrl+Shift elsewhere) and F5 (Total Commander's copy
    to the other pane) → `lib/transfer.startTransfer` into the other
    pane's folder; disabled without a live session.
  - Drag and drop: pane-to-pane drags use **mouse events, not HTML5 DnD**
    (`lib/paneDrag`, `dragStore`, `DragGhost`): `dragDropEnabled` is on so
    Tauri delivers OS file drops, and its handler takes the webview's drop
    target on every platform (wry's macOS handler answers the
    `NSDraggingDestination` calls itself; on Windows it disables HTML5 DnD)
    — DOM `drop` would never fire. Drop targets are marked in the DOM
    (`data-drop-pane` on a pane, `data-drop-dir` on folder rows) and found
    with `closest` from the event target. Finder/Explorer drops
    (`lib/useNativeDrop`, `getCurrentWebview().onDragDropEvent`) hit-test
    with `elementFromPoint` (positions are CSS pixels on macOS, physical
    elsewhere) and upload when they land on the Remote pane.
  - Settings → Transfers (`backendSettingsStore`, re-read on
    `settings:changed`): parallel transfers 1–16. `CloseWarningModal` lists
    the unfinished transfers per state.
- ✅ **Phase 5 — Tabs, auto-reconnect & quit warning.** Backend and UI done.
  - **Sessions outlive connections** (`session_manager.rs`): each
    `SessionId` maps to a slot — `Live(LiveSession {profileId, ssh,
    generation})`, `Reconnecting {run, cancel}` or `Down`. Only a user
    `disconnect` forgets the id. A connection's close callback (and a
    remote call that hits `notConnected`, via `forget_if_lost`) calls
    `Core::connection_lost(session, generation)`; a stale generation is
    ignored, so old connections never touch newer ones. `Core` is a cheap
    `Clone` handle over `Arc<CoreInner>` so the reconnect task can own one;
    close callbacks hold it weakly.
  - **Auto-reconnect**: with `reconnectAttempts` > 0 (default 5, 0 = off)
    a lost session goes `reconnecting {attempt, maxAttempts,
    nextRetryInSecs}` (published before each wait, then again with 0 while
    the attempt runs), backoff `reconnect_delay_secs` = 1/2/4/8/16 s × the
    backoff unit (`set_reconnect_backoff_unit`, 1 s; tests use 10 ms).
    Attempts are non-interactive: remembered secrets / agent / key files,
    and `ConnectRequest.prompts = None` so an unknown host key is refused
    instead of asked (`hostkey::verify(.., None, ..)`). `unrecoverable()`
    stops at once (password/passphrase needed, auth refused, host key
    changed/unknown, key file, agent, profile gone); transient errors
    (refused, timed out, handshake, jump host) retry. Success installs the
    connection under the **same session id** and calls `resume_paused`;
    giving up → `disconnected {reason}`. `Core::reconnect(session,
    credentials)` is the manual Retry / "Retry now": cancels a waiting run,
    publishes `connecting`, logs in interactively (prompts, secrets,
    remember), then `connected`; on failure a "Retry now" that interrupted
    an automatic run (`ReconnectRun.interrupted = (attempt, max)`, noted in
    the slot by `SessionManager::note_attempt`) goes back to the backoff
    loop at `attempt + 1` (Phase 6) unless `unrecoverable()`, else
    `disconnected {reason}`. Keepalive: 10 s × 3 unanswered.
  - **SessionState** is tagged by `status` on the wire: `connecting |
    connected | reconnecting{…} | disconnected{reason}` (`reason` null =
    user disconnect); the event has no separate `reason` any more.
  - **Transfers**: `disconnect` cancels the session's unfinished jobs
    (`cancel_session`); `window_confirm_close` calls
    `cancel_all_transfers` before exiting. A count cut off by a drop
    keeps its inventory and the rest (see *Count before copying*); resuming
    continues it on the session (`BatchEntry.expanding` is a counter). A
    listing (or destination folder) that *fails* becomes a `failed`
    placeholder (`TransferJob.folder = true`, `JobEntry.walk`). `retry_transfer(jobId)`: a failed file starts over
    (its own partial copy is replaced, not appended); a placeholder is
    walked again; needs a live session.
  - IPC: `reconnect(sessionId, password?, passphrase?, remember?)`,
    `retry_transfer(jobId)`.
  - **Tabs** (`state/tabsStore.ts`, `components/TabBar.tsx` in Selene's
    look, `lib/tabs.ts`, `lib/useTabShortcuts.ts`): a tab is `{id, title,
    profileId, sessionId, localPane, remotePane, …}` with its own session —
    connecting always opens a new one, shown in the tab that started it.
    `paneStore` holds the **active** tab's panes; background tabs keep
    snapshots, swapped in on switch (`paneStore.restore` drops in-flight
    listings, then both panes re-list). ⌘T / ⌘W / ⌘1–8 / ⌘9 / ⇧⌘[ ⇧⌘];
    middle-click closes; always ≥ 1 tab. `TabCloseModal` warns before
    closing/disconnecting a tab with unfinished transfers. Tabs persist in
    localStorage `iris.tabs` (profile, title, both folders, active) and are
    restored **without connecting** — the Remote pane offers Reconnect
    (avoids a burst of secret/host key prompts and unwanted connections at
    start); tabs of deleted profiles become blank.
  - UI: Remote pane banner while `reconnecting` (attempt n of max, local
    countdown, Retry now, Disconnect) and a disconnected notice with the
    reason and Retry (same session id; asks for a missing secret like the
    connect flow). `StatusDot` on tabs and sidebar rows
    (`lib/sessionStatus.ts`; reconnecting = pulsing warning). Toasts on
    `reconnecting → connected/disconnected`; panes re-list after a
    reconnect. TransferPanel: Retry on failed rows, folder placeholders.
    Settings → Transfers: Reconnect attempts 0–20.
  - Tests: `tests/reconnect.rs` (hard TCP cut → reconnect → download
    finishes byte-identical on the same id; server close; give up after N
    with the backoff sequence, then Retry; user disconnect does not
    reconnect; password needed and changed host key stop; walk cut off →
    placeholders → resumed; retry of failed file/item; disconnect and quit
    cancel). `support/` can cut TCP dead (`kill_all`), refuse connections
    and slow listings. Docker: a cut connection reconnects and the queue
    continues.
- ✅ **Phase 6 — Remote edit in local editor.** Backend and UI done.
  - `edit/` (`impl Core` + `EditManager`, owned by `Core`):
    `open_remote(session, path)` downloads (the session's main `SftpFs`,
    not the transfer queue) to `<cacheDir>/edit/<sessionId>/<fnv64(path)>/
    <name>`, re-stats the remote for the **baseline** (`RemoteStamp {size,
    mtime}`), then calls the injected `Opener` (`trait Opener { fn
    open(&self, path, app: Option<&str>) }`) with
    `editorOverrides[ext]` (last extension, lower-case) or `None` (OS
    default). A file already open in the session is reopened (same
    `EditId`, no download). Cache dir **injected**
    (`Core::set_cache_dir`, the shell's `app_cache_dir`; it also removes
    `<cacheDir>/edit` leftovers at startup); a `Core` without one is
    `config`. Opener defaults to one that fails (`config`).
  - Watching: `notify` + `notify-debouncer-mini` on the copy's **folder**
    (debounce 500 ms, `set_edit_debounce` for tests); any event re-stats the
    copy and only a size/mtime different from the last synced one is a
    save — atomic rename saves and editor temp/swap files just work. One
    tokio task per edit handles its signals in order (save, conflict
    answer, session connected), holding the core weakly.
  - A save: remote stat == baseline → upload (overwrite), re-baseline,
    `EditUploaded {editId, sessionId, path}`; else (changed or deleted)
    `EditConflict {editId, sessionId, path, remote: RemoteStamp|null,
    baseline}` and status `conflict` (saves ignored) until
    `resolve_edit(editId, overwrite|discard|saveCopy)`: overwrite uploads
    anyway; discard downloads the server copy over the local one in place
    and re-baselines; saveCopy uploads to `naming::edited_copy_name`
    (`name (edited).ext`, then `(edited 2)`, … — same tagging helper as
    keep-both) and the edit **follows the copy** afterwards. Failures →
    `EditFailed {editId, sessionId, path, kind, message}`, status
    `failed`, the next save retries. Not connected (reconnecting / down)
    → `waitingForConnection`; `Core::install` calls
    `EditManager::session_connected`, which flushes saves and answers.
    `EditStatus = synced | uploading | waitingForConnection | conflict |
    failed`.
  - Cleanup: `close_edit` (waits ≤ 30 s for an upload in flight), user
    `disconnect` → `close_session_edits`, quit (`RunEvent::Exit`) →
    `close_all_edits`; each deletes the copies. `has_active_work` is also
    true while an edit is uploading, waiting for the connection or waiting
    for a conflict answer (not merely open).
  - Shell: `opener.rs` (`DesktopOpener` → `tauri_plugin_opener::open_path`,
    errors become Iris-owned `config` text). The opener **plugin is not
    registered** and the capability grants no `opener:*` permission: the
    webview cannot open paths/URLs itself.
  - **Local files** (`open_local.rs`, `impl Core`): `Opener` also has
    `reveal(path)` (`DesktopOpener` → `reveal_item_in_dir`, selects the item
    in Finder / Explorer / the file manager). `Core::open_local(path)` uses
    the same `editorOverrides[ext]` lookup as remote edit, else the OS
    default; `open_local_default` skips the override. Both validate: absolute
    path, exists, a file or a `*.app` bundle (folders → `invalidInput`);
    `reveal_local` takes files and folders. Error text names the file, never
    the folder or the OS message. IPC `open_local(path, useDefault?)`,
    `reveal_local(path)` (`commands/open.rs`). UI: `lib/openLocal.ts`
    (`openLocalFile` with an in-flight guard, `revealLocalPath`, error
    toasts, `fileManagerName` = Finder / Explorer / File Manager). Local
    `Pane`: double-click / Enter (non-mac) / ⌘↓ / ⌘O opens a file (folders
    navigate), context menu "Open", "Open With Default App" and "Show in
    <file manager>" (also on the pane background = the current folder), and
    **⌥⌘R** (Ctrl+Alt+R; matched on `e.code === "KeyR"`) reveals the
    selection, else the folder. Remote rows are unchanged.
  - IPC: `open_remote(sessionId, path)`, `resolve_edit(editId,
    resolution)`, `list_edits`, `close_edit(editId)`; events
    `edit:uploaded`, `edit:conflict`, `edit:failed`.
  - UI: `lib/edit.ts` (`openForEdit` with an in-flight guard and error
    toast, `editUploaded` toast + re-list of the Remote pane showing that
    folder, `editFailed` toast). `Pane` (remote, connected session only):
    double-click / Enter (non-mac) / ⌘↓ / ⌘O on a file opens it for edit
    (folders still navigate), ⌘E (Ctrl+E), context menu "Open in Editor".
    `edit:conflict` → `promptStore` (`editConflict`) → `EditConflictDialog`
    (ConflictDialog look; When opened vs Server now; Discard my changes /
    Save as copy / Overwrite server; closing = Save as copy; Discard
    disabled when the server copy was deleted); a user disconnect drops the
    session's queued edit conflicts. Settings → **Editors**
    (`lib/editorOverrides.ts`: normalize/validate/add/rename/remove; rows
    in Podium's card look; app via the dialog plugin, `.app` on macOS /
    `.exe` on Windows).
  - Tests: `tests/edits.rs` (fake opener, temp cache, real watcher at 50
    ms: download + override vs default app, upload, atomic rename save,
    conflict → each answer, deleted server copy, failed upload + retry,
    deferred upload while reconnecting, cleanup on disconnect/close/quit,
    stale cleanup); `tests/reconnect.rs` adds the Retry-now resume cases;
    Docker: `edit_round_trip_against_openssh`.
- ✅ **Phase 7 — Drag out to Finder & branding.** Backend and UI done.
  - **Spike outcome: `tauri-plugin-drag` 2.1.1 (CrabNebula) + npm
    `@crabnebula/tauri-plugin-drag` ^2.1.0**, not file promises. It builds on
    tauri 2.12 (deps `tauri ^2`, `drag` 2.1.1 on objc2 0.6 /
    `windows` 0.61), drags files on disk out of the window with copy
    semantics on macOS (NSDraggingSession, the image centred on the
    pointer) and Windows (DoDragDrop, CF_HDROP), and keeps unsafe code
    inside the plugin crate. `tauri-plugin-dragout` 0.1.1 (the only file
    promise plugin, `NSFilePromiseProvider`) was rejected: one author,
    v0.1, macOS-only (it purposely fails to compile elsewhere) and built
    around extracting files from archives; doing promises ourselves would
    mean objc in a `#![forbid(unsafe_code)]` workspace and a separate
    Windows path (`IDataObject` + `CFSTR_FILEDESCRIPTOR`). Remote files are
    therefore downloaded first (v1); file promises stay an option if the
    wait proves annoying. Plugin quirks: the Rust side reports `Dropped` /
    `Cancel` (its TS types say `Cancelled`), the drag image must be a PNG
    data URL or path, folder URLs are created with `isDirectory: false`
    (Finder still copies folders — check by hand), and its `start_drag`
    command lets the webview drag any path (`drag:default`; the webview is
    our own code).
  - **When the OS drag starts**: when the pointer leaves the window during
    a pane drag (`lib/paneDrag`: a `mousemove` outside the viewport while
    the button is held — WebKit/WebView2 keep sending moves to the pressed
    view — or a `mouseout` to nowhere). That is Finder's / Forklift's feel:
    no modifier, and pane-to-pane drags inside the window stay mouse-based.
    The in-window drag ends there (the OS owns the pointer; the webview
    gets no mouse-up). A local drag out that comes back over the Remote pane
    arrives as a Tauri drop and uploads; a remote one is ignored
    (`useNativeDrop.isOwnRemoteDragOut`, by its copies' paths, kept in
    `dragStore.dragOut` after the drag ended because the drop event may
    come later).
  - **Remote rows** (`lib/dragOut`): leaving the window calls
    `prepare_drag_out(dragId, sessionId, paths)` (`dragId` =
    `crypto.randomUUID()` from the webview, so progress and cancel work
    before it returns). The core (`drag_out.rs`, `DragOutManager` owned by
    `Core`) walks the selection like the transfer engine (selected links
    followed; folder links, broken links, sockets and unsafe names inside
    folders skipped), refuses it over `DragOutLimits` (constants: **200 MiB
    total, 500 files**; `set_drag_out_limits` for tests) with `tooLarge`
    before downloading anything, then downloads it over the session's main
    SFTP channel (not the queue: the user is holding the pointer, and it
    must not appear in the transfer list) into
    `<cacheDir>/dragout/<dragId>/`, mtime and mode bits copied,
    `DragOutProgress {dragId, bytesDone, totalBytes}` (≤ 10/s, last at
    100 %). The drag chip (`DragGhost`) stays at the window edge and shows
    "Preparing n items… 42% of 12 MB"; the OS drag starts with the copies
    on the next move outside with the button held (or at once if the
    pointer is still out). Released inside → `cancel_drag_out`; released
    outside before ready, `tooLarge`, or slower than `PREPARE_TIMEOUT_MS`
    (20 s, then cancelled) → a sticky toast offering **"Download to…"**
    (`lib/downloadTo`: dialog plugin folder picker → `enqueue_transfers`
    download into it), also in the Remote pane's context menu.
    `finish_drag_out(dragId, dropped)`: cancelled → removed now; dropped →
    removed after `DEFAULT_DROP_GRACE` (120 s; the receiving app may still
    be copying; `set_drag_out_grace` for tests). `set_cache_dir` (startup)
    and `clean_drag_outs` (`RunEvent::Exit`) remove the whole
    `<cacheDir>/dragout`. New kinds: `tooLarge`, `cancelled`.
  - **Local rows** go out as they are; local rows are draggable without a
    session now (remote rows need a connected one).
  - IPC: `prepare_drag_out(dragId, sessionId, paths)`,
    `cancel_drag_out(dragId)`, `finish_drag_out(dragId, dropped)`; event
    `dragOut:progress`; plugin command `plugin:drag|start_drag`
    (capability `drag:default`). Drag image: `src/assets/drag-icon.png`
    (128 px at 144 dpi = 64 pt on retina, imported `?inline`).
  - **Branding**: Iris' own mark — a rainbow of two bands over a core
    (Iris, the gods' messenger, travelled on the rainbow; the arch also
    reads as a passage between two sides), on the Podium/Selene 100×100
    grid with their opacity steps (0.45 / 0.72 / 1) and soft shadow.
    Sources in `src-tauri/icons/source/`: `iris-mark.svg` (the mark;
    `LogoMark.tsx` draws the same paths in `currentColor`, a test keeps
    them in sync), `iris.svg` (app icon: the mark in the accent gradient on
    a dark tile on Apple's 1024 grid — 824 px body, 100 px margin, like
    Selene), `iris-1024.png` (render). `just icons` re-renders it
    (`rsvg-convert`) and runs `pnpm tauri icon` (desktop icons only). The
    favicon in `index.html` is the mark in `#4493f8`.
  - **Flaky test fixed** (`a_folder_walk_cut_off_by_a_drop_continues_
    after_a_reconnect`, ~1 in 60 runs of the reconnect binary): after
    `kill_all` the client's reader sometimes never saw the closed socket
    (only a write noticed it), so an SFTP request in flight timed out at
    russh-sftp's 10 s — at the same moment as the keepalive — and the walk
    saw a `remote` error on a session that still looked alive: the folder
    became a `failed` placeholder instead of `paused`. The same happens for
    real when a network dies without a FIN/RST. Fix: `CoreError::NoAnswer`
    (wire kind still `remote`) for SFTP timeouts, and
    `Shared::connection_gone` (walker + worker) pings the server
    (`SshSession::probe`, 5 s) before blaming the item; no answer closes
    the connection so the usual lost → reconnect → resume path runs.
    600 consecutive passes of the whole reconnect binary, 6 in parallel
    (before: 6 failures in 360).
  - Tests: `tests/drag_out.rs` (tree download byte-exact + mtime +
    progress, limits refused before downloading and exactly at the
    limits, cancel mid-download, drop grace + quit cleanup, stale cleanup
    at startup, errors, duplicate drag id); frontend: `lib/paneDrag.test.ts`
    (leaving the window → `startDrag` with the paths, pane-to-pane still a
    transfer, remote prepare → progress → OS drag → `finishDragOut`,
    pointer back inside, release inside cancels, `tooLarge` / timeout /
    early release → "Download to…" → picker → download),
    `useNativeDrop` (own remote drag out ignored, local one uploads),
    `DragGhost` (edge clamp + progress), `Pane` (context menu "Download
    to…"), `LogoMark`.
- ✅ **Sync — one-way folder sync.** Backend and UI done.
  - Manual, one way, per sync: **Local → Remote** (`upload`) or **Remote →
    Local** (`download`), comparing the active tab's Local pane folder with
    its Remote pane folder (connected session). No saved pairs, no watch.
    **Update** (default) copies new + changed files and never deletes;
    **Mirror** also deletes target-only items (second confirm in the
    dialog).
  - Core (`sync/`): `plan_sync(sessionId, direction, localDir, remoteDir,
    options)` walks both trees (`walk.rs`, the transfer rules: unsafe
    names, folder links, broken links and sockets/devices are unsupported
    with a reason; a link to a file is that file; an unlistable subfolder
    is unsupported; excluded/hidden folders are listed, not entered) in
    parallel (`tokio::join!`; each side with the concurrent `fs/walk.rs`
    walker, see *Fast tree walks*), then runs
    the **pure** `diff::diff(source, target, rules)`. Groups (`SyncGroup`):
    `new`, `changed`, `same` (counted, not listed), `targetNewer`,
    `differentSizeSameDate`, `targetOnly`, `typeMismatch`, `excluded`,
    `skipped`. Excluded / skipped / mismatched paths **block** their
    subtree (nothing under them is copied or deleted); a target-only
    folder with something blocked inside is never deleted as a whole.
    `typeMismatch` (file here, folder there) is reported and left alone in
    both modes. `MTIME_TOLERANCE_SECS = 2` (SFTP whole seconds, FAT/SMB 2 s
    steps); an unknown date never counts as newer/older.
  - Compare rules (`CompareRule`): `sizeOrDate` (default: size differs or
    date beyond the tolerance), `newerOnly` (source newer only; same date +
    other size = `differentSizeSameDate`), `sizeOnly`, `everything` (every
    source file). `new` is copied under every rule. Options
    (`SyncOptions`, serde defaults): `protectNewer` (on; a target newer
    beyond the tolerance → `targetNewer`, implied by `newerOnly`),
    `skipHidden` (dotfiles + OS-hidden, both sides: `excluded`, never
    deleted), `copyEmptyFolders` (on), `maxFileSizeMb` (`null` = off; over
    it → `skipped` "larger than N MB"), `excludes` (`null` = the
    `syncExcludes` setting). Default ticks (`SyncItem.selected`): new +
    changed; targetOnly in Mirror; targetNewer / differentSizeSameDate off.
  - Plans live in `SyncManager` (`PLAN_TTL` 10 min, `set_sync_plan_ttl`
    for tests), dropped on `disconnect` and on a lost connection, and run
    **once**. `run_sync(planId, ticked?)` (`None` = defaults; `InvalidInput`
    "nothing to sync" keeps the plan; `NotFound` = gone/expired) computes
    `actions` (pure): `mkdir -p` of the deepest destination folders first,
    then the copies as **one pinned transfer batch**
    (`TransferManager::enqueue_pinned`, per-item `Work::Item {dst_dir,
    resolution}`): `new` files start without an answer (a file that appeared
    meanwhile still prompts), the rest with `replace`. A pinned batch keeps
    the final counts of jobs "Clear finished" removes (`BatchOutcome`)
    until `unpin`. A spawned waiter (`finish_sync`) waits for the batch to
    finish, then in Mirror deletes — only when no copy failed or was
    cancelled — deepest first: files whose size + mtime are unchanged,
    whole folders whose raw subtree equals the plan's snapshot (`Tree`),
    and folders with kept contents only once empty (`IfEmpty`), through
    `Core::delete` (local: Trash; remote: permanent). Then
    `SyncFinished {planId, batchId, sessionId, direction, copied, skipped,
    failed, cancelled, deleted, kept, note}`. `has_active_work` also counts
    a sync that is deleting.
  - Settings: `syncExcludes` (default `.git`, `.DS_Store`, `node_modules`,
    `Thumbs.db`; `sync/exclude.rs`: `*` / `?` per path segment,
    case-sensitive; normalized: trimmed, deduplicated, no `/` `\`, ≤ 100
    patterns of ≤ 255 chars).
  - IPC: `plan_sync(sessionId, direction, localDir, remoteDir, options?,
    planId?)`, `run_sync(planId, ticked?)`, `discard_sync_plan(planId)`;
    events `sync:progress`, `sync:finished`.
  - UI: a **Sync** button (`SyncIcon`, lucide FolderSync) in **both** pane
    toolbars next to Upload/Download — the pane you start from is the
    source (Local → upload, Remote → download), switchable in the dialog;
    enabled like the copy actions (connected session, both folders), no
    selection needed. Also "Sync Folders…" in both context menus and
    **⌥⌘S** (Ctrl+Alt+S; matched on `e.code === "KeyS"` since Option+S
    types "ß"). `syncStore` opens `SyncDialog` (in `App`): direction
    switch with both full paths, Update / Mirror (warning note: remote
    deletes are permanent, local ones go to the Trash), "Copy when" rule
    select, an **Options** disclosure (keep newer target files, skip hidden
    — follows the source pane's show-hidden until changed — copy empty
    folders, skip files larger than N MB). Rule and options are remembered
    in `settingsStore.sync` (localStorage). Compare → spinner → the plan in
    sections (New, Changed / Overwritten, Newer on target, Different size
    same date, Will be deleted / Only on target (kept), Skipped: identical
    count + excluded / clash / not copied with reasons) with counts and
    bytes, a tick-all per section and per item (a folder takes its
    contents along; `lib/sync.ts`), lists virtualised (TanStack Virtual,
    `--sync-list-h`). Any changed choice after a comparison compares again
    (stale answers discarded, the old plan discarded). Sync with deletes →
    in-dialog confirm in DeleteConfirmModal's words. Progress is the
    transfer panel (opened); `sync:finished` → toast (problems + note as
    an error toast) and `refreshSessionPanes`. Settings → Transfers →
    **Sync excludes** (cards, add / remove / restore defaults;
    `lib/syncExcludes.ts` mirrors the core's checks).
  - Tests: `sync/diff.rs` (every rule and option, tolerance boundaries,
    nested folders, excludes per segment, hidden in Mirror, size cap,
    unsafe names, type mismatch), `sync/mod.rs` (actions: resolutions,
    folders, delete roots), `sync/walk.rs`, `sync/exclude.rs`;
    `tests/sync.rs` (hermetic: upload/download Update, Mirror deletes after
    copies, local Mirror → fake Trash, a failed copy deletes nothing,
    unticked items, nothing ticked, disconnect/expiry/discard, a target
    changed after planning is kept, rules + options on real folders,
    byte-identical + mtime so a second plan has nothing to copy); Docker
    `sync_update_and_mirror_against_openssh`; frontend `lib/sync.test.ts`,
    `SyncDialog.test.tsx` (direction/mode, compare, groups/counts, untick,
    mirror confirm, rule switch re-compares, options disclosure + default
    ticks), `Pane` (button, menu, shortcut, enabled state), Settings
    excludes editor, `settingsStore` sync prefs.
  - **Time window** ("Only files changed in", `sync/window.rs`,
    `sync/remote_find.rs`, `ssh/exec.rs`): `SyncOptions.changedWithin:
    {sinceUnix} | null` (our clock; the dialog computes it from the
    remembered preset `settingsStore.sync.changedWithin` = any | hour |
    today (local midnight) | day | week | since + `changedSince`, a
    `datetime-local` value). Refused with Mirror (`invalidInput`: deletions
    on the source are not seen) and for a cutoff in the future (> 60 s).
    The source is searched, the target never walked:
    `walk::stat_candidates` looks up (LSTAT, a link to a file also STAT)
    only the found paths plus their folders (`with_parents`), level by
    level, `REMOTE_LISTINGS` / `LOCAL_LISTINGS` at once over the walk
    channels; nothing under a folder the target lacks or has as a file
    (those are `new` / `typeMismatch` in the unchanged pure `diff`).
    - Local source (upload): `walk(.., changed_since)` — files (links to
      files by their target) with mtime ≥ cutoff (unknown = in), folder
      links / broken links / sockets by their own date, unreadable folders
      and unsafe-named folders always; pruned names (excludes, hidden with
      skip hidden) dropped entirely; folders themselves dropped.
    - Remote source (download): `date +%s` over an exec channel first
      (refused → no search, walk); a clock more than
      `CLOCK_SKEW_TOLERANCE_SECS` (60) off moves the cutoff by the skew for
      the search *and* the walk, reported as `SyncWindow.clockSkewSecs`.
      Then `sh` gets the script on stdin (any login shell only has to start
      `sh`): `LC_ALL=C; printf 'IRIS-FIND\0'; find -H '<root>' -mindepth 1
      \( -name '<exclude>' … -o -name '.*' \) -prune -o -type d \( !
      -readable -o ! -executable \) -printf 'U\0%P\0-\0-\0' -prune -o -type
      f -newermt @<since−1> -printf 'F\0%P\0%s\0%T@\0' -o -type l -printf
      'L\0%P\0%Y\0%T@\0' -o ! -type d -newermt @<since−1> -printf
      'S\0%P\0-\0%T@\0'; printf 'IRIS-END\0%s\0' "$?"`. Root and patterns
      through `ssh::exec::sh_quote` (POSIX single quotes, NUL refused); a
      relative root gets `./`; patterns with `?` are not passed (C-locale
      byte vs character), `[ ] \` escaped; Iris re-checks every name.
      Records are 4 NUL-terminated fields; names run through `is_safe_name`
      per segment (cut at the first unsafe one, non-UTF-8 = unsafe); files
      kept at whole seconds ≥ cutoff (the walk's rule); `L` with `%Y` = `f`
      (or another non-folder) looked up over SFTP (target size/date
      decide), `d` / `N L ?` = folder / broken link by own date; `U` =
      unreadable folder. No header, no end marker, status ≠ 0 or a bad
      record → `ParseError` → walk. Limits: 50 MB stdout
      (`FIND_OUTPUT_LIMIT`), 120 s (`FIND_TIMEOUT`, then a probe:
      `NotConnected` or walk), stderr never read into messages.
      GNU findutils only (`-printf`, `-newermt`, `-readable`): BusyBox / BSD
      find fail at once → walk. The Docker image ships GNU find 4.10.
    - `SshSession::exec(command, stdin, ExecLimits, on_output)`
      (`ssh/exec.rs`, russh `channel_open_session` + `exec`): refused =
      `Remote`, too much = `TooLarge`, too long = `Remote` / `NotConnected`.
    - Plan: `window: {sinceUnix, method: serverFind | walk, clockSkewSecs}
      | null`. `SyncProgress` gained `stage: scanning | searching |
      checking` and `checked`; the dialog says "Searching the server… 120
      changed files", "Checking 40 of 120 changed files on Local…".
    - UI: "Only files changed in [Any time ▾]" under the mode/rule row,
      "Since…" adds a `datetime-local` (starts a day back); Mirror disabled
      with the reason in the hint; plan header notes "Searched on the
      server" / "Scanned folders (server search unavailable)" / "Scanned
      the local folder" and "Server clock differs by N min".
    - Tests: unit (`ssh/exec.rs` quoting through a real `sh`;
      `remote_find.rs` script, parsing, odd/unsafe names, truncation, skew;
      a real GNU find run when present; `sync/walk.rs` windowed walk,
      parents, candidate lookups + diff), hermetic `tests/sync_window.rs`
      (`support/` answers `exec` with an `ExecResponder` or refuses it:
      upload with no target listing, compare rules, refused exec → walk,
      a scripted `find` with a skewed clock and links, BusyBox / cut output
      → walk, Mirror / future refused), Docker
      `sync_within_a_window_against_openssh` (server find, an unreadable
      folder, `newerOnly`, `find` moved away → walk with the same plan, an
      upload).
  - Check by hand: a large tree (thousands of files) for compare time and
    list scrolling; Mirror to the local Trash on Windows (Recycle Bin).
- ✅ **Fast tree walks.** `fs/walk.rs` (`FolderWalk<L: ListFolder, T>`) is
  the one folder-tree walker for sync comparisons (`sync/walk.rs`), transfer
  expansion (`transfer/expand.rs`) and drag-out preparation
  (`drag_out.rs`). Pull-based: `push(path, tag)` queues a folder, `next()`
  returns the next finished listing (any order) with up to a limit in
  flight — `REMOTE_LISTINGS` 16, `LOCAL_LISTINGS` 32 — as spawned tasks
  (they keep running while the caller awaits a mkdir or a ping);
  `with_cancel(token)` stops it, `into_pending()` hands back the folders
  not returned yet (in-flight first; the transfer engine's paused
  placeholders). `ListFolder for Side` lists and follows links to files
  (`WalkEntry.target`, concurrent STATs; an unreadable target = broken; a
  connection error fails the listing). Remote walks spread listings over
  `REMOTE_WALK_CHANNELS` (4) SFTP channels, least busy first:
  `open_walk_channels` (main + extra opened ones, failures to open just
  left out — OpenSSH `MaxSessions` 10) / `close_channels` for sync and
  drag-out; expansion borrows pooled transfer channels. Callers sort what
  they collect (sync: by segments; drag-out: dirs/files by local path;
  expansion: entries by name per folder), so plans and job lists stay
  deterministic. Measured (`tests/walk.rs`, `#[ignore]`d benchmarks, a
  delaying TCP pump in `support/` = `TestServer::set_latency`): with 5 ms
  round trips one channel pipelining 16 requests is as fast as 4 channels;
  with 2 ms server-side time per listing 4 channels halve it, hence 4.
  `CoreEvent::SyncProgress {planId, foldersScanned, filesSeen}` (both sides
  together, ≤ 10/s; `plan_sync_as(planId, …)` / `plan_sync`'s optional
  `planId` from the webview) → `sync:progress` → SyncDialog "Scanning… 812
  folders, 5,120 files" instead of the bare spinner. `Side::mkdir_one`
  (create first, stat on failure) makes subfolders in one round trip.
  Tests: unit (fake lister: max in flight, same result at every limit, a
  failing subfolder, cancel + pending), `tests/walk.rs` (listings overlap
  and stay ≤ 16 on the server — `max_open_dirs` — for a sync and a
  download, progress events, an unreadable subfolder).
- ✅ **Count before copying** (`transfer/expand.rs`). A batch first
  **counts**: the selected items are stat'ed (≤ walk limit at once; a sync
  run's thousands of `Work::Item`s too), folders walked with `FolderWalk`,
  everything kept in an `Inventory` (jobs with a sort key = (piece index,
  path segments), destination dirs, counts); no job exists yet. Then the
  destination folders are made level by level (`mkdir_all` for a piece's
  own folder, `Side::mkdir_one` below, several at once); one that cannot be
  made becomes a `failed` placeholder (retry walks it again) and nothing
  under it is queued. Then `Shared::add_jobs` adds every job at once in
  path order and the workers start. `BatchCounting {batchId, files, bytes,
  folders}` (≤ 10/s + a final one) while counting. A drop during the count
  or the mkdirs → `Outcome::Lost(pending)` → `BatchEntry.paused =
  Some(PausedCount {inventory, pending})` (the batch stays `counting`,
  `paused`, no jobs; `has_active` true); `resume_paused_on` takes it and
  runs the count on the new session (each such batch counts as one in its
  return value); cancel / disconnect / quit drop it. The old paused
  placeholder jobs are gone. `list_transfers` adds `batches:
  [BatchInfo {batchId, sessionId, direction, phase: counting|transferring|
  done, paused, countedFiles/Bytes/Folders, totalFiles/Bytes, doneFiles/
  Bytes}]` (start order; skipped/cancelled/placeholder jobs left out of the
  totals) and `summary.etaSecs` = remaining bytes of active jobs ÷ the
  aggregate 3 s speed, `null` while any batch counts or nothing moves.
  Event `transfer:batch-counting`. UI: `transferStore.batches` (+
  `applyCounting`, `countingBatches`); TransferPanel header "Counting… 1,234
  files, 56 MB" ("Waiting for the connection…" when paused) with the total
  bar indeterminate, then `progressText`: "12 of 340 files · 3.1 MB of
  56 MB · 1.5 MB/s · ~0:42" (speed and ETA from the core summary); Cancel
  all also cancels counting batches; CloseWarningModal / TabCloseModal /
  `hasUnfinishedTransfers` count them. Tests: `tests/transfers.rs` (no job
  while counting then all at once, totals + events, cancel while counting,
  a folder that cannot be made, ETA), `tests/reconnect.rs` (a count cut off
  → paused → resumed, path order), frontend `transferFormat`,
  `transferStore`, `TransferPanel`, `useCoreEvents`, `CloseWarningModal`.
- ✅ **Transfer CSV export** (`transfer/export.rs`).
  `Core::export_transfers_csv(path, scope: all|finished)` writes the jobs in
  the list (cleared ones are gone) as RFC 4180 CSV: header + one row per
  job, `,`-separated, **every field quoted** (`"` doubled), CRLF rows,
  UTF-8 with BOM (Excel). Columns (`COLUMNS`): batch_id, job_id,
  direction, connection (profile name), host (`host[:port]`; never a user,
  password or key), source, destination, size_bytes, bytes_done, state,
  error_kind, error_message, started_at, finished_at (ISO 8601 local time
  with offset, `chrono::Local`), duration_secs (wall clock, first start →
  end, waits included), average_bytes_per_sec. Text starting with `= + -
  @`, tab or CR gets a leading `'` (spreadsheet formula injection: names
  come from the server). Atomic write (`persist::write_bytes_atomic`:
  hidden temp file next to it + rename; the folder must exist). Path must
  be absolute (`invalidInput`). Jobs carry `startedAt` / `finishedAt`
  (unix ms, wire too): first `running`, any final state; a retry resets
  both. `BatchEntry.profile_id` names the connection. IPC
  `export_transfers_csv(path, scope?)` → `{path, rows}`. UI: TransferPanel
  "Export CSV…" (disabled without jobs) → `lib/exportTransfers` (dialog
  plugin `save`, default `iris-transfers-YYYY-MM-DD-HHmm.csv`, `.csv`
  filter; `dialog:default` already grants `allow-save`) → success toast
  with "Show in Finder" (`revealLocalPath`). Tests: export.rs (BOM +
  header, quoting of commas/quotes/newlines/unicode, times with a fixed
  offset, errors, formula guard, no secret columns), persist.rs,
  `tests/transfers.rs` (real jobs, both scopes, connection + host, no
  password, relative path refused), frontend `exportTransfers.test.ts`,
  `TransferPanel`.
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
- ✅ **Resizable islands** (`components/Splitter.tsx`, `components/Shell.tsx`,
  pure rules in `lib/resize.ts`, `lib/useShellLayout.ts`). `Shell` (the body
  under the title bar) holds the sidebar, tab strip, panes, preview and
  transfers with a `Splitter` in every canvas gap (`--gap-island`, so the
  containers have no flex gap of their own). Four sizes, stored in
  `layoutStore` (`iris.layout`; an old layout is merged over the defaults):
  - **Sidebar** width: default 280, 160–600 (`setSidebarWidth`).
  - **Local | Remote** split: `panesRatio` (Local's share), default 0.5, each
    pane ≥ `PANE_MIN_PX` 280 (stored ratio clamped to 0.05–0.95; the window
    makes the real limit). The panes are wrapped in slots sized by the
    flex-grow weights `--pane-local-grow` / `--pane-remote-grow` (sum 1000),
    so a window resize keeps the ratio natively.
  - **Preview** width: default 340, min 240, max 50% of the window; the
    splitter exists only while the preview is open, closed = no space and no
    gap, and the stored width comes back on reopen.
  - **Transfers** list height (`--transfers-list-h`, the header comes on
    top): default 168, min 56 (two rows), the whole island at most 60% of
    the window. Collapsed = header only and the handle is just a gap.
  Stored values are *preferences*: `resolveLayout(prefs, viewport)` clamps
  them to the window on every resize (coalesced per frame) and never writes
  back, so a bigger window gives the chosen sizes back. Priority when short
  of room: the sidebar gives way first (down to 160), then the preview (down
  to 240), the panes never go below 280 each. At the default 1100 px window
  with the preview open the sidebar is therefore drawn at 160. `layoutVars`
  turns the result into `--sidebar-w`, `--preview-w`, the pane weights and
  `--transfers-list-h`, written on the `Shell` container; `Sidebar`,
  `PreviewPanel` and `TransferPanel` only read the variables (the tokens in
  `tokens.css` are the defaults). `GAP_PX` / `PANE_MIN_PX` / `TRANSFERS_HEADER_PX`
  in `lib/resize.ts` mirror CSS tokens: keep them in sync.
  - `Splitter`: `role="separator"` with `aria-orientation` and
    `aria-valuenow/min/max`; pointer events with pointer capture (HTML5 DnD
    is taken by `dragDropEnabled`); `html[data-resizing="col|row"]` while the
    button is down (no selection incl. `-webkit-user-select`, fixed cursor,
    no row/handle hover, like `data-dragging`). `onResize` fires once per
    animation frame and only writes CSS variables (`useShellLayout.draft`:
    no React render, no store); the store is written on release (`onCommit`).
    Escape cancels a drag. Keys: arrows 16 px, Shift+arrows 64 px, Home/End =
    min/max (`keyboardTarget`; arrows follow the handle, `invert` for the
    preview and transfers whose handle sits on their start edge);
    double-click resets to the default. Only the handle's accent line
    animates (`--dur-1`, covered by the global reduced-motion guard).
  - Tests: `lib/resize.test.ts`, `Splitter.test.tsx` (jsdom has no
    `PointerEvent`: `src/test/pointer.ts` stubs it), `Shell.test.tsx` (children
    mocked), `layoutStore.test.ts`. Check by hand: dragging feel in WKWebView.
- ✅ **Close guard**: `CloseRequested` (red button) and `ExitRequested`
  (Cmd+Q) are blocked while `Core::has_active_work()` (any queued, running,
  needsDecision or paused transfer, or an edit save not on the server yet); the webview gets
  `window:close-requested`, shows `CloseWarningModal`, and "Close anyway"
  calls `window_confirm_close` (cancels all transfers, arms
  `AppState::force_close`, exits).

- ✅ **Configurable shortcuts.** `lib/keymap.ts` is the one place for key
  bindings: `ACTIONS` (id, label, group, `pane`/`app` scope, defaults), a
  binding is `"Mod+Shift+KeyN"` (`Mod` = ⌘ / Ctrl; Alt for ⌥), `matches` is
  exact about modifiers and reads letters/digits from `key` (layout-proof)
  but everything with Option/Alt from `code` (Option+S types "ß"; "Unknown"
  codes fall back to `key`). `resolveKeymap` lays the user's changes
  (`settingsStore.shortcuts`, only changed actions, `setShortcut` /
  `resetShortcuts`) over the defaults. Defaults: Go to path ⌘P + ⌘L, Refresh
  ⌘R, Find ⌘F, New folder ⇧⌘N, Rename F2, Delete Delete + ⌘⌫, Get Info ⌘I,
  Upload ⇧⌘U (Local pane), Download ⇧⌘D (Remote pane), Sync ⌥⌘S, Open in
  editor ⌘E, Show in Finder ⌥⌘R, Toggle preview ⌥⌘P (+ Space), New / Close /
  Next / Previous tab ⌘T / ⌘W / ⇧⌘] / ⇧⌘[, Open Settings ⌘, (non-macOS only:
  macOS keeps the native menu). Fixed (`RESERVED`, refused by the recorder):
  Enter, Space, arrows, F5, ⌘O / ⌘↓ / ⌘↑, ⌥⌘↑ / ⌥⌘↓ (move a connection), ⌘A / C / V / X / Z, ⌘1–9, Escape,
  macOS ⌘Q / H / M. `isBrowserShortcut` (F5, ⌘/Ctrl+R, P, F, G, S) is
  `preventDefault`ed in `useTabShortcuts` everywhere, bound or not, so the
  webview never reloads or prints. Settings → **Shortcuts** (`ShortcutsTab`):
  Record (capture-phase listener, Escape cancels), conflicts refused with a
  "Swap them" offer, per-row Reset and Reset all. Add an action: an entry in
  `ACTIONS`, a case in `Pane.runAction` (or `useTabShortcuts`), its hint
  where it has a button or menu item (`withHint` / `shortcutHint`).

- ✅ **Reorderable connections.** `profiles.json`'s array order is the sidebar
  order (`list_profiles` never sorts; new profiles go last, a save keeps its
  place, a delete keeps the rest). `Core::reorder_profiles(ids)` /
  `ProfileStore::reorder` take a permutation of **all** current ids (unknown,
  missing or repeated = `invalidInput`, nothing changes), write atomically and
  emit `profiles:changed`. IPC `reorder_profiles(ids)`. UI: `profilesStore.reorder`
  applies the order locally, sends it, then re-reads; a refusal toasts and
  restores the backend's order (it never rejects; only the latest of several
  quick reorders reverts or refreshes). Drag a row (`lib/rowReorder`: mouse
  events, 4px threshold, insertion line on the list item's edge, auto-scroll
  near the scroll area's edge, Escape cancels and the release does not
  connect; sets `html[data-dragging="reorder"]` for the no-select / no-sticky
  hover gate); a press without moving is still a click. ⌥⌘↑ / ⌥⌘↓ (Ctrl+Alt)
  on a focused row and the menu's Move Up / Move Down do the same step. These
  keys are **not** a keymap action (the `pane` / `app` scopes have no "focused
  sidebar row"): `ConnectionRow` handles them via `keymap.connectionMoveOf`,
  and they are in `RESERVED` so the recorder refuses them.

## Tech stack

| Concern     | Choice                                                    |
| ----------- | -------------------------------------------------------- |
| Shell / UI  | Tauri 2 + React 19 + TypeScript + Vite                   |
| Core        | Plain Rust crate, zero Tauri dependency                  |
| SSH / SFTP  | `russh` 0.64 (`ring` backend) + `russh-sftp` 3, behind `ssh/` |
| SSH config  | `ssh2-config` 0.8, behind `ssh_config.rs`                |
| Keychain    | `keyring` 3 (macOS/Windows native, Linux Secret Service), behind `secrets.rs` |
| File watch  | `notify` 8 + `notify-debouncer-mini` 0.7, behind `edit/`  |
| Open in app | `tauri-plugin-opener` 2 (Rust `open_path` only), in `src-tauri/src/opener.rs` |
| Drag out    | `tauri-plugin-drag` 2.1 + `@crabnebula/tauri-plugin-drag` 2.1, via `src/lib/dragOut.ts` |
| FE state    | Zustand 5 (no data-fetching lib; call IPC, then resync)  |
| Motion      | CSS tokens (`--dur-*`/`--ease-*`), reduced-motion guard  |
| Icons       | `lucide-react`, only via `src/components/icons.tsx`      |
| File table  | `@tanstack/react-table` + `@tanstack/react-virtual`      |
| Tests       | `cargo test` (core + integration) · Vitest + jsdom + RTL · testcontainers (Docker, opt-in) |

## Architecture

A Cargo **workspace**. `iris-core` holds all domain logic and has **zero Tauri
dependency** (plain-`cargo test`-able). `src-tauri` is a thin IPC adapter. `src/`
is the React app (presentation only).

```
crates/iris-core/src/
  lib.rs      # Core — THE single entry point (all mutation goes through it)
  error.rs    # CoreError / CoreResult + CoreError::kind (app-owned text, never secrets)
  events.rs   # CoreEvent + SessionState + EventBus (tokio broadcast)
  settings.rs # IrisSettings + IrisSettingsStore (settings.json, atomic write)
  persist.rs  # shared atomic writes (JSON documents, exports): temp file + rename
  ids.rs      # UUID newtypes (uuid_newtype!): ProfileId, SessionId, HostKeyRequestId,
              # TransferId, BatchId, EditId, DragOutId, SyncPlanId
  secret.rs   # Secret: redacted, non-serializable, zeroized password/passphrase
  secrets.rs  # SecretStore: KeychainStore (keyring) + MemorySecretStore
  ssh_config.rs  # ~/.ssh/config: host list, resolve, ProxyJump specs
  connection/ # ConnectionProfile + AuthMethod + JumpHost; store.rs = ProfileStore
              # (profiles.json); route.rs = profile → hops (jumps, config)
  ssh/        # russh wrapper: session.rs (hops/auth/SFTP), hostkey.rs
              # (known_hosts + prompts), agent.rs (ssh-agent / Pageant),
              # exec.rs (one command over an exec channel, sh_quote)
  fs/         # FileSystem trait, Entry/EntryKind/FsTarget, BatchReport;
              # local.rs, sftp.rs, trash.rs (Trash trait + SystemTrash),
              # walk.rs (concurrent folder-tree walker)
  preview.rs  # Preview (text/image/binary/tooLarge) from read_range
  session_manager.rs  # SessionId → Live | Reconnecting | Down slot (ids survive drops)
  transfer/   # TransferManager: mod.rs (types, registry, scheduling), expand.rs
              # (folder walk), worker.rs (one job), side.rs (local/remote end),
              # naming.rs (keep-both / edited-copy names), progress.rs (throttle, speed),
              # export.rs (the transfer list as CSV)
  open_local.rs  # open a local file in its app / reveal it (via the Opener)
  edit/       # remote edit: Opener trait, EditManager, watcher, upload/conflicts
  drag_out.rs # remote rows → <cacheDir>/dragout/<id>/ for an OS drag (limits, cleanup)
  sync/       # folder sync: mod.rs (types, SyncManager, plan/run/deletes), diff.rs
              # (the pure comparison), walk.rs (one side → list, target lookups),
              # exclude.rs (patterns), window.rs (changed-within search),
              # remote_find.rs (the server `find` script + output parser)
crates/iris-core/tests/
  core.rs     # integration test over the public API — no UI required
  remote.rs   # connect/browse against the in-process SFTP server (unix only)
  auth.rs     # agent, ssh config, jump hosts, remembered secrets (unix only)
  transfers.rs  # transfer engine against the in-process server (unix only)
  reconnect.rs  # auto/manual reconnect, retry, cancel on disconnect/quit (unix only)
  edits.rs    # remote edit: open, save → upload, conflicts, deferred, cleanup (unix only)
  drag_out.rs # drag-out preparation: download, limits, cancel, cleanup (unix only)
  walk.rs     # concurrent tree walks: listings in flight, progress, benchmarks (unix only)
  sync.rs     # folder sync: Update/Mirror both ways, failed copies, changed targets (unix only)
  sync_window.rs  # changed-within syncs: lookups only, server find, fallback (unix only)
  ssh_integration.rs  # Docker OpenSSH servers, #[ignore]d (just test-integration)
  support/    # hermetic russh + russh-sftp test server, jump routing, agent
src-tauri/
  tauri.conf.json                # base config
  icons/source/                  # iris-mark.svg, iris.svg (app icon) → `just icons`
  tauri.{macos,windows}.conf.json  # per-OS window chrome (merge patches)
src-tauri/src/
  main.rs     # binary entry → iris_lib::run()
  lib.rs      # Tauri builder, plugins, macOS menu, close guard, commands
  state.rs    # AppState: Arc<Core> + force_close flag
  error.rs    # IpcError { kind, message } ← CoreError
  opener.rs   # DesktopOpener: iris_core::Opener over tauri_plugin_opener::open_path
  events.rs   # forwards CoreEvents to the webview (app.emit, Lagged-safe)
  commands/   # thin shims: settings.rs, connection.rs (profiles, secrets,
              # ssh config hosts), session.rs
              # (connect/reconnect/disconnect/answer_host_key), fs.rs (list_dir/stat/
              # read_link/home_dir/mkdir/rename/delete/chmod/preview),
              # transfers.rs (async: the core spawns jobs on Tokio), edit.rs
              # (open_remote/resolve_edit/list_edits/close_edit), open.rs
              # (open_local/reveal_local), drag_out.rs
              # (prepare/cancel/finish_drag_out), sync.rs (plan_sync/run_sync/
              # discard_sync_plan), window.rs
src/
  App.tsx     # the app: title bar, app-level wiring, dialogs; `Shell` below it
              # (sidebar, tab bar, Local/Remote panes, preview, transfers, and
              # the splitters between them)
  components/ # Sidebar + ConnectionSidebar/ConnectionRow, ConnectionForm,
              # PromptHost (SecretPrompt, HostKeyDialog, ConflictDialog,
              # EditConflictDialog),
              # Pane + Breadcrumb + GoToField + FileTable, ContextMenu,
              # DeleteConfirmModal,
              # ChmodDialog, PreviewPanel, TransferPanel + ProgressBar,
              # Shell + Splitter (resizable islands),
              # DragGhost, SyncDialog, WelcomeScreen, Modal, TabBar, TabCloseModal,
              # Toasts, SettingsModal, CloseWarningModal, WindowControls,
              # StatusDot, LogoMark, icons (lucide wrapper; import from here)
  ipc/        # commands.ts (typed wrappers), types.ts (wire types), events.ts
  state/      # Zustand stores: profiles, session, prompt (queue), tabs, pane,
              # transfer, drag, sync (dialog request + finished toast),
              # connectionForm, theme, settings (UI prefs),
              # backendSettings (core settings.json), settingsRequest,
              # layout, toast — mirror the backend; don't guess
  lib/        # connect flow, tabs, edit (open for edit, edit toasts),
              # editorOverrides, sync (dialog rules), syncExcludes,
              # keymap (named actions, default bindings, matcher, formatter;
              # `useKeymap`), useTabShortcuts (app-level bindings + the
              # browser-shortcut guard), sessionStatus,
              # useCoreEvents, useNativeDrop, paneDrag, dragOut (OS drag
              # out, remote preparation), downloadTo (folder picker),
              # transfer (pane → request), pure rules (entries, selection,
              # path, goToPath, fileFormat, fileName, mode, dateFormat,
              # transferFormat, connectionForm, resize), useShellLayout,
              # log, motion, platform
  assets/     # drag-icon.png (the OS drag image)
  styles/     # tokens.css (design tokens) + global.css (resets/primitives)
  test/       # Vitest setup + stubViewport (jsdom has no layout)
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
just dev-signed     # debug .app, stable signing identity, launches it (macOS)
just build-signed   # release .app, stable signing identity (macOS, shared recipe)
just install-signed # build-signed + copy to /Applications/Iris.app
just check          # cargo check --workspace
just ci             # shared: rustfmt, clippy -D warnings, cargo test, prettier, eslint, vitest, build
just test-core      # iris-core tests only
just test-integration  # Docker OpenSSH tests (needs Docker; opt-in, not in `just ci`)
just format         # rustfmt + prettier
just version 0.2.0  # bump + sync version across all manifests (emergencies only; CI bumps on merge)
just version-check  # verify versions are in sync
```

Shared recipes (`rust`, `frontend`, `ci`, `build-signed`, `sweep`) come from
`~/.ci-workflows/common.just` (symlink to a clone of
`RobbieMinderhoud/ci-workflows`); don't redefine those names.
`test-integration` must not depend on them: in CI the import resolves to nothing.

CI is shared: `.github/workflows/` holds thin callers pinned to
`RobbieMinderhoud/ci-workflows@v1`. `ci.yml` = `tauri-ci.yml` (frontend + Rust
job on ubuntu, Windows tests `-p iris-core`) and, on push to `main`,
`release.yml`; `pr-checks.yml` = changelog entry + release label; `build.yml` =
installers dispatched by the release; `integration.yml` = nightly
`just test-integration` on ubuntu (`libdbus-1-dev` for keyring's Linux
backend). Behaviour and the release scripts live in that repo; see its README.

Windows runs on pushes to `main` and on PRs that carry the `windows` label
(adding the label re-runs CI for the PR). Required checks: `ci / ci-ok`,
`pr-checks / Changelog entry` and `pr-checks / Release label`; don't require
`ci / frontend`, `ci / rust` or `ci / windows`. The labels `patch`, `minor`,
`major` and `windows` must exist.

### When to add the `windows` label

Add `windows` to a PR when it:

- touches `cfg(windows)`, `cfg(unix)` or `target_os` code, or platform-specific modules
- changes file paths, path separators, drive letters or case sensitivity; process spawning, PTY or shell quoting; environment variables; WSL
- changes the Windows settings in `tauri.conf.json` (bundle, NSIS) or installer scripts
- adds or upgrades a dependency with platform-specific code (`tauri`, `windows-rs`, `portable-pty`, …) or bumps the Rust toolchain
- fixes a Windows bug

Skip it for frontend-only, docs-only and purely cross-platform logic changes. If unsure, add it: `main` runs Windows after the merge anyway, and a failure there blocks the release.

Windows-sensitive spots in Iris (all `crates/iris-core/tests/*` except
`core.rs` are `cfg(unix)`, so Windows CI compiles them out; Windows coverage is
the lib unit tests):

- `crates/iris-core/src/fs/local.rs`: local paths (verbatim `\\?\` prefix), hidden
  attribute, case-insensitive names
- `crates/iris-core/src/transfer/naming.rs`: forbidden characters (`\`, `:`)
- `crates/iris-core/src/ssh/agent.rs`: OpenSSH agent pipe / Pageant (never run on Windows yet)
- `crates/iris-core/src/ssh_config.rs`: `~/.ssh/config` and `known_hosts` locations
- `crates/iris-core/src/secrets.rs` and `Cargo.toml` (`keyring` backends per OS)
- `crates/iris-core/src/fs/trash.rs`: Recycle Bin
- `crates/iris-core/src/drag_out.rs`, `src-tauri/src/commands/drag_out.rs`
  (`tauri-plugin-drag`): dragging out to Explorer
- `src-tauri/src/opener.rs`: open in editor / reveal (`ShellExecute`)
- `src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.conf.json` (bundle, NSIS
  installer built by the shared `build.yml`) and `windows_subsystem` in
  `src-tauri/src/main.rs`

### macOS keychain prompt during development

Iris keeps passwords and passphrases in the macOS keychain (`keyring`, service
`iris`). `just dev` ad-hoc-signs the binary with a new identity on every
rebuild, so macOS asks for keychain access again each run and "Always Allow"
never sticks. Release builds signed with a stable identity don't have this.

- `just dev-signed` builds and launches a debug `.app`, `just build-signed` a
  release `.app` (`$CARGO_TARGET_DIR/release/bundle/macos/Iris.app`),
  `just install-signed` also copies it to `/Applications/Iris.app`. All sign with
  the identity in `src-tauri/tauri.dev-signed.conf.json`, applied only through
  `--config`, so `just build` is unaffected. No hot reload: keep `just dev` for
  iteration.
- That file is **gitignored** (machine-specific). Create it with your identity
  from `security find-identity -v -p codesigning`:
  `{"$schema": "https://schema.tauri.app/config/2", "bundle": {"macOS": {"signingIdentity": "<identity name>"}}}`.
  The recipes stop with a hint if it is missing.
- The justfile exports `CARGO_TARGET_DIR` as the main checkout's `target/`, so
  git worktrees share one build cache. CI doesn't use `just` and keeps `./target`.

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
  single source of truth; the shared `sync-version.sh` propagates it to
  `tauri.conf.json` and `package.json` (`just version-check` detects drift).
- **`CHANGELOG.md`** follows _Keep a Changelog_ and lists **only functional
  (user-facing) changes**. Every PR adds its entry under `## [Unreleased]`; the
  `pr-checks / Changelog entry` check fails unless the PR touches
  `CHANGELOG.md` and that section holds at least one `- ` entry.
- **Releasing is automatic: every merge to `main` is a release.** Every
  PR needs exactly one of the labels `patch`, `minor` or `major`, enforced by
  the `pr-checks / Release label` check. The `release` job in `ci.yml` runs after `ci` on each push to `main`
  (its own non-cancelling `release` concurrency group; the workflow never
  cancels runs on `main`, so no merge is left without a version). It checks out
  `main` itself, not the pushed sha, so a queued second run sees the first
  one's bump; an empty `## [Unreleased]` means already released, and it exits.
  Otherwise the version is the latest `v*` tag bumped by
  the shared `next-version.sh` — the merged PR's label (`major` wins; patch for a
  push without a PR); with no `v*` tag yet, the first
  release ships the `Cargo.toml` version as-is. It renames `## [Unreleased]` to
  `## [X.Y.Z] - date` (shared `changelog.sh release`), runs
  `sync-version.sh --set` and `cargo update --workspace` (Cargo.lock), commits
  `Release vX.Y.Z [skip ci]` to `main` as `github-actions[bot]`, pushes it with
  the annotated tag `vX.Y.Z` (`--atomic`), creates the GitHub Release with the
  section as notes, and dispatches `build.yml` on the tag.
- **Bundle build** (`build.yml`, shared): a matrix over macOS and
  Windows, each building natively. macOS packages the `.app` + APFS `.dmg`
  (shared `make-dmg.sh`); Windows the NSIS `.exe`. Runs on
  `workflow_dispatch` only; on a tag ref (the release job's dispatch) it
  attaches the installers to that tag's GitHub Release. There is deliberately
  **no tag trigger**: a deploy-key push fires workflows, and GitHub's docs don't
  say whether `[skip ci]` on the release commit also covers the tag in the same
  push, so the explicit dispatch is the one build per release. A hand-pushed
  tag builds with `gh workflow run build.yml --ref vX.Y.Z`.
- **Protected `main`** (optional, one-off setup per repo): the release job must
  push to `main`, which a ruleset requiring PRs would block (`GH013`); GitHub
  refuses the Actions app as a bypass actor on a user-owned repo (an org-owned repo can add the Actions app as a bypass actor instead), so
  `GITHUB_TOKEN` cannot get through. Create the labels `patch`, `minor` and `major`,
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
