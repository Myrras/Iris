//! One end of a transfer — the local disk or an SFTP channel — behind one
//! set of calls, so the engine copies uploads and downloads alike.

use std::path::Path;

use crate::error::CoreResult;
use crate::fs::{
    join_posix, posix_name, Entry, FileMeta, FileSystem, LocalFs, Reader, SftpFs, Writer,
};

#[derive(Clone)]
pub(crate) enum Side {
    Local(LocalFs),
    Remote(SftpFs),
}

impl Side {
    /// The file at `path`, links followed; `None` when nothing is there.
    pub async fn metadata(&self, path: &str) -> CoreResult<Option<FileMeta>> {
        match self {
            Self::Local(fs) => fs.metadata(path).await,
            Self::Remote(fs) => fs.metadata(path).await,
        }
    }

    /// One entry, a final symlink reported (not followed).
    pub async fn entry(&self, path: &str) -> CoreResult<Entry> {
        match self {
            Self::Local(fs) => fs.stat(path).await,
            Self::Remote(fs) => fs.stat(path).await,
        }
    }

    pub async fn list(&self, path: &str) -> CoreResult<Vec<Entry>> {
        match self {
            Self::Local(fs) => fs.list(path).await,
            Self::Remote(fs) => fs.list(path).await,
        }
    }

    pub async fn open_reader(&self, path: &str, offset: u64) -> CoreResult<Reader> {
        match self {
            Self::Local(fs) => fs.open_reader(path, offset).await,
            Self::Remote(fs) => fs.open_reader(path, offset).await,
        }
    }

    pub async fn open_writer(&self, path: &str, offset: u64) -> CoreResult<Writer> {
        match self {
            Self::Local(fs) => fs.open_writer(path, offset).await,
            Self::Remote(fs) => fs.open_writer(path, offset).await,
        }
    }

    pub async fn set_times(
        &self,
        path: &str,
        mtime: Option<i64>,
        mode: Option<u32>,
    ) -> CoreResult<()> {
        match self {
            Self::Local(fs) => fs.set_times(path, mtime, mode).await,
            Self::Remote(fs) => fs.set_times(path, mtime, mode).await,
        }
    }

    pub async fn mkdir_all(&self, path: &str) -> CoreResult<()> {
        match self {
            Self::Local(fs) => fs.mkdir_all(path).await,
            Self::Remote(fs) => fs.mkdir_all(path).await,
        }
    }

    /// Create the folder `path` whose parent exists; a folder already
    /// there is fine. One round trip for a new folder (where
    /// [`Side::mkdir_all`] looks at every parent first).
    pub async fn mkdir_one(&self, path: &str) -> CoreResult<()> {
        match self {
            Self::Local(fs) => fs.mkdir_one(path).await,
            Self::Remote(fs) => fs.mkdir_one(path).await,
        }
    }

    /// Whether anything (a broken link included) is at `path`.
    pub async fn exists(&self, path: &str) -> CoreResult<bool> {
        match self.entry(path).await {
            Ok(_) => Ok(true),
            Err(crate::CoreError::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// How many folder listings a walk of this side runs at once.
    pub fn walk_limit(&self) -> usize {
        match self {
            Self::Local(_) => crate::fs::LOCAL_LISTINGS,
            Self::Remote(_) => crate::fs::REMOTE_LISTINGS,
        }
    }

    /// `name` inside the folder `parent`.
    pub fn join(&self, parent: &str, name: &str) -> String {
        match self {
            Self::Local(_) => Path::new(parent).join(name).to_string_lossy().into_owned(),
            Self::Remote(_) => join_posix(parent, name),
        }
    }

    /// The last segment of `path` (empty when there is none).
    pub fn name_of(&self, path: &str) -> String {
        match self {
            Self::Local(_) => Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            Self::Remote(_) => match posix_name(path) {
                root if root == "/" => String::new(),
                name => name,
            },
        }
    }
}
