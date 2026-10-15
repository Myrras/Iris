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
- Open folders (and links to folders) with a double-click or Enter; select
  with the arrow keys, Cmd/Ctrl-click and Shift-click. Folders with
  thousands of entries scroll smoothly.
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
