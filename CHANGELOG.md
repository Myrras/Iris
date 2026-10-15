# Changelog

All notable **functional** (user-facing) changes to this project are documented
here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Internal refactors, tooling, and chores are intentionally omitted. Every pull
request adds its entry under `## [Unreleased]`; the version number is assigned
when it merges.

## [Unreleased]

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
  images over the preview size limit and binary files say so. The panel
  collapses to a slim strip and remembers its state.
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
