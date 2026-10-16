# Changelog

All notable **functional** (user-facing) changes to this project are documented
here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Internal refactors, tooling, and chores are intentionally omitted. Every pull
request adds its entry under `## [Unreleased]`; the version number is assigned
when it merges.

## [Unreleased]

- Local files open in their application: double-click, Enter (not on macOS),
  ⌘O / ⌘↓ or the context menu's Open use the app set in Settings → Editors,
  else the system default. "Show in Finder" (Explorer / File Manager) in the
  context menu or ⌥⌘R / Ctrl+Alt+R reveals the selection, or the folder.
- Sync folders: the Sync button in either pane (also in the context menu,
  ⌥⌘S / Ctrl+Alt+S) compares the Local and Remote folders and copies one
  way, Local → Remote or Remote → Local. Update copies new and changed files;
  Mirror also deletes what exists only on the target, after a second
  confirm and only when every copy succeeded. Pick how files are compared
  (size or date, newer only, size only, everything) and options (keep newer
  target files, skip hidden files, copy empty folders, skip large files);
  review the result per group and untick what should stay. Settings →
  Transfers lists the names a sync leaves alone (.git, node_modules, …).
- Transfers show their progress up to the last byte: a fast copy no longer
  sits at its first chunk until the server has finished the file.
- After going up a folder, the folder you came from is selected, like in Finder.
- The active pane is marked with an accent ring and header; selected rows in the inactive pane turn grey.
- Type a file name in a pane to select it, like in Finder.
- Island layout in Podium's look: a sidebar with a Connections section, Local
  and Remote file panes side by side, and a collapsible Transfers panel.
- Dark, light and retro themes with a crossfade when switching.
- Settings dialog (⌘, on macOS, the title-bar gear or Ctrl+, elsewhere) with
  theme, reduced motion, show hidden files and a preview size limit.
- Custom title bar: native traffic lights on macOS, own window controls on
  Windows; window size and position are remembered.
- A warning before quitting while work is still in progress.
- Saved connections: name, host, port, user, authentication method and an
  optional start folder. Passwords and passphrases are never stored with
  the connection; you enter them when connecting.
- Connect over SSH with a password or a private key file, including
  passphrase-protected keys.
- Host key verification against `~/.ssh/known_hosts`: a new server shows
  its fingerprint for you to trust once; a changed host key blocks the
  connection.
- Browse remote folders over SFTP, with symlinks (and where they point) and
  hidden files recognised; large folders list quickly.
- Connections sidebar: saved servers with a live status dot; click to
  connect, right-click to connect, disconnect, edit or delete. New and edit
  forms check host, port, user and key file as you type, with a file picker
  for the private key.
- Password and passphrase prompts when connecting; a wrong one can be
  retyped without starting over.
- Local and Remote panes side by side: breadcrumb path, Back, Up and
  Refresh, a filter box and a hidden-files toggle. Columns for name, size,
  modified date and permissions; click a header to sort (folders stay on
  top, names sort naturally).
- Open folders (and links to folders) with a double-click, or Enter on
  Windows and Linux; select with the arrow keys, Cmd/Ctrl-click and
  Shift-click. Folders with thousands of entries scroll smoothly.
- A dropped connection shows in its pane with a Reconnect button.
- Log in with the keys in your running SSH agent.
- Pick a host from `~/.ssh/config` in the connection form: host, port and
  user are filled in, and connecting uses its IdentityFile keys (then your
  SSH agent) and its ProxyJump, so config changes apply on the next connect.
- Jump hosts (ProxyJump): reach a server through another saved connection,
  a host from `~/.ssh/config` or any `user@host:port`. Chains of jump hosts
  work, each with its own host key check.
- "Remember in keychain" on the password and passphrase prompt stores the
  secret in your system keychain, so the next connect asks nothing. If a
  saved secret stops working you are asked again and can replace or forget
  it; editing a connection can also forget it, and deleting one removes it.
- New Folder from the pane toolbar, the right-click menu or ⇧⌘N
  (Ctrl+Shift+N elsewhere): creates "untitled folder" and lets you name it
  right away.
- Rename in place with F2, Enter on macOS (as in Finder) or the right-click
  menu; Escape cancels. A rename never overwrites an existing file. On
  macOS, ⌘↓ opens a folder and ⌘↑ goes to the enclosing one.
- Delete with the Delete key, ⌘⌫ (Ctrl+Backspace elsewhere) or the
  right-click menu, always after a confirmation that lists what goes: local
  files move to the Trash (Recycle Bin on Windows), remote files are deleted
  permanently. A symbolic link is deleted itself, never what it points to.
- Get Info / Permissions (⌘I, Ctrl+I elsewhere): kind, size and date, and
  the permissions as a read/write/execute grid with a matching octal field;
  for folders, optionally applied to everything inside.
