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

- Skeleton only: the boilerplate's sample feature (greet + notes) is still the
  domain. Replace it with the real Iris domain.

## Tech stack

| Concern     | Choice                                                    |
| ----------- | -------------------------------------------------------- |
| Shell / UI  | Tauri 2 + React 19 + TypeScript + Vite                   |
| Core        | Plain Rust crate, zero Tauri dependency                  |
| FE state    | Zustand 5 (no data-fetching lib; call IPC, then resync)  |
| Motion      | CSS tokens (`--dur-*`/`--ease-*`), reduced-motion guard  |
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
  error.rs    # CoreError / CoreResult (messages are app-owned text, never secrets)
  ids.rs      # UUID newtypes via the uuid_newtype! macro
crates/iris-core/tests/
  core.rs     # integration test over the public API — no UI required
src-tauri/src/
  main.rs     # binary entry → iris_lib::run()
  lib.rs      # Tauri builder, plugins, command registration
  state.rs    # AppState: Arc<Core>
  error.rs    # IpcError { kind, message } ← CoreError
  commands/   # one thin (de)serialize-and-forward shim per command
src/
  App.tsx     # the shell
  ipc/        # typed command wrappers + hand-written wire types
  state/      # Zustand stores (mirror the backend; don't guess)
  lib/        # framework-agnostic helpers (log, motion)
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
