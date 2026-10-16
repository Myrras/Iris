//! Remote edit: open a remote file in a local editor and upload every save.
//!
//! ## Shape
//! [`Core::open_remote`] downloads the file to
//! `<cacheDir>/edit/<sessionId>/<hash(path)>/<name>` (the cache dir is
//! injected by the shell, [`Core::set_cache_dir`]; tests use temp dirs),
//! records the remote **baseline** (size + mtime, re-statted after the
//! download), and asks the injected [`Opener`] to open the copy — with the
//! app from the `editorOverrides` setting for its extension, else the OS
//! default. Opening stays out of the core's dependencies: the shell
//! implements [`Opener`] (tauri-plugin-opener), tests use a fake.
//!
//! Each open file gets a watcher on its **folder** (not the file), debounced
//! (~500 ms): editors that save through a temp file and a rename replace
//! the file, which a watch on the file itself would lose. Any event in the
//! folder re-stats the copy; only a size or mtime different from the last
//! synced one counts as a save, so the editor's own temp and swap files are
//! ignored.
//!
//! ## A save
//! One task per edit handles its signals in order (a save, a resolution,
//! "the session is connected again"), so an edit never uploads twice at
//! once. A save stats the remote file: unchanged since the baseline →
//! upload (overwrite), re-baseline from the new remote stat,
//! [`CoreEvent::EditUploaded`]. Changed (or deleted) →
//! [`CoreEvent::EditConflict`] and the edit waits for
//! [`Core::resolve_edit`]: `overwrite` uploads anyway, `discard` downloads
//! the server copy over the local one (and re-baselines), `saveCopy`
//! uploads next to the original as `name (edited).ext` (or the first free
//! `name (edited n).ext`) and the edit follows that copy from then on.
//! Saves while a conflict is open are not uploaded; the answer applies to
//! the latest local content.
//!
//! A failed upload is [`CoreEvent::EditFailed`]; the next save tries again.
//! A session that is not connected (reconnecting, or down until a manual
//! Retry) parks the save — or the answer — until the session is back
//! (a reconnect signals the session's edits).
//!
//! ## Cleanup
//! [`Core::close_edit`] stops one; a user disconnect closes the session's
//! edits; quitting closes all ([`Core::close_all_edits`]). Each deletes its
//! local copies. [`Core::set_cache_dir`] (at startup) removes what an
//! earlier run left behind.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{CoreError, CoreResult};
use crate::events::CoreEvent;
use crate::fs::{join_posix, posix_name, sftp_io_error, FileMeta, SftpFs};
use crate::ids::{EditId, SessionId};
use crate::transfer::naming::{edited_copy_name, is_safe_name};
use crate::Core;

const LOCK_POISONED: &str = "edit registry lock poisoned";

/// Bytes read and written per step.
const CHUNK_SIZE: usize = 256 * 1024;

/// How long the watcher waits for an editor's burst of writes to settle.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(500);

/// How long [`Core::close_edit`] lets an upload in flight finish.
const CLOSE_GRACE: Duration = Duration::from_secs(30);

/// The folder under the cache dir that holds every local copy.
const EDIT_DIR: &str = "edit";

/// Opens a local file in an application. The shell implements it with
/// tauri-plugin-opener; tests use a fake.
pub trait Opener: Send + Sync {
    /// Open `path` with `app` (a path to an application or executable), or
    /// with the OS default when `None`. Errors are app-owned text.
    fn open(&self, path: &Path, app: Option<&str>) -> CoreResult<()>;
}

/// The opener of a core the shell did not set one on.
struct NoOpener;

impl Opener for NoOpener {
    fn open(&self, _path: &Path, _app: Option<&str>) -> CoreResult<()> {
        Err(CoreError::Config("opening files is not configured".into()))
    }
}

/// The answer to a [`CoreEvent::EditConflict`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditResolution {
    /// Upload the local copy over the server's.
    Overwrite,
    /// Throw the local changes away: download the server copy over them.
    Discard,
    /// Upload the local copy next to the original as `name (edited).ext`.
    SaveCopy,
}

/// What a remote file looked like: size and mtime (unix seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStamp {
    pub size: u64,
    pub mtime: Option<i64>,
}

impl From<FileMeta> for RemoteStamp {
    fn from(meta: FileMeta) -> Self {
        Self {
            size: meta.size,
            mtime: meta.mtime,
        }
    }
}

