# Iris

A cross-platform desktop **remote file manager over SSH** (in the spirit of
Forklift), built in **Rust + Tauri 2 + React + TypeScript + Vite**.
**v0.1 — in progress** (Phases 0–2: the island shell, connecting and
browsing over SFTP, and password / key / ssh-agent / `~/.ssh/config` logins
with jump hosts and keychain-remembered secrets; transfers not yet).

Forked from
[rust-base](https://github.com/Myrras/rust-base);
see `CLAUDE.md` for the conventions and the rule that skeleton changes flow back
there as a PR.

## Layout

```
Cargo.toml                 # [workspace]; [workspace.package] version is the source of truth
justfile                   # icons + test-integration; imports shared dev recipes from common.just
CHANGELOG.md               # Keep a Changelog; PRs add entries under [Unreleased]
crates/iris-core/          # the domain: single entry point (Core), zero Tauri dependency
src-tauri/                 # thin Tauri IPC adapter over iris-core
src/                       # React frontend (presentation only)
.github/workflows/         # thin callers of Myrras/rust-base (reusable workflows @v2): ci, pr-checks, build, integration
.github/dependabot.yml     # weekly grouped updates: actions, cargo, npm
```

## Prerequisites

- Rust (stable; `rust-toolchain.toml` pins `rustfmt` + `clippy`)
- Node 22 + `pnpm` 10
- The Tauri 2 system prerequisites for your OS — see
  <https://tauri.app/start/prerequisites/>
- `just` (optional but recommended: `brew install just`)
- A clone of `Myrras/rust-base`, symlinked as `~/.rust-base` (for `just ci` and the shared scripts)

## Get started

```
pnpm install
just dev            # run the app (Vite + Tauri, hot reload)
just ci             # fmt, clippy, tests, eslint, vitest, build (from the shared common.just)
just build          # production desktop bundle
```

## Releases

Every merge to `main` is a release. Each PR adds its entry under
`## [Unreleased]` in `CHANGELOG.md` (CI fails without one). On merge, CI picks
the next version from the latest `v*` tag — by the PR's `release:patch`, `release:minor` or
`release:major` label (exactly one, checked by `pr-checks`; `no-release` for CI, config and docs-only PRs) — bumps the manifests, commits
`Release vX.Y.Z`, tags it, creates the GitHub Release and builds the macOS and
Windows installers onto it. Don't bump or tag by hand. The first release (no
`v*` tag yet) ships the version in `Cargo.toml`.

The repo is set up for this: labels `release:patch`/`release:minor`/`release:major`/`no-release`/`windows`, a protected `main`
ruleset, and the `RELEASE_DEPLOY_KEY` deploy key in its bypass list.

## License

No license file is included — add one before publishing.
