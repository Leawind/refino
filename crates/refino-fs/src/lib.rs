//! Native host adapters for the refino storage core: the [`Io`]
//! implementation over `std::fs` and the OS-backed random source. The
//! filesystem watcher adapter lives with the server integration.

use refino_storage::WatchError;
use refino_storage::io::{DirEntry, Io};
use std::path::Path;

/// `std::fs`-backed [`Io`].
#[derive(Debug, Clone, Copy, Default)]
pub struct FsIo;

impl Io for FsIo {
    fn read_with_mtime(&self, path: &Path) -> std::io::Result<Option<(String, f64)>> {
        // One open handle for both the text and the stat: the mtime always
        // describes the content being parsed, even under concurrent atomic
        // writes.
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut text = String::new();
        {
            use std::io::Read;
            let mut file = file;
            file.read_to_string(&mut text)?;
            let metadata = file.metadata()?;
            let mtime = metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64() * 1000.0 + f64::from(d.subsec_nanos()) / 1_000_000.0)
                .unwrap_or(0.0);
            Ok(Some((text, mtime)))
        }
    }

    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<DirEntry>> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                is_file: metadata.is_file(),
            });
        }
        Ok(entries)
    }

    fn is_directory(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)
    }

    fn write_file(&self, path: &Path, content: &str) -> std::io::Result<()> {
        std::fs::write(path, content)
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }

    fn path_exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn pid(&self) -> u32 {
        std::process::id()
    }
}

/// OS-backed random source (the native counterpart of the browser's
/// Web Crypto injection).
#[derive(Debug, Clone, Copy, Default)]
pub struct OsRandom;

impl refino_core::RandomSource for OsRandom {
    fn fill_bytes(&self, buf: &mut [u8]) {
        getrandom::fill(buf).expect("OS randomness unavailable");
    }
}

/// Classify a watch error for the storage watcher's retry policy.
pub fn watch_error_class(error: &std::io::Error) -> WatchError {
    // EMFILE / ENOSPC surface as Other kinds with raw os codes; everything
    // else (missing directory, unsupported) is permanent.
    match error.raw_os_error() {
        Some(24) | Some(28) => WatchError::Transient, // EMFILE, ENOSPC
        _ => WatchError::Permanent,
    }
}