/// Where an edit is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditStatus {
    /// The server has the latest save (or nothing was saved yet).
    Synced,
    /// A save (or an answer to a conflict) is being uploaded.
    Uploading,
    /// A save or an answer waits for the session to be connected again.
    WaitingForConnection,
    /// The server copy changed since it was opened; waits for
    /// `resolve_edit`.
    Conflict,
    /// The last upload failed; the next save tries again.
    Failed,
}

impl EditStatus {
    /// Holds changes the server does not have yet (counts for the close
    /// guard).
    fn is_active(self) -> bool {
        matches!(
            self,
            Self::Uploading | Self::WaitingForConnection | Self::Conflict
        )
    }
}

/// One remote file open for editing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInfo {
    pub id: EditId,
    pub session_id: SessionId,
    /// The remote file saves go to (an edited copy's after `saveCopy`).
    pub path: String,
    /// Its file name.
    pub name: String,
    /// The local copy the editor has open.
    pub local_path: String,
    pub status: EditStatus,
    /// The server copy as of the last download or upload.
    pub baseline: RemoteStamp,
}

/// A local file's size and mtime: what tells a save apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalStamp {
    size: u64,
    modified: Option<SystemTime>,
}

enum Signal {
    /// Something changed in the copy's folder.
    Changed,
    /// The session is connected again.
    Connected,
    /// `resolve_edit` recorded an answer.
    Resolve,
}

struct EditEntry {
    info: EditInfo,
    /// `<cache>/edit/<session>/<hash>`, holding only this copy (and the
    /// editor's temp files).
    dir: PathBuf,
    local: PathBuf,
    /// The local copy as of the last download or upload.
    synced: Option<LocalStamp>,
    /// An answer to a conflict, not applied yet.
    resolution: Option<EditResolution>,
    tx: mpsc::UnboundedSender<Signal>,
    task: Option<tokio::task::JoinHandle<()>>,
    /// Dropping it stops the watch.
    _watcher: Debouncer<RecommendedWatcher>,
}

#[derive(Default)]
struct Registry {
    edits: HashMap<EditId, EditEntry>,
    /// `open_remote` calls in progress, by session and remote path.
    opening: HashSet<(SessionId, String)>,
}

/// The open edits and where their copies live. Owned by [`Core`].
pub(crate) struct EditManager {
    registry: Mutex<Registry>,
    cache_dir: Mutex<Option<PathBuf>>,
    opener: Mutex<Arc<dyn Opener>>,
    debounce: Mutex<Duration>,
}

impl Default for EditManager {
    fn default() -> Self {
        Self {
            registry: Mutex::default(),
            cache_dir: Mutex::default(),
            opener: Mutex::new(Arc::new(NoOpener)),
            debounce: Mutex::new(DEFAULT_DEBOUNCE),
        }
    }
}

impl EditManager {
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().expect(LOCK_POISONED)
    }

    /// The app cache dir (shared with `drag_out`).
    pub(crate) fn cache_dir(&self) -> Option<PathBuf> {
        self.cache_dir.lock().expect(LOCK_POISONED).clone()
    }

    fn edit_root(&self) -> Option<PathBuf> {
        self.cache_dir
            .lock()
            .expect(LOCK_POISONED)
            .as_ref()
            .map(|dir| dir.join(EDIT_DIR))
    }

    /// Whether any edit holds changes the server does not have yet.
    pub fn has_active(&self) -> bool {
        self.lock()
            .edits
            .values()
            .any(|e| e.info.status.is_active() || e.resolution.is_some())
    }

    /// Tell the session's edits it is connected again, so parked saves and
    /// answers go out.
    pub fn session_connected(&self, session_id: SessionId) {
        for entry in self.lock().edits.values() {
            if entry.info.session_id == session_id {
                let _ = entry.tx.send(Signal::Connected);
            }
        }
    }

    fn set_status(&self, id: EditId, status: EditStatus) {
        if let Some(entry) = self.lock().edits.get_mut(&id) {
            entry.info.status = status;
        }
    }

    /// Take edits out of the registry (stopping their watchers); returns
    /// their tasks and folders.
    fn take(&self, which: impl Fn(&EditInfo) -> bool) -> Vec<(EditTask, PathBuf)> {
        let mut reg = self.lock();
        let ids: Vec<EditId> = reg
            .edits
            .values()
            .filter(|e| which(&e.info))
            .map(|e| e.info.id)
            .collect();
        ids.into_iter()
            .filter_map(|id| reg.edits.remove(&id))
            .map(|mut entry| (entry.task.take(), entry.dir))
            .collect()
    }
}

