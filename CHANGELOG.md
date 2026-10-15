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
  optional start folder. Passwords and passphrases are never stored; you
  enter them when connecting.
- Connect over SSH with a password or a private key file, including
  passphrase-protected keys.
- Host key verification against `~/.ssh/known_hosts`: a new server shows
  its fingerprint for you to trust once; a changed host key blocks the
  connection.
- Browse remote folders over SFTP, with symlinks (and where they point) and
  hidden files recognised; large folders list quickly.
