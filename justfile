# Iris — development tasks. Run `just` to see them.

# Share one target/ across the main checkout and every git worktree. A fresh
# worktree otherwise starts cold and rebuilds every dependency (minutes);
# pointing it at the main checkout's target/ keeps them warm.
# ponytail: cargo locks the target dir, so two builds in different worktrees
# serialise instead of running in parallel — still far cheaper than a cold
# rebuild. Falls back to ./target outside a git checkout.
export CARGO_TARGET_DIR := `dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$PWD/.git")"` / "target"

# Shared recipes (rust, frontend, ci, build-signed, sweep) come from the
# ci-workflows clone: `ln -s /path/to/ci-workflows ~/.ci-workflows`.
import? '~/.ci-workflows/common.just'

# Show available recipes.
default:
    @just --list

# Run the app in development (Vite dev server + Tauri, hot reload).
dev:
    pnpm tauri dev

# Tauri's own dmg step uses HFS+, which is broken on macOS 26+, so we build
# the .app here and package the .dmg ourselves (APFS) via the shared make-dmg.sh.

# Build the production desktop bundle (.app + .dmg).
build:
    pnpm install
    pnpm tauri build --bundles app
    ~/.ci-workflows/scripts/make-dmg.sh
    @just sweep

# `just dev` ad-hoc-signs the binary with a fresh identity every rebuild, so the
# keychain re-prompts each run and "Always Allow" never sticks. This recipe
# keeps one signing identity across rebuilds, so a single "Always Allow"
# persists. Tradeoff: runs a bundle, so there's NO hot reload — use `just dev`
# for fast iteration and this when the keychain prompt is in your way.
# Setup: see "macOS keychain prompt during development" in CLAUDE.md
# (identity lives in the gitignored src-tauri/tauri.dev-signed.conf.json).

# Build + launch a debug .app signed with a STABLE certificate (macOS).
dev-signed:
    @just _signed-conf
    pnpm tauri build --debug --bundles app --config src-tauri/tauri.dev-signed.conf.json
    @just sweep
    open "$CARGO_TARGET_DIR/debug/bundle/macos/Iris.app"

# Build the signed release and copy it straight into /Applications.
install-signed:
    @just build-signed
    rm -rf "/Applications/Iris.app"
    cp -R "$CARGO_TARGET_DIR/release/bundle/macos/Iris.app" "/Applications/Iris.app"
    @echo "Installed → /Applications/Iris.app"

# Needs rsvg-convert (`brew install librsvg`). Only the desktop icons are kept.

# Regenerate the app icons from src-tauri/icons/source/iris.svg.
icons:
    rsvg-convert -w 1024 -h 1024 src-tauri/icons/source/iris.svg -o src-tauri/icons/source/iris-1024.png
    pnpm tauri icon src-tauri/icons/source/iris-1024.png
    rm -rf src-tauri/icons/android src-tauri/icons/ios

# Type-check the whole Rust workspace without building.
check:
    cargo check --workspace

# Run only the core unit + integration tests.
test-core:
    cargo test -p iris-core

# Scoped to the ssh_integration binary so it does not also run the lib's manual
# `live_keychain_round_trip` test. Must not use common.just recipes (CI has no import), not even as a dependency.

# Run the Dockerized OpenSSH integration tests (needs Docker).
test-integration:
    cargo test -p iris-core --test ssh_integration -- --ignored

# Format Rust + frontend.
format:
    cargo fmt --all
    pnpm format

# Set the version and sync it across Cargo.toml, tauri.conf.json, package.json.
# Usage: just version 0.2.0
version new:
    bash ~/.ci-workflows/scripts/sync-version.sh --set {{ new }}

# Verify the version is identical across all three manifests.
version-check:
    bash ~/.ci-workflows/scripts/sync-version.sh --check