type EditTask = Option<tokio::task::JoinHandle<()>>;

/// What one sync of a save found.
enum Synced {
    Uploaded(RemoteStamp),
    /// The server copy is not the baseline any more (`None`: deleted).
    Conflict(Option<RemoteStamp>),
}

impl Core {
    /// Keep local copies of files opened for editing (and files prepared
    /// for a drag out) under `dir` (the shell passes its app cache dir;
    /// tests a temp dir). Removes what an earlier run left in `<dir>/edit`
    /// and `<dir>/dragout`.
    pub fn set_cache_dir(&self, dir: PathBuf) {
        let edits = &self.inner.edits;
        // Watch events carry canonical paths (`/private/var/…` for
        // `/var/…` on macOS); resolving it once keeps every path alike.
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        crate::drag_out::remove_dir(&dir.join(crate::drag_out::DRAG_OUT_DIR));
        *edits.cache_dir.lock().expect(LOCK_POISONED) = Some(dir);
        if edits.lock().edits.is_empty() {
            if let Some(root) = edits.edit_root() {
                remove_dir(&root);
            }
        }
    }

    /// Open files for editing with `opener` (the shell's; tests a fake).
    pub fn set_opener(&self, opener: Arc<dyn Opener>) {
        *self.inner.edits.opener.lock().expect(LOCK_POISONED) = opener;
    }

    /// How long a local copy must be quiet before a save is uploaded
    /// (default [`DEFAULT_DEBOUNCE`]; tests shorten it). Applies to files
    /// opened afterwards.
    pub fn set_edit_debounce(&self, debounce: Duration) {
        *self.inner.edits.debounce.lock().expect(LOCK_POISONED) = debounce;
    }

    /// Open the remote file `path` in a local editor: download it, watch
    /// the copy, and upload each save (see the module docs). A file already
    /// open in the session is shown again (same id, no new download).
    /// `NotConnected` when the session is not connected, `InvalidInput` for
    /// a folder, `Config` without a cache dir.
    pub async fn open_remote(&self, session_id: SessionId, path: &str) -> CoreResult<EditId> {
        let edits = &self.inner.edits;
        let existing = edits
            .lock()
            .edits
            .values()
            .find(|e| e.info.session_id == session_id && e.info.path == path)
            .map(|e| (e.info.id, e.local.clone()));
        if let Some((id, local)) = existing {
            self.open_in_editor(&local)?;
            return Ok(id);
        }
        let root = edits
            .edit_root()
            .ok_or_else(|| CoreError::Config("the cache folder is not configured".into()))?;
        let name = posix_name(path);
        if !is_safe_name(&name) {
            return Err(CoreError::InvalidInput(format!(
                "{path} cannot be opened for editing"
            )));
        }
        let key = (session_id, path.to_string());
        if !edits.lock().opening.insert(key.clone()) {
            return Err(CoreError::InvalidInput(format!(
                "{path} is already being opened"
            )));
        }
        let result = self.start_edit(session_id, path, &name, &root).await;
        edits.lock().opening.remove(&key);
        result
    }

    async fn start_edit(
        &self,
        session_id: SessionId,
        path: &str,
        name: &str,
        root: &Path,
    ) -> CoreResult<EditId> {
        let live = self.inner.sessions.get(session_id)?;
        let fs = live.ssh.fs();
        let dir = root.join(session_id.to_string()).join(path_hash(path));
        let local = dir.join(name);
        let fetched = async {
            match fs.metadata(path).await? {
                None => return Err(CoreError::NotFound(path.to_string())),
                Some(meta) if meta.is_dir => {
                    return Err(CoreError::InvalidInput(format!("{path} is a folder")))
                }
                Some(_) => {}
            }
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| CoreError::from_io_at(e, &dir.to_string_lossy()))?;
            download(fs, path, &local).await?;
            remote_stamp(fs, path).await
        }
        .await;
        let baseline = match self.forget_if_lost(session_id, live.generation, fetched) {
            Ok(baseline) => baseline,
            Err(e) => {
                remove_dir(&dir);
                return Err(e);
            }
        };
        let synced = local_stamp(&local).await.ok();

