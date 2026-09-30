//! The injected synchronous I/O surface (docs/design.md, "技术形态与边界":
//! Io 注入). The storage core contains no filesystem implementation — hosts
//! provide one: `refino-fs` natively (std::fs), Node via a node:fs adapter,
//! tests via an in-memory fake. Everything is synchronous on purpose: the
//! wasm boundary has no async runtime, and Node hosts call through with
//! synchronous fs calls exactly as often as the TypeScript implementation
//! did.

use std::path::{Path, PathBuf};

/// One entry of a directory listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_file: bool,
}

/// Failure class of arming a directory watch. The host adapter knows which
/// errno it saw; the watcher state machine only needs the distinction
/// between "worth retrying" (transient resource exhaustion) and permanent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchError {
    /// EMFILE / ENOSPC-class exhaustion: sibling processes release their
    /// budget as they exit, so re-arming later can succeed.
    Transient,
    /// Missing directory, unsupported platform, anything else permanent.
    Permanent,
}

/// The storage core's view of the outside world. Path arguments are host
/// paths; implementations map them onto the platform.
pub trait Io {
    /// Read a file's text and mtime (ms) as one consistent snapshot: both
    /// must come from the same open handle so the mtime always describes the
    /// content being parsed. `Ok(None)` when the file does not exist; other
    /// errors propagate.
    fn read_with_mtime(&self, path: &Path) -> std::io::Result<Option<(String, f64)>>;

    /// Directory listing. A missing directory surfaces as an ENOENT-kind
    /// error (`is_enoent`).
    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<DirEntry>>;

    fn is_directory(&self, path: &Path) -> bool;

    fn create_dir_all(&self, path: &Path) -> std::io::Result<()>;

    fn write_file(&self, path: &Path, content: &str) -> std::io::Result<()>;

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;

    fn remove_file(&self, path: &Path) -> std::io::Result<()>;

    /// Whether the path exists (any node type).
    fn path_exists(&self, path: &Path) -> bool;

    /// Wall clock in epoch milliseconds (injected so tests are deterministic).
    fn now_ms(&self) -> i64;

    /// Process id, part of the atomic-write temp file naming.
    fn pid(&self) -> u32;

    /// Backoff sleep for the Windows rename retry loop.
    fn sleep_ms(&self, _ms: u64) {}
}

/// Whether an io error is the ENOENT-class "path does not exist".
pub fn is_enoent(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

/// Join a directory and a relative segment on the host's platform.
pub fn join(dir: &Path, segment: &str) -> PathBuf {
    dir.join(segment)
}
