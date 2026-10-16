//! A sync limited to files changed within a time window ("Only files
//! changed in"): the source is searched for what changed instead of
//! walking every folder, and the target is only looked up at the paths
//! found (`walk::stat_candidates`). The comparison itself is unchanged.
//!
//! - **Remote source** (a download): one `find` on the server over SSH
//!   (`remote_find.rs`), after reading the server's clock. When the server
//!   does not run commands (SFTP-only accounts, an `internal-sftp`
//!   chroot), has no GNU `find`, or its answer does not read, the folders
//!   are walked over SFTP with the same filter instead. [`SearchMethod`]
//!   says which one ran.
//! - **Local source** (an upload): the local walk with the filter; it is
//!   fast enough without a search.
//! - **Server clock**: file dates on the server come from its clock, so a
//!   clock more than [`CLOCK_SKEW_TOLERANCE_SECS`] off ours moves the
//!   cutoff by the difference (for the search and the walk alike) and the
//!   plan reports it.
//! - Only changes are seen: files deleted on the source are not, so Mirror
//!   is refused with a window.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;

use crate::error::{CoreError, CoreResult};
use crate::fs::is_dotfile;
use crate::fs::walk::{close_channels, is_connection, open_walk_channels};
use crate::session_manager::LiveSession;
use crate::ssh::exec::ExecLimits;
use crate::transfer::side::Side;
use crate::transfer::{BROKEN_LINK, DIR_LINK, SPECIAL, UNSAFE_NAME};

use super::diff::{DiffRules, Listed, Node};
use super::exclude;
use super::remote_find::{
    clock_skew, find_script, left_out, parse_clock, parse_find, server_cutoff, FindQuery, Found,
    CLOCK_COMMAND, CLOCK_TIMEOUT, FIND_COMMAND, FIND_OUTPUT_LIMIT, FIND_TIMEOUT,
};
use super::walk::{in_window, walk, UNREADABLE_FOLDER};
use super::{ScanProgress, SyncScanStage};

pub use super::remote_find::CLOCK_SKEW_TOLERANCE_SECS;

/// The time window of a sync in [`super::SyncOptions`]: only files changed
/// at or after `since_unix` (unix seconds, our clock) are compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedWithin {
    pub since_unix: i64,
}

/// How the changed files of a windowed sync were found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchMethod {
    /// One `find` on the server.
    ServerFind,
    /// The folders were walked (always for a local source).
    Walk,
}

/// What a windowed plan reports about its search (`SyncPlan::window`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWindow {
    /// The cutoff asked for (our clock).
    pub since_unix: i64,
    pub method: SearchMethod,
    /// How far the server's clock is ahead of ours (negative: behind),
    /// when it was beyond the tolerance and the cutoff was moved by it.
    pub clock_skew_secs: Option<i64>,
}

/// The source side of a windowed download.
pub(crate) struct Search {
    pub listed: Vec<Listed>,
    pub method: SearchMethod,
    pub clock_skew_secs: Option<i64>,
}

