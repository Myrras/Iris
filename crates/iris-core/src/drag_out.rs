//! Dragging remote files out of the window, to Finder / Explorer.
//!
//! An OS drag hands over **files on disk**, so a remote selection is
//! downloaded first: [`Core::prepare_drag_out`] walks it (folders
//! recursively), refuses it up front when it is over the
//! [`DragOutLimits`] (the UI then offers "Download to…", a normal queued
//! download), and downloads it into `<cacheDir>/dragout/<dragId>/` with
//! [`CoreEvent::DragOutProgress`] along the way. The UI starts the native
//! drag with the returned local paths.
//!
//! The download uses the session's main SFTP channel, not the transfer
//! queue: it is a short, interactive step the user is waiting on (pointer
//! held outside the window), it must not show up in the transfer list, and
//! it must not wait behind queued jobs. The walk follows the transfer
//! engine's rules: a selected link is followed, links inside a folder are
//! skipped (they could loop), sockets/devices and unsafe names are skipped.
//!
//! ## Cleanup
//! [`Core::cancel_drag_out`] stops a preparation (or throws away a
//! prepared one); [`Core::finish_drag_out`] ends a drag: cancelled → removed
//! at once, dropped → removed after a grace period, because the file
//! manager that took the drop may still be copying from it. Quitting
//! ([`Core::clean_drag_outs`]) and startup ([`Core::set_cache_dir`]) remove
//! the whole `dragout` folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEvent;
use crate::fs::{posix_name, sftp_io_error, EntryKind, FileSystem, LinkTargetKind, SftpFs};
use crate::ids::{DragOutId, SessionId};
use crate::transfer::naming::is_safe_name;
use crate::transfer::progress::{Throttle, PROGRESS_INTERVAL};
use crate::Core;

const LOCK_POISONED: &str = "drag-out registry lock poisoned";

/// The folder under the cache dir that holds every prepared drag.
pub(crate) const DRAG_OUT_DIR: &str = "dragout";

/// Bytes read and written per step.
const CHUNK_SIZE: usize = 256 * 1024;

/// How long a dropped drag's files stay for the file manager to copy.
pub const DEFAULT_DROP_GRACE: Duration = Duration::from_secs(120);

/// How much a drag out of the Remote pane may download first. Above it the
/// UI offers "Download to…" instead: a drag that waits minutes for its
/// files feels broken, and the files would sit in the cache twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DragOutLimits {
    /// Total size of every file in the selection.
    pub max_bytes: u64,
    /// Number of files in the selection (folders are not counted).
    pub max_files: u64,
}

impl Default for DragOutLimits {
    fn default() -> Self {
        Self {
            max_bytes: 200 * 1024 * 1024,
            max_files: 500,
        }
    }
}

/// A prepared drag: the local copies of the selected items, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutReady {
    pub drag_id: DragOutId,
    /// Absolute local paths of the selected items (files or folders).
    pub paths: Vec<String>,
    /// Files downloaded (folders not counted).
    pub files: u64,
    pub total_bytes: u64,
}

struct DragEntry {
    /// Set while preparing; cancelling it stops the download.
    token: Option<CancellationToken>,
    dir: PathBuf,
}

/// The drags being prepared or handed to the OS. Owned by [`Core`].
pub(crate) struct DragOutManager {
    drags: Mutex<HashMap<DragOutId, DragEntry>>,
    limits: Mutex<DragOutLimits>,
    grace: Mutex<Duration>,
}

impl Default for DragOutManager {
    fn default() -> Self {
        Self {
            drags: Mutex::default(),
            limits: Mutex::default(),
            grace: Mutex::new(DEFAULT_DROP_GRACE),
        }
    }
}

impl DragOutManager {
    fn limits(&self) -> DragOutLimits {
        *self.limits.lock().expect(LOCK_POISONED)
    }

    fn take(&self, id: DragOutId) -> Option<DragEntry> {
        self.drags.lock().expect(LOCK_POISONED).remove(&id)
    }
}

/// One file of the plan: where it comes from, where it goes (relative to
/// the drag folder).
struct PlannedFile {
    remote: String,
    local: PathBuf,
    size: u64,
    mtime: Option<i64>,
    mode: Option<u32>,
}