        let id = EditId::new();
        let (tx, rx) = mpsc::unbounded_channel();
        let watcher = match watch(&dir, self.edit_debounce(), tx.clone()) {
            Ok(watcher) => watcher,
            Err(e) => {
                remove_dir(&dir);
                return Err(e);
            }
        };
        let task = self.spawn_edit_task(id, rx);
        let info = EditInfo {
            id,
            session_id,
            path: path.to_string(),
            name: name.to_string(),
            local_path: local.to_string_lossy().into_owned(),
            status: EditStatus::Synced,
            baseline,
        };
        self.inner.edits.lock().edits.insert(
            id,
            EditEntry {
                info,
                dir,
                local: local.clone(),
                synced,
                resolution: None,
                tx,
                task: Some(task),
                _watcher: watcher,
            },
        );
        tracing::info!("opened a remote file for editing");
        if let Err(e) = self.open_in_editor(&local) {
            self.close_edit(id).await?;
            return Err(e);
        }
        Ok(id)
    }

    fn edit_debounce(&self) -> Duration {
        *self.inner.edits.debounce.lock().expect(LOCK_POISONED)
    }

    /// Hand the copy to the editor the settings pick for its extension.
    fn open_in_editor(&self, local: &Path) -> CoreResult<()> {
        let settings = self.settings();
        let app = extension(local).and_then(|ext| settings.editor_overrides.get(&ext));
        let opener = Arc::clone(&self.inner.edits.opener.lock().expect(LOCK_POISONED));
        opener.open(local, app.map(String::as_str))
    }

    /// The task that handles one edit's signals in order. It holds the core
    /// weakly and ends when the edit is closed (its senders dropped).
    fn spawn_edit_task(
        &self,
        id: EditId,
        mut rx: mpsc::UnboundedReceiver<Signal>,
    ) -> tokio::task::JoinHandle<()> {
        let core = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            while let Some(signal) = rx.recv().await {
                let Some(inner) = core.upgrade() else { return };
                let core = Core { inner };
                match signal {
                    Signal::Changed => core.sync_edit(id).await,
                    Signal::Connected | Signal::Resolve => {
                        if !core.apply_resolution(id).await {
                            core.sync_edit(id).await;
                        }
                    }
                }
            }
        })
    }

    /// Upload a save, unless the server copy changed (a conflict then).
    async fn sync_edit(&self, id: EditId) {
        let edits = &self.inner.edits;
        let Some((info, local, synced)) = edits.lock().edits.get(&id).and_then(|e| {
            let busy = e.info.status == EditStatus::Conflict || e.resolution.is_some();
            (!busy).then(|| (e.info.clone(), e.local.clone(), e.synced))
        }) else {
            return;
        };
        // Gone for a moment while an editor swaps a temp file in; its
        // rename brings another event.
        let Ok(now) = local_stamp(&local).await else {
            return;
        };
        if Some(now) == synced {
            if info.status == EditStatus::WaitingForConnection {
                edits.set_status(id, EditStatus::Synced);
            }
            return;
        }
        let Ok(live) = self.inner.sessions.get(info.session_id) else {
            tracing::info!("edit upload waits for the connection");
            edits.set_status(id, EditStatus::WaitingForConnection);
            return;
        };
        edits.set_status(id, EditStatus::Uploading);
        let fs = live.ssh.fs();
        let result = async {
            let remote = fs.metadata(&info.path).await?.map(RemoteStamp::from);
            if remote != Some(info.baseline) {
                return Ok(Synced::Conflict(remote));
            }
            upload(&local, fs, &info.path).await?;
            Ok(Synced::Uploaded(remote_stamp(fs, &info.path).await?))
        }
        .await;
        match self.forget_if_lost(info.session_id, live.generation, result) {
            Ok(Synced::Uploaded(baseline)) => self.uploaded(id, &info.path, baseline, now),
            Ok(Synced::Conflict(remote)) => {
                edits.set_status(id, EditStatus::Conflict);
                tracing::info!("edit conflict: the server copy changed");
                self.inner.events.publish(CoreEvent::EditConflict {
                    edit_id: id,
                    session_id: info.session_id,
                    path: info.path,
                    remote,
                    baseline: info.baseline,
                });
            }
            Err(e) => self.edit_failed(id, e),
        }
    }

    /// Apply a recorded answer to a conflict. `false` when there is none.
    async fn apply_resolution(&self, id: EditId) -> bool {
        let edits = &self.inner.edits;
        let Some((info, local, resolution)) = edits
            .lock()
            .edits
            .get(&id)
            .and_then(|e| e.resolution.map(|r| (e.info.clone(), e.local.clone(), r)))
        else {
            return false;
        };
        let Ok(live) = self.inner.sessions.get(info.session_id) else {
            edits.set_status(id, EditStatus::WaitingForConnection);
            return true;
        };
        edits.set_status(id, EditStatus::Uploading);
        let fs = live.ssh.fs();
        let before = local_stamp(&local).await.ok();
        let result: CoreResult<(RemoteStamp, String)> = async {
            let path = match resolution {
                EditResolution::Overwrite => {
                    upload(&local, fs, &info.path).await?;
                    info.path.clone()
                }
                EditResolution::Discard => {
                    download(fs, &info.path, &local).await?;
                    info.path.clone()
                }
                EditResolution::SaveCopy => {
                    let copy = free_copy_path(fs, &info.path).await?;
                    upload(&local, fs, &copy).await?;
                    copy
                }
            };
            Ok((remote_stamp(fs, &path).await?, path))
        }
        .await;
        let result = self.forget_if_lost(info.session_id, live.generation, result);
        // Answered either way: a failure leaves the edit `failed`, and the
        // next save stats the server again (and may ask again).
        if let Err(CoreError::NotConnected) = &result {
            edits.set_status(id, EditStatus::WaitingForConnection);
            return true;
        }
        if let Some(entry) = edits.lock().edits.get_mut(&id) {
            entry.resolution = None;
        }
        match result {
            Ok((baseline, path)) if resolution == EditResolution::Discard => {
                let now = local_stamp(&local).await.ok();
                if let Some(entry) = edits.lock().edits.get_mut(&id) {
                    entry.info.baseline = baseline;
                    entry.info.status = EditStatus::Synced;
                    entry.synced = now;
                }
                tracing::info!("edit discarded: reloaded the server copy");
                debug_assert_eq!(path, info.path);
            }
            Ok((baseline, path)) => match before {
                Some(before) => self.uploaded(id, &path, baseline, before),
                None => self.edit_failed(id, CoreError::NotFound(info.local_path)),
            },
            Err(e) => self.edit_failed(id, e),
        }
        true
    }

    /// A save reached the server as `path`: it is the new baseline (and
    /// the edit's target, after `saveCopy`).
    fn uploaded(&self, id: EditId, path: &str, baseline: RemoteStamp, local: LocalStamp) {
        let session_id = {
            let mut reg = self.inner.edits.lock();
            let Some(entry) = reg.edits.get_mut(&id) else {
                return;
            };
            entry.info.baseline = baseline;
            entry.info.status = EditStatus::Synced;
            entry.synced = Some(local);
            if entry.info.path != path {
                entry.info.path = path.to_string();
                entry.info.name = posix_name(path);
            }
            entry.info.session_id
        };
        tracing::info!("uploaded an edited file");
        self.inner.events.publish(CoreEvent::EditUploaded {
            edit_id: id,
            session_id,
            path: path.to_string(),
        });
    }

    fn edit_failed(&self, id: EditId, err: CoreError) {
        if matches!(err, CoreError::NotConnected) {
            self.inner
                .edits
                .set_status(id, EditStatus::WaitingForConnection);
            return;
        }
        let Some(info) = self.inner.edits.lock().edits.get_mut(&id).map(|e| {
            e.info.status = EditStatus::Failed;
            e.info.clone()
        }) else {
            return;
        };
        tracing::info!(kind = err.kind(), "edit upload failed");
        self.inner.events.publish(CoreEvent::EditFailed {
            edit_id: id,
            session_id: info.session_id,
            path: info.path,
            kind: err.kind().to_string(),
            message: err.to_string(),
        });
    }

    /// Answer a [`CoreEvent::EditConflict`]. `NotFound` for an unknown
    /// edit, `InvalidInput` when it is not waiting for an answer. Applied in
    /// the background (or once the session is connected again).
    pub fn resolve_edit(&self, id: EditId, resolution: EditResolution) -> CoreResult<()> {
        let mut reg = self.inner.edits.lock();
        let entry = reg
            .edits
            .get_mut(&id)
            .ok_or_else(|| CoreError::NotFound("edit".into()))?;
        if entry.info.status != EditStatus::Conflict || entry.resolution.is_some() {
            return Err(CoreError::InvalidInput(
                "the edit is not waiting for a decision".into(),
            ));
        }
        entry.resolution = Some(resolution);
        let _ = entry.tx.send(Signal::Resolve);
        Ok(())
    }

    /// Every file open for editing.
    pub fn list_edits(&self) -> Vec<EditInfo> {
        let mut list: Vec<EditInfo> = self
            .inner
            .edits
            .lock()
            .edits
            .values()
            .map(|e| e.info.clone())
            .collect();
        list.sort_by(|a, b| {
            (a.session_id.to_string(), &a.path).cmp(&(b.session_id.to_string(), &b.path))
        });
        list
    }

    /// Stop editing: stop watching, let an upload in flight finish, delete
    /// the local copy. Unsaved changes in the editor stay there. `NotFound`
    /// for an unknown edit.
    pub async fn close_edit(&self, id: EditId) -> CoreResult<()> {
        let mut taken = self.inner.edits.take(|info| info.id == id);
        let Some((task, dir)) = taken.pop() else {
            return Err(CoreError::NotFound("edit".into()));
        };
        if let Some(mut task) = task {
            // Its senders are gone: it ends after what it is doing.
            if tokio::time::timeout(CLOSE_GRACE, &mut task).await.is_err() {
                task.abort();
            }
        }
        remove_dir(&dir);
        if let Some(parent) = dir.parent() {
            // The session folder, once its last edit is gone.
            let _ = std::fs::remove_dir(parent);
        }
        Ok(())
    }

    /// Stop the session's edits and delete their copies (a user
    /// disconnect; the connection is gone, so nothing is waited for).
    pub(crate) fn close_session_edits(&self, session_id: SessionId) {
        for (task, _) in self.inner.edits.take(|info| info.session_id == session_id) {
            if let Some(task) = task {
                task.abort();
            }
        }
        if let Some(root) = self.inner.edits.edit_root() {
            remove_dir(&root.join(session_id.to_string()));
        }
    }

    /// Stop every edit and delete all local copies (quitting).
    pub fn close_all_edits(&self) {
        for (task, _) in self.inner.edits.take(|_| true) {
            if let Some(task) = task {
                task.abort();
            }
        }
        if let Some(root) = self.inner.edits.edit_root() {
            remove_dir(&root);
        }
    }
}