/// Unix seconds now, by our clock.
pub(crate) fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Find what changed below the remote folder `root` since `since` (our
/// clock): the server search, else a filtered walk (see the module docs).
/// `NotConnected` when the connection goes; nothing else fails the search
/// (the walk's own errors aside).
pub(crate) async fn search_remote(
    live: &Arc<LiveSession>,
    root: &str,
    since: i64,
    rules: &DiffRules,
    progress: &ScanProgress<'_>,
) -> CoreResult<Search> {
    progress.begin(SyncScanStage::Searching, 0);
    let local_now = now_unix();
    let clock = live
        .ssh
        .exec(
            CLOCK_COMMAND,
            b"",
            ExecLimits {
                max_output: 256,
                timeout: CLOCK_TIMEOUT,
            },
            &mut |_| {},
        )
        .await;
    let (runs_commands, skew) = match clock {
        Ok(out) => (
            true,
            parse_clock(&out.stdout).and_then(|server| clock_skew(server, local_now)),
        ),
        Err(CoreError::NotConnected) => return Err(CoreError::NotConnected),
        Err(e) => {
            tracing::info!(kind = e.kind(), "the server does not run commands; walking");
            (false, None)
        }
    };
    if let Some(skew) = skew {
        tracing::info!(skew, "the server's clock differs; moving the cutoff");
    }
    let since = server_cutoff(since, skew);

    if runs_commands {
        match server_find(live, root, since, rules, progress).await {
            Ok(Some(listed)) => {
                return Ok(Search {
                    listed,
                    method: SearchMethod::ServerFind,
                    clock_skew_secs: skew,
                })
            }
            Ok(None) => {}
            Err(e) => return Err(e),
        }
    }

    progress.begin(SyncScanStage::Scanning, 0);
    let prune = |name: &str, hidden: bool| {
        exclude::first_match(&rules.excludes, name).is_some()
            || (rules.skip_hidden && (hidden || is_dotfile(name)))
    };
    let (listers, extra) = open_walk_channels(live).await;
    let walked = walk(
        listers,
        crate::fs::REMOTE_LISTINGS,
        root,
        &prune,
        Some(since),
        progress,
    )
    .await;
    close_channels(extra);
    Ok(Search {
        listed: walked?,
        method: SearchMethod::Walk,
        clock_skew_secs: skew,
    })
}

/// The `find` search; `Ok(None)` when it cannot be used (the reason is
/// logged), so the caller walks instead.
async fn server_find(
    live: &Arc<LiveSession>,
    root: &str,
    since: i64,
    rules: &DiffRules,
    progress: &ScanProgress<'_>,
) -> CoreResult<Option<Vec<Listed>>> {
    let query = FindQuery {
        root,
        since,
        excludes: &rules.excludes,
        skip_hidden: rules.skip_hidden,
    };
    let Some(script) = find_script(&query) else {
        return Ok(None);
    };
    // Each record is four NUL-terminated fields (the header is one more).
    let mut nuls = 0u64;
    let mut count = |chunk: &[u8]| {
        nuls += chunk.iter().filter(|b| **b == 0).count() as u64;
        progress.set_found(nuls.saturating_sub(1) / 4);
    };
    let started = std::time::Instant::now();
    let ran = live
        .ssh
        .exec(
            FIND_COMMAND,
            script.as_bytes(),
            ExecLimits {
                max_output: FIND_OUTPUT_LIMIT,
                timeout: FIND_TIMEOUT,
            },
            &mut count,
        )
        .await;
    let out = match ran {
        Ok(out) => out,
        Err(CoreError::NotConnected) => return Err(CoreError::NotConnected),
        Err(e) => {
            tracing::info!(kind = e.kind(), "the server search did not run; walking");
            return Ok(None);
        }
    };
    let found = match parse_find(&out.stdout) {
        Ok(found) => found,
        Err(why) => {
            tracing::info!(?why, "the server search gave no usable answer; walking");
            return Ok(None);
        }
    };
    tracing::debug!(
        records = found.len(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "server search done"
    );
    let side = Side::Remote(live.ssh.fs().clone());
    let listed = listing(found, since, rules, root, &side).await?;
    Ok(Some(listed))
}

/// The search's records as the walk would have listed them (see
/// `remote_find.rs` for the rules); links to files are looked up over
/// SFTP for their target's size and date.
async fn listing(
    found: Vec<Found>,
    since: i64,
    rules: &DiffRules,
    root: &str,
    side: &Side,
) -> CoreResult<Vec<Listed>> {
    let mut out = Vec::new();
    let mut links = Vec::new();
    let unsupported = |segments: Vec<String>, why: &str| Listed {
        hidden: segments.last().is_some_and(|n| is_dotfile(n)),
        segments,
        node: Node::Unsupported(why.into()),
    };
    for record in found {
        if left_out(&record, &rules.excludes, rules.skip_hidden) {
            continue;
        }
        match record {
            Found::File {
                segments,
                size,
                mtime,
            } => {
                if mtime >= since {
                    out.push(Listed {
                        hidden: segments.last().is_some_and(|n| is_dotfile(n)),
                        segments,
                        node: Node::File {
                            size,
                            mtime: Some(mtime),
                        },
                    });
                }
            }
            Found::Special { segments, mtime } if mtime >= since => {
                out.push(unsupported(segments, SPECIAL));
            }
            Found::Special { .. } => {}
            Found::Unreadable { segments } => out.push(unsupported(segments, UNREADABLE_FOLDER)),
            Found::Unsafe { segments } => out.push(unsupported(segments, UNSAFE_NAME)),
            Found::Link {
                segments,
                target: 'd',
                mtime,
            } => {
                if mtime >= since {
                    out.push(unsupported(segments, DIR_LINK));
                }
            }
            Found::Link {
                segments,
                target: 'N' | 'L' | '?',
                mtime,
            } => {
                if mtime >= since {
                    out.push(unsupported(segments, BROKEN_LINK));
                }
            }
            Found::Link {
                segments, mtime, ..
            } => links.push((segments, mtime)),
        }
    }

    // Links to files: their target decides, as in the walk.
    let mut running = JoinSet::new();
    let mut queue = links.into_iter();
    loop {
        while running.len() < crate::fs::REMOTE_LISTINGS {
            let Some((segments, own_mtime)) = queue.next() else {
                break;
            };
            let path = segments
                .iter()
                .fold(root.to_string(), |path, name| side.join(&path, name));
            let side = side.clone();
            running.spawn(async move { (segments, own_mtime, side.metadata(&path).await) });
        }
        let Some(joined) = running.join_next().await else {
            break;
        };
        let Ok((segments, own_mtime, meta)) = joined else {
            continue;
        };
        match meta {
            Ok(Some(meta)) if !meta.is_dir => {
                if in_window(meta.mtime, since) {
                    out.push(Listed {
                        hidden: segments.last().is_some_and(|n| is_dotfile(n)),
                        segments,
                        node: Node::File {
                            size: meta.size,
                            mtime: meta.mtime,
                        },
                    });
                }
            }
            // It turned into a folder link since the search.
            Ok(Some(_)) if own_mtime >= since => out.push(unsupported(segments, DIR_LINK)),
            Ok(Some(_)) => {}
            Err(e) if is_connection(&e) => return Err(e),
            Ok(None) | Err(_) if own_mtime >= since => out.push(unsupported(segments, BROKEN_LINK)),
            Ok(None) | Err(_) => {}
        }
    }
    out.sort_by(|a, b| a.segments.cmp(&b.segments));
    out.dedup_by(|a, b| a.segments == b.segments);
    Ok(out)
}
