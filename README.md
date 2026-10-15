# Iris

A cross-platform desktop **remote file manager over SSH** (in the spirit of
Forklift), built in **Rust + Tauri 2 + React + TypeScript + Vite**.
**v0.1 — in progress** (Phase 0: the island shell, themes, settings and app
plumbing; no SSH yet).

Forked from
[rust-application-boilerplate](https://github.com/RobbieMinderhoud/rust-application-boilerplate);
see `CLAUDE.md` for the conventions and the rule that skeleton changes flow back
there as a PR.

## Layout

```
Cargo.toml                 # [workspace]; [workspace.package] version is the source of truth
justfile                   # dev/build/check/test/lint/format/version recipes
scripts/sync-version.sh    # propagates the version to tauri.conf.json + package.json
scripts/{next-version,changelog}.sh  # release helpers used by CI (+ *.test.sh)
CHANGELOG.md               # Keep a Changelog; PRs add entries under [Unreleased]
crates/iris-core/          # the domain: single entry point (Core), zero Tauri dependency
src-tauri/                 # thin Tauri IPC adapter over iris-core
src/                       # React frontend (presentation only)
.github/workflows/ci.yml   # rustfmt, clippy -D warnings, cargo test, typecheck, lint, vitest, build; changelog check; release
.github/workflows/build.yml  # macOS .dmg + Windows .exe; dispatched by the release job, attached to the release
```

## Prerequisites

- Rust (stable; `rust-toolchain.toml` pins `rustfmt` + `clippy`)
- Node 22 + `pnpm` 10
- The Tauri 2 system prerequisites for your OS — see
  <https://tauri.app/start/prerequisites/>
- `just` (optional but recommended: `brew install just`)

## Get started

```
pnpm install
just dev            # run the app (Vite + Tauri, hot reload)
just test           # cargo test --workspace + frontend vitest
just lint           # clippy -D warnings + eslint
just build          # production desktop bundle
```

## Releases

Every merge to `main` is a release. Each PR adds its entry under
`## [Unreleased]` in `CHANGELOG.md` (CI fails without one). On merge, CI picks
the next version from the latest `v*` tag — patch by default, or minor/major
when the PR has the `minor`/`major` label — bumps the manifests, commits
`Release vX.Y.Z`, tags it, creates the GitHub Release and builds the macOS and
Windows installers onto it. Don't bump or tag by hand. The first release (no
`v*` tag yet) ships the version in `Cargo.toml`.

The repo is set up for this: labels `minor`/`major`, a protected `main`
ruleset, and the `RELEASE_DEPLOY_KEY` deploy key in its bypass list.

## License

No license file is included — add one before publishing.