/// Watch `dir`; every debounced batch of events becomes one
/// [`Signal::Changed`].
fn watch(
    dir: &Path,
    debounce: Duration,
    tx: mpsc::UnboundedSender<Signal>,
) -> CoreResult<Debouncer<RecommendedWatcher>> {
    let mut debouncer = new_debouncer(debounce, move |result: DebounceEventResult| match result {
        Ok(_) => {
            let _ = tx.send(Signal::Changed);
        }
        Err(e) => tracing::warn!("watching a local copy failed: {e}"),
    })
    .map_err(|_| watch_failed())?;
    debouncer
        .watcher()
        .watch(dir, RecursiveMode::NonRecursive)
        .map_err(|_| watch_failed())?;
    Ok(debouncer)
}

fn watch_failed() -> CoreError {
    CoreError::Io(std::io::Error::other(
        "could not watch the local copy for changes",
    ))
}

/// The lower-cased extension of a file name (a dotfile's leading dot is
/// not one).
fn extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    match name.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < name.len() => Some(name[dot + 1..].to_lowercase()),
        _ => None,
    }
}

/// A short, stable folder name for a remote path (FNV-1a, 64 bit): two
/// files of the same name in different folders get different copies.
fn path_hash(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

async fn local_stamp(path: &Path) -> std::io::Result<LocalStamp> {
    let meta = tokio::fs::metadata(path).await?;
    Ok(LocalStamp {
        size: meta.len(),
        modified: meta.modified().ok(),
    })
}

async fn remote_stamp(fs: &SftpFs, path: &str) -> CoreResult<RemoteStamp> {
    fs.metadata(path)
        .await?
        .map(RemoteStamp::from)
        .ok_or_else(|| CoreError::NotFound(path.to_string()))
}

/// The first `name (edited).ext`, `name (edited 2).ext`, … free next to
/// `path`.
async fn free_copy_path(fs: &SftpFs, path: &str) -> CoreResult<String> {
    let name = posix_name(path);
    let parent = match path.trim_end_matches('/').rsplit_once('/') {
        Some(("", _)) => "/",
        Some((parent, _)) => parent,
        None => "",
    };
    for n in 1..10_000 {
        let candidate = join_posix(parent, &edited_copy_name(&name, n));
        if fs.metadata(&candidate).await?.is_none() {
            return Ok(candidate);
        }
    }
    Err(CoreError::AlreadyExists(path.to_string()))
}

/// Copy the remote file over the local one (in place, so an editor that
/// watches it reloads).
async fn download(fs: &SftpFs, remote: &str, local: &Path) -> CoreResult<()> {
    let local_name = local.to_string_lossy();
    let mut reader = fs.open_reader(remote, 0).await?;
    let mut file = tokio::fs::File::create(local)
        .await
        .map_err(|e| CoreError::from_io_at(e, &local_name))?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| sftp_io_error(e, remote, "read"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .await
            .map_err(|e| CoreError::from_io_at(e, &local_name))?;
    }
    file.flush()
        .await
        .map_err(|e| CoreError::from_io_at(e, &local_name))
}

/// Copy the local file over the remote one.
async fn upload(local: &Path, fs: &SftpFs, remote: &str) -> CoreResult<()> {
    let local_name = local.to_string_lossy();
    let mut file = tokio::fs::File::open(local)
        .await
        .map_err(|e| CoreError::from_io_at(e, &local_name))?;
    let mut writer = fs.open_writer(remote, 0).await?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| CoreError::from_io_at(e, &local_name))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| sftp_io_error(e, remote, "write"))?;
    }
    writer
        .shutdown()
        .await
        .map_err(|e| sftp_io_error(e, remote, "write"))
}