- Preview panel to the right of the panes (Space, as in Quick Look, or the
  toolbar button): text files, and PNG, JPEG, GIF, WebP and SVG images on a
  checkerboard. Large text files show their first part with a notice;
  images over the preview size limit and binary files say so. The panel is
  open by default at a fixed width, whatever it shows, until you close it.
  Closed, it takes no space; a handle slides in from the window's right edge
  for previewable files or when the pointer reaches the edge.
- Right-click menu on files and on the empty part of a pane: Open, Preview,
  New Folder, Rename, Get Info, Refresh and Delete.
- Uploads and downloads of files and whole folders: folders are recreated
  on the other side (empty ones included), files keep their modification
  time and permissions, and several files copy at once (as many as the
  "parallel transfers" setting allows; a change applies to the next file
  that starts).
- Upload and Download buttons in the pane toolbars and the right-click
  menu, ⇧⌘U / ⇧⌘D (Ctrl+Shift+U / Ctrl+Shift+D elsewhere) or F5: copies the
  selection into the folder the other pane shows.
- Drag files and folders from one pane to the other, or onto a folder in
  it; drag them in from Finder or Explorer onto the Remote pane to upload.
  The pane and folder that would receive them light up.
- Transfers panel: every file with its progress, size, speed and state (a
  failure's reason on hover) and a cancel button; the header shows how many
  are active and queued, the total speed and time left, with Cancel all and
  Clear finished. It opens when a transfer starts, and the destination pane
  refreshes when a transfer finishes.
- When a file already exists at the destination you choose Replace, Skip,
  Keep Both (saved as "name (2).ext") or Resume (continue a partial copy;
  only offered when the existing file is smaller), optionally for the rest
  of that transfer. The dialog compares both files' size and date.
- A transfer cut off by a dropped connection pauses instead of failing and
  can continue where it stopped; a cancelled one leaves its partial file,
  which a later transfer can resume.
- Links to files are copied as the file; links to folders inside a folder
  are skipped (they could loop) and listed as skipped.
- The quit warning now appears while transfers are still queued, running,
  waiting for your answer or paused, and says how many of each.
- Settings → Transfers: how many files transfer at once (1–16).
- Tabs above the panes: each tab has its own Local and Remote panes and its
  own connection, so the same server can be open in several tabs. ⌘T opens a
  tab, ⌘W closes one, ⌘1–⌘8 jump to a tab and ⌘9 to the last (Ctrl
  elsewhere); a middle-click closes a tab. Each tab shows its connection's
  status dot. Clicking a server in the sidebar connects in the current tab,
  or in a new tab when that one is already in use; "Connect in New Tab" is
  in its menu.
- Open tabs and their folders come back on the next start. They do not
  connect by themselves: a Reconnect button in each tab does.
- Closing a tab, or disconnecting, while its transfers are still running
  asks first; going ahead cancels them.
- A dropped connection is noticed within about half a minute and
  reconnects by itself, waiting 1, 2, 4, 8, then 16 seconds between
  attempts. The tab keeps its folder and its transfers continue where they
  stopped once the connection is back. The Remote pane shows the attempt
  and a countdown, with Retry now and Disconnect; a toast says whether the
  reconnect worked.
- Reconnecting stops, with the reason and a Retry button, when it would
  need a password or passphrase that is not saved, or when the server's
  host key changed or the login is refused. Retry asks for what is missing.
- Settings → Transfers: Reconnect attempts (0–20; 0 turns reconnecting
  off).
- Failed transfers have a Retry button.
- A folder transfer cut off by a dropped connection carries on with the
  folders it had not listed yet instead of failing them.
- Choosing to quit while transfers are in progress cancels them.
- "Retry now" while reconnecting no longer gives up when that try fails:
  the automatic attempts that were left carry on.
- Edit remote files in your own editor: double-click a remote file, choose
  "Open in Editor" in its menu, or press ⌘E (Ctrl+E elsewhere). Every save is
  uploaded back to the server, with an "Uploaded" toast; a failed upload says
  why and is tried again on the next save.
- When the file changed on the server since you opened it, saving asks
  whether to overwrite the server copy, discard your changes (the server
  version reloads in your editor), or save yours next to it as
  `name (edited).ext`.
- Saves made while the connection is down are uploaded once it is back.
  Quitting while a save is not uploaded yet warns first.
- Local copies of edited files are deleted when you disconnect or quit.
- Settings → Editors: choose which application opens each file extension
  (e.g. `.md` in Typora); other files open in the system's default app.
- Drag files and folders out of the window to Finder or Explorer. Local
  items go out as they are; remote items are downloaded first, with the
  progress on the drag label, and the drag carries on once they are there.
- Remote selections larger than 200 MB or 500 files, or that take longer
  than 20 seconds to fetch, offer "Download to…" instead of a drag.
- "Download to…" in the Remote pane's context menu downloads the selection
  into a folder you pick.
- Iris has its own logo and app icon: a rainbow arch.
- A folder download cut off by a connection that died silently now waits
  for the reconnect instead of failing.