#[derive(Default)]
struct Plan {
    /// Folders to create, parents first (relative).
    dirs: Vec<PathBuf>,
    files: Vec<PlannedFile>,
    /// The selected items' names, in order.
    tops: Vec<String>,
    bytes: u64,
}

impl Plan {
    fn add_file(&mut self, file: PlannedFile, limits: DragOutLimits) -> CoreResult<()> {
        self.bytes = self.bytes.saturating_add(file.size);
        self.files.push(file);
        if self.files.len() as u64 > limits.max_files || self.bytes > limits.max_bytes {
            return Err(CoreError::TooLarge(format!(
                "a drag can bring along up to {} files and {} MB",
                limits.max_files,
                limits.max_bytes / (1024 * 1024)
            )));
        }
        Ok(())
    }
}

impl Core {
    /// Limit what a drag out may download first (default
    /// [`DragOutLimits::default`]; tests lower it).
    pub fn set_drag_out_limits(&self, limits: DragOutLimits) {
        *self.inner.drag_outs.limits.lock().expect(LOCK_POISONED) = limits;
    }

    /// How long a dropped drag's files are kept (default
    /// [`DEFAULT_DROP_GRACE`]; tests shorten it).
    pub fn set_drag_out_grace(&self, grace: Duration) {
        *self.inner.drag_outs.grace.lock().expect(LOCK_POISONED) = grace;
    }

    /// Download the remote `paths` of a session into
    /// `<cacheDir>/dragout/<dragId>/` so they can be dragged out as local
    /// files (see the module docs). `drag_id` comes from the caller so it
    /// can match the progress events and cancel before this returns.
    ///
    /// `TooLarge` over the limits (checked before anything is downloaded),
    /// `Cancelled` after [`Core::cancel_drag_out`], `NotConnected`,
    /// `NotFound` for a missing item, `InvalidInput` for an empty or odd
    /// selection or a drag id in use, `Config` without a cache dir.
    pub async fn prepare_drag_out(
        &self,
        drag_id: DragOutId,
        session_id: SessionId,
        paths: Vec<String>,
    ) -> CoreResult<DragOutReady> {
        let root = self
            .inner
            .edits
            .cache_dir()
            .ok_or_else(|| CoreError::Config("the cache folder is not configured".into()))?
            .join(DRAG_OUT_DIR);
        if paths.is_empty() {
            return Err(CoreError::InvalidInput("nothing to drag".into()));
        }
        let live = self.inner.sessions.get(session_id)?;
        let dir = root.join(drag_id.to_string());
        let token = CancellationToken::new();
        {
            let mut drags = self.inner.drag_outs.drags.lock().expect(LOCK_POISONED);
            if drags.contains_key(&drag_id) {
                return Err(CoreError::InvalidInput(
                    "this drag is already being prepared".into(),
                ));
            }
            drags.insert(
                drag_id,
                DragEntry {
                    token: Some(token.clone()),
                    dir: dir.clone(),
                },
            );
        }

        let limits = self.inner.drag_outs.limits();
        let fs = live.ssh.fs();
        let result = async {
            let plan = plan(fs, &paths, limits, &token).await?;
            self.download(drag_id, fs, &plan, &dir, &token).await?;
            Ok(DragOutReady {
                drag_id,
                paths: plan
                    .tops
                    .iter()
                    .map(|name| dir.join(name).to_string_lossy().into_owned())
                    .collect(),
                files: plan.files.len() as u64,
                total_bytes: plan.bytes,
            })
        }
        .await;
        // A cancel that raced the last write still wins: nothing is handed
        // out after `cancel_drag_out`.
        let result = match result {
            Ok(_) if token.is_cancelled() => Err(CoreError::Cancelled),
            other => other,
        };
        match self.forget_if_lost(session_id, live.generation, result) {
            Ok(ready) => {
                let mut drags = self.inner.drag_outs.drags.lock().expect(LOCK_POISONED);
                match drags.get_mut(&drag_id) {
                    Some(entry) => entry.token = None,
                    // Finished while the last step ran: nothing to keep.
                    None => remove_dir(&dir),
                }
                Ok(ready)
            }
            Err(e) => {
                self.inner.drag_outs.take(drag_id);
                remove_dir(&dir);
                Err(e)
            }
        }
    }

