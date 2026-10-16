//! One running job: check the destination, then copy.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{CoreError, CoreResult};
use crate::fs::Writer;
use crate::ids::TransferId;

use super::naming::keep_both_name;
use super::side::Side;
use super::{ConflictResolution, JobContext, Outcome, Shared, TransferDirection};

/// Bytes read and written per step.
pub(crate) const CHUNK_SIZE: usize = 256 * 1024;

/// How long a cancelled job waits for its writes in flight to land, so the
/// partial file it leaves is consistent.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Run job `id` to its outcome and record it.
pub(super) async fn run(shared: Arc<Shared>, id: TransferId) {
    let outcome = match shared.context(id) {
        Some(ctx) => execute(&shared, &ctx).await,
        None => Outcome::Cancelled,
    };
    shared.finish(id, outcome);
}

async fn execute(shared: &Shared, ctx: &JobContext) -> Outcome {
    if ctx.token.is_cancelled() {
        return Outcome::Cancelled;
    }
    let channel = match shared.take_channel(ctx.session_id).await {
        Ok(channel) => channel,
        Err(e) => return classify(shared, ctx, e).await,
    };
    let remote = Side::Remote(channel.clone());
    let local = Side::Local(shared.local());
    let (src, dst) = match ctx.direction {
        TransferDirection::Upload => (local, remote),
        TransferDirection::Download => (remote, local),
    };
    match copy(shared, ctx, &src, &dst).await {
        Ok(outcome) => {
            shared.return_channel(ctx.session_id, channel);
            outcome
        }
        // A broken channel is dropped, not pooled.
        Err(e) => classify(shared, ctx, e).await,
    }
}

/// A failure is a pause when the connection is gone (the job can resume
/// later), a cancel when the user asked for one, and a failure otherwise.
async fn classify(shared: &Shared, ctx: &JobContext, err: CoreError) -> Outcome {
    if ctx.token.is_cancelled() {
        Outcome::Cancelled
    } else if shared.connection_gone(ctx.session_id, &err).await {
        tracing::info!(kind = err.kind(), "transfer paused: the connection is gone");
        // The pooled channels went down with it.
        shared.forget_pool(ctx.session_id);
        Outcome::Paused
    } else {
        Outcome::Failed(err)
    }
}

async fn copy(shared: &Shared, ctx: &JobContext, src: &Side, dst: &Side) -> CoreResult<Outcome> {
    let src_meta = src
        .metadata(&ctx.src)
        .await?
        .ok_or_else(|| CoreError::NotFound(ctx.src.clone()))?;
    if src_meta.is_dir {
        return Err(CoreError::InvalidInput(format!("{} is a folder", ctx.src)));
    }
    shared.set_size(ctx.id, src_meta.size);

    let mut dst_path = dst.join(&ctx.dst_dir, &ctx.name);
    let offset = match dst.metadata(&dst_path).await? {
        None => 0,
        Some(existing) if existing.is_dir => {
            return Err(CoreError::AlreadyExists(dst_path));
        }
        // Our own partial copy (a paused job going on): append to it,
        // unless it cannot be a prefix of the source any more.
        Some(existing) if ctx.append && existing.size <= src_meta.size => existing.size,
        Some(_) if ctx.append => 0,
        Some(existing) => {
            let answer = ctx.resolution.or_else(|| shared.batch_policy(ctx.batch_id));
            match answer {
                None => {
                    return Ok(Outcome::Conflict {
                        src: src_meta,
                        dst: existing,
                    })
                }
                Some(ConflictResolution::Skip) => return Ok(Outcome::Skipped),
                Some(ConflictResolution::Replace) => 0,
                Some(ConflictResolution::KeepBoth) => {
                    let name = free_name(dst, &ctx.dst_dir, &ctx.name).await?;
                    dst_path = dst.join(&ctx.dst_dir, &name);
                    shared.set_destination(ctx.id, name, dst_path.clone());
                    0
                }
                Some(ConflictResolution::Resume) => {
                    if existing.size < src_meta.size {
                        existing.size
                    } else if existing.size == src_meta.size {
                        // Already a full copy; nothing to append.
                        shared.set_bytes_done(ctx.id, src_meta.size);
                        return Ok(Outcome::Done);
                    } else {
                        // Larger than the source: it cannot be a partial
                        // copy of it, so it is replaced.
                        0
                    }
                }
            }
        }
    };

    // A cancel during the checks above must not truncate the destination.
    if ctx.token.is_cancelled() {
        return Ok(Outcome::Cancelled);
    }
    let mut reader = src.open_reader(&ctx.src, offset).await?;
    let mut writer = dst.open_writer(&dst_path, offset).await?;
    shared.start_writing(ctx.id, offset);

    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        let read = tokio::select! {
            biased;
            () = ctx.token.cancelled() => return Ok(cancelled(writer).await),
            read = reader.read(&mut buf) => read,
        };
        let n = read.map_err(|e| read_error(src, e, &ctx.src))?;
        if n == 0 {
            break;
        }
        tokio::select! {
            biased;
            () = ctx.token.cancelled() => return Ok(cancelled(writer).await),
            written = writer.write_all(&buf[..n]) => {
                written.map_err(|e| write_error(dst, e, &dst_path))?;
            }
        }
        shared.progress(ctx.id, n as u64);
    }
    writer
        .shutdown()
        .await
        .map_err(|e| write_error(dst, e, &dst_path))?;
    drop(reader);

    // Keep the source's modification time, and its permission bits (not
    // setuid/setgid/sticky) where the destination has them.
    let mode = src_meta.mode.map(|m| m & 0o777);
    dst.set_times(&dst_path, src_meta.mtime, mode).await?;
    Ok(Outcome::Done)
}

/// Let the writes in flight land (briefly) so the partial file is whole up
/// to where it stopped.
async fn cancelled(mut writer: Writer) -> Outcome {
    let _ = tokio::time::timeout(CLOSE_GRACE, writer.shutdown()).await;
    Outcome::Cancelled
}

/// The first `name (n).ext` (n ≥ 2) that is free in `dir`.
async fn free_name(side: &Side, dir: &str, name: &str) -> CoreResult<String> {
    for n in 2..10_000 {
        let candidate = keep_both_name(name, n);
        if !side.exists(&side.join(dir, &candidate)).await? {
            return Ok(candidate);
        }
    }
    Err(CoreError::AlreadyExists(side.join(dir, name)))
}

fn read_error(side: &Side, err: std::io::Error, path: &str) -> CoreError {
    match side {
        Side::Local(_) => CoreError::from_io_at(err, path),
        Side::Remote(_) => crate::fs::sftp_io_error(err, path, "read"),
    }
}

fn write_error(side: &Side, err: std::io::Error, path: &str) -> CoreError {
    match side {
        Side::Local(_) => CoreError::from_io_at(err, path),
        Side::Remote(_) => crate::fs::sftp_io_error(err, path, "write"),
    }
}
