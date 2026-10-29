# Iris — development tasks. Run `just` to see them.

# Share one target/ across the main checkout and every git worktree. A fresh
# worktree otherwise starts cold and rebuilds every dependency (minutes);
# pointing it at the main checkout's target/ keeps them warm.
# ponytail: cargo locks the target dir, so two builds in different worktrees
# serialise instead of running in parallel — still far cheaper than a cold
# rebuild. Falls back to ./target outside a git checkout.
export CARGO_TARGET_DIR := `dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$PWD/.git")"` / "target"

# Shared recipes (dev, dev-signed, build, build-signed, install-signed, check,
# test-core, format, version, version-check, rust, frontend, ci, sweep) come from
# the rust-base clone: `ln -s /path/to/rust-base ~/.rust-base`.
# Run `just --list` to see them. Don't redefine those names here.
import? '~/.rust-base/ci/common.just'

# Show available recipes.
default:
    @just --list

# Needs rsvg-convert (`brew install librsvg`). Only the desktop icons are kept.

# Regenerate the app icons from src-tauri/icons/source/iris.svg.
icons:
    rsvg-convert -w 1024 -h 1024 src-tauri/icons/source/iris.svg -o src-tauri/icons/source/iris-1024.png
    pnpm tauri icon src-tauri/icons/source/iris-1024.png
    rm -rf src-tauri/icons/android src-tauri/icons/ios

# Scoped to the ssh_integration binary so it does not also run the lib's manual
# `live_keychain_round_trip` test. Must not use common.just recipes (CI has no import), not even as a dependency.

# Run the Dockerized OpenSSH integration tests (needs Docker).
test-integration:
    cargo test -p iris-core --test ssh_integration -- --ignored