    /// Stop preparing a drag (its call returns `Cancelled`), or throw away
    /// a prepared one. Unknown ids are ignored.
    pub fn cancel_drag_out(&self, drag_id: DragOutId) {
        let mut drags = self.inner.drag_outs.drags.lock().expect(LOCK_POISONED);
        match drags.get(&drag_id).and_then(|e| e.token.clone()) {
            // `prepare_drag_out` cleans up itself.
            Some(token) => token.cancel(),
            None => {
                if let Some(entry) = drags.remove(&drag_id) {
                    remove_dir(&entry.dir);
                }
            }
        }
    }

    /// The OS drag ended. Cancelled → its files are removed now; dropped →
    /// after the grace period (the receiving app may still be copying).
    pub fn finish_drag_out(&self, drag_id: DragOutId, dropped: bool) {
        let Some(entry) = self.inner.drag_outs.take(drag_id) else {
            return;
        };
        if let Some(token) = entry.token {
            token.cancel();
        }
        let runtime = tokio::runtime::Handle::try_current();
        match runtime {
            Ok(runtime) if dropped => {
                let grace = *self.inner.drag_outs.grace.lock().expect(LOCK_POISONED);
                let dir = entry.dir;
                runtime.spawn(async move {
                    tokio::time::sleep(grace).await;
                    remove_dir(&dir);
                });
            }
            _ => remove_dir(&entry.dir),
        }
    }

    /// Quitting: stop every preparation and remove all prepared files.
    pub fn clean_drag_outs(&self) {
        let drags: Vec<DragEntry> = self
            .inner
            .drag_outs
            .drags
            .lock()
            .expect(LOCK_POISONED)
            .drain()
            .map(|(_, entry)| entry)
            .collect();
        for entry in drags {
            if let Some(token) = entry.token {
                token.cancel();
            }
        }
        if let Some(cache) = self.inner.edits.cache_dir() {
            remove_dir(&cache.join(DRAG_OUT_DIR));
        }
    }

    async fn download(
        &self,
        drag_id: DragOutId,
        fs: &SftpFs,
        plan: &Plan,
        dir: &Path,
        token: &CancellationToken,
    ) -> CoreResult<()> {
        let at = |path: &Path, e| CoreError::from_io_at(e, &path.to_string_lossy());
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| at(dir, e))?;
        for rel in &plan.dirs {
            let path = dir.join(rel);
            tokio::fs::create_dir_all(&path)
                .await
                .map_err(|e| at(&path, e))?;
        }
        let local_fs = self.local();
        let mut done: u64 = 0;
        let mut throttle = Throttle::new(PROGRESS_INTERVAL);
        let mut buf = vec![0u8; CHUNK_SIZE];
        let progress = |done: u64| CoreEvent::DragOutProgress {
            drag_id,
            bytes_done: done.min(plan.bytes),
            total_bytes: plan.bytes,
        };
        for file in &plan.files {
            let local = dir.join(&file.local);
            let mut reader = fs.open_reader(&file.remote, 0).await?;
            let mut writer = tokio::fs::File::create(&local)
                .await
                .map_err(|e| at(&local, e))?;
            loop {
                if token.is_cancelled() {
                    return Err(CoreError::Cancelled);
                }
                let n = reader
                    .read(&mut buf)
                    .await
                    .map_err(|e| sftp_io_error(e, &file.remote, "read"))?;
                if n == 0 {
                    break;
                }
                writer
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| at(&local, e))?;
                done += n as u64;
                if throttle.ready(Instant::now()) {
                    self.inner.events.publish(progress(done));
                }
            }
            writer.flush().await.map_err(|e| at(&local, e))?;
            drop(writer);
            local_fs
                .set_times(
                    &local.to_string_lossy(),
                    file.mtime,
                    file.mode.map(|m| m & 0o777),
                )
                .await?;
        }
        self.inner.events.publish(progress(plan.bytes));
        Ok(())
    }
}

