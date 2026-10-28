# Changelog

All notable **functional** (user-facing) changes to this project are documented
here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Internal refactors, tooling, and chores are intentionally omitted. Every pull
request adds its entry under `## [Unreleased]`; the version number is assigned
when it merges.

## [Unreleased]

### Added

- Connect over SSH with a password, a private key (passphrase-protected too), your running SSH agent or a host from `~/.ssh/config`, including ProxyJump and chains of jump hosts. Host keys are checked against `~/.ssh/known_hosts`. "Remember in keychain" stores a password or passphrase in the system keychain.
- Saved connections in a sidebar with a live status dot; drag to reorder them (or use ⌥⌘↑ / ⌥⌘↓).
- Local and Remote panes side by side, in tabs that each keep their own connection and folders and come back on the next start. Breadcrumb, go-to-path (⌘P / Ctrl+P), filter, sortable columns, type-to-select, keyboard navigation and a preview panel for text and images.
- Uploads and downloads of files and folders, with a transfer panel (progress, speed, time left, cancel, retry), a counted total for folders, parallel transfers, conflict choices (Replace, Skip, Keep Both, Resume) and a CSV export of the transfer list. Drag files between the panes, in from Finder or Explorer, or out of the window.
- Dropped connections are noticed and reconnect by themselves; transfers pause and continue where they stopped.
- Sync folders in either direction (Update or Mirror) with several compare rules and options, review per group, and an "only files changed in" time window. Comparing deep trees is much faster.
- Edit remote files in your own editor: every save is uploaded back, with a warning when the server copy changed meanwhile.
- New Folder, rename, delete (local files go to the Trash or Recycle Bin), Get Info / Permissions, open local files in their application and show them in Finder or Explorer.
- Settings for theme (dark, light, retro), reduced motion, hidden files, preview size limit, parallel transfers, reconnect attempts, editors and configurable keyboard shortcuts.
- Resizable panes, a custom title bar and a warning before quitting while work is still in progress.

### Changed

- CI now uses the shared workflows from ci-workflows.

### Fixed

- Dialogs that open over each other no longer paint on top of one another; only the newest shows.
- Transfers report progress up to the last byte instead of sitting at the first chunk.

## [0.1.0] - 2026-10-28

### Changed

- Every pull request now needs exactly one release label (`patch`, `minor` or `major`). The `Release label` check fails without it, and the label sets the version bump on merge.