/// Delete a folder of local copies; already gone is fine.
fn remove_dir(dir: &Path) {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("could not remove local edit copies: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_lower_case_without_the_dot() {
        assert_eq!(extension(Path::new("/c/a/Notes.MD")), Some("md".into()));
        assert_eq!(extension(Path::new("/c/a/x.tar.gz")), Some("gz".into()));
        assert_eq!(extension(Path::new("/c/a/.env")), None);
        assert_eq!(extension(Path::new("/c/a/Makefile")), None);
        assert_eq!(extension(Path::new("/c/a/trailing.")), None);
    }

    #[test]
    fn path_hashes_are_stable_and_tell_folders_apart() {
        assert_eq!(path_hash("/srv/a.txt"), path_hash("/srv/a.txt"));
        assert_ne!(path_hash("/srv/a.txt"), path_hash("/var/a.txt"));
        assert_eq!(path_hash("/srv/a.txt").len(), 16);
    }

    #[test]
    fn wire_shapes_are_camel_case() {
        assert_eq!(
            serde_json::to_value(EditResolution::SaveCopy).unwrap(),
            "saveCopy"
        );
        assert_eq!(
            serde_json::from_value::<EditResolution>("discard".into()).unwrap(),
            EditResolution::Discard
        );
        assert_eq!(
            serde_json::to_value(EditStatus::WaitingForConnection).unwrap(),
            "waitingForConnection"
        );
        let info = EditInfo {
            id: EditId::new(),
            session_id: SessionId::new(),
            path: "/srv/notes.txt".into(),
            name: "notes.txt".into(),
            local_path: "/cache/edit/x/notes.txt".into(),
            status: EditStatus::Synced,
            baseline: RemoteStamp {
                size: 3,
                mtime: Some(1_700_000_000),
            },
        };
        let json = serde_json::to_value(info).unwrap();
        assert_eq!(json["localPath"], "/cache/edit/x/notes.txt");
        assert!(json["sessionId"].is_string());
        assert_eq!(json["baseline"]["mtime"], 1_700_000_000);
    }

    #[test]
    fn without_an_opener_opening_is_a_config_error() {
        let err = NoOpener.open(Path::new("/x"), None).unwrap_err();
        assert_eq!(err.kind(), "config");
    }
}