/// Walk the selection into a [`Plan`], refusing it as soon as it is over
/// `limits` (nothing is downloaded yet).
async fn plan(
    fs: &SftpFs,
    paths: &[String],
    limits: DragOutLimits,
    token: &CancellationToken,
) -> CoreResult<Plan> {
    let mut plan = Plan::default();
    for path in paths {
        let name = posix_name(path);
        if !is_safe_name(&name) || plan.tops.contains(&name) {
            return Err(CoreError::InvalidInput(format!(
                "{path} cannot be dragged out"
            )));
        }
        let entry = fs.stat(path).await?;
        let is_dir = match entry.kind {
            EntryKind::Dir => true,
            EntryKind::File => false,
            // The user picked the link: follow it.
            EntryKind::Symlink { .. } => match fs.metadata(path).await? {
                Some(meta) => meta.is_dir,
                None => return Err(CoreError::NotFound(path.to_string())),
            },
            EntryKind::Other => {
                return Err(CoreError::InvalidInput(format!(
                    "{path}: only files and folders can be dragged out"
                )))
            }
        };
        if is_dir {
            walk(fs, path, PathBuf::from(&name), &mut plan, limits, token).await?;
        } else {
            let meta = fs
                .metadata(path)
                .await?
                .ok_or_else(|| CoreError::NotFound(path.to_string()))?;
            plan.add_file(
                PlannedFile {
                    remote: path.clone(),
                    local: PathBuf::from(&name),
                    size: meta.size,
                    mtime: meta.mtime,
                    mode: meta.mode,
                },
                limits,
            )?;
        }
        plan.tops.push(name);
    }
    Ok(plan)
}

/// Add the folder `root` (as `rel`) and everything in it, depth-first.
async fn walk(
    fs: &SftpFs,
    root: &str,
    rel: PathBuf,
    plan: &mut Plan,
    limits: DragOutLimits,
    token: &CancellationToken,
) -> CoreResult<()> {
    let mut stack = vec![(root.to_string(), rel)];
    while let Some((dir, rel)) = stack.pop() {
        if token.is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let mut entries = fs.list(&dir).await?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        plan.dirs.push(rel.clone());
        let mut subfolders = Vec::new();
        for entry in entries {
            if !is_safe_name(&entry.name) {
                continue;
            }
            let size = match entry.kind {
                EntryKind::File => entry.size,
                // A link to a file is copied as the file (its own size is
                // the link's).
                EntryKind::Symlink {
                    target_kind: Some(LinkTargetKind::File),
                    ..
                } => match fs.metadata(&entry.path).await? {
                    Some(meta) => meta.size,
                    None => continue,
                },
                EntryKind::Dir => {
                    subfolders.push(entry);
                    continue;
                }
                // Folder links (loops), broken links, sockets and devices.
                _ => continue,
            };
            plan.add_file(
                PlannedFile {
                    local: rel.join(&entry.name),
                    remote: entry.path,
                    size,
                    mtime: entry.mtime,
                    mode: entry.mode,
                },
                limits,
            )?;
        }
        // Reversed so the stack pops them in name order.
        for sub in subfolders.into_iter().rev() {
            stack.push((sub.path, rel.join(&sub.name)));
        }
    }
    Ok(())
}

/// Remove a folder of prepared files (best effort).
pub(crate) fn remove_dir(dir: &Path) {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("could not remove drag-out files: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_limits_are_200_mb_and_500_files() {
        let limits = DragOutLimits::default();
        assert_eq!(limits.max_bytes, 200 * 1024 * 1024);
        assert_eq!(limits.max_files, 500);
    }

    #[test]
    fn a_plan_over_either_limit_is_too_large() {
        let limits = DragOutLimits {
            max_bytes: 10,
            max_files: 2,
        };
        let file = |size| PlannedFile {
            remote: "/a".into(),
            local: PathBuf::from("a"),
            size,
            mtime: None,
            mode: None,
        };
        let mut plan = Plan::default();
        assert!(plan.add_file(file(5), limits).is_ok());
        assert!(plan.add_file(file(5), limits).is_ok());
        let err = plan.add_file(file(0), limits).unwrap_err();
        assert_eq!(err.kind(), "tooLarge");
        let mut plan = Plan::default();
        assert!(plan.add_file(file(11), limits).is_err());
    }

    #[test]
    fn ready_is_camel_case_on_the_wire() {
        let id = DragOutId::new();
        let ready = DragOutReady {
            drag_id: id,
            paths: vec!["/cache/dragout/x/report.pdf".into()],
            files: 1,
            total_bytes: 42,
        };
        assert_eq!(
            serde_json::to_value(&ready).unwrap(),
            serde_json::json!({
                "dragId": id.to_string(),
                "paths": ["/cache/dragout/x/report.pdf"],
                "files": 1,
                "totalBytes": 42,
            })
        );
    }
}
