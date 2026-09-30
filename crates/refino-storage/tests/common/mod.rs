//! Shared test infrastructure: an in-memory [`FakeIo`] (the fake counterpart
//! of the TS tests' real tmpdir fs), the `.refino/` fixture builder (the
//! Rust counterpart of `@refino/testkit`), and deterministic random sources.
//!
//! `FakeIo` uses interior mutability throughout: the [`Io`] trait methods
//! take `&self`, and the test drivers mutate the filesystem behind them.
#![allow(dead_code)]

use refino_storage::TimerKind;
use refino_storage::io::{DirEntry, Io, WatchError};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

/// In-memory filesystem with controllable failures.
pub struct FakeIo {
    files: RefCell<BTreeMap<PathBuf, String>>,
    mtimes: RefCell<BTreeMap<PathBuf, f64>>,
    dirs: RefCell<HashSet<PathBuf>>,
    now: Cell<f64>,
    pub pid: u32,
    /// Remaining transient permission failures for `rename`.
    pub fail_rename_permission_times: Cell<u32>,
    pub rename_calls: Cell<u32>,
    pub sleeps: Cell<u64>,
}

impl Default for FakeIo {
    fn default() -> Self {
        FakeIo {
            files: RefCell::new(BTreeMap::new()),
            mtimes: RefCell::new(BTreeMap::new()),
            dirs: RefCell::new(HashSet::new()),
            now: Cell::new(0.0),
            pid: 4242,
            fail_rename_permission_times: Cell::new(0),
            rename_calls: Cell::new(0),
            sleeps: Cell::new(0),
        }
    }
}

impl FakeIo {
    pub fn new() -> Self {
        Self::default()
    }

    /// Normalize a path so that join styles never leak into the key space
    /// (a real filesystem compares paths semantically; the fake must too).
    fn norm(path: &Path) -> PathBuf {
        path.components().collect::<PathBuf>()
    }

    fn advance(&self) {
        self.now.set(self.now.get() + 1.0);
    }

    /// Seed (or overwrite) a file and its parent directories, bumping its mtime.
    pub fn seed_file(&self, path: impl Into<PathBuf>, content: &str) {
        self.advance();
        let path = Self::norm(&path.into());
        self.files
            .borrow_mut()
            .insert(path.clone(), content.to_string());
        self.mtimes
            .borrow_mut()
            .insert(path.clone(), self.now.get());
        for dir in path.ancestors().skip(1) {
            if !self.dirs.borrow_mut().insert(dir.to_path_buf()) {
                break;
            }
        }
    }

    /// Remove a file directly (simulating an external deletion).
    pub fn remove(&self, path: &Path) {
        self.advance();
        let path = &Self::norm(path);
        self.files.borrow_mut().remove(path);
        self.mtimes.borrow_mut().remove(path);
    }

    pub fn set_mtime(&self, path: &Path, mtime: f64) {
        let path = &Self::norm(path);
        self.mtimes.borrow_mut().insert(path.to_path_buf(), mtime);
    }

    // Insert a directory directly (simulating anything on disk).
    pub fn insert_dir(&self, path: &Path) {
        self.dirs.borrow_mut().insert(Self::norm(path));
    }

    pub fn read(&self, path: &Path) -> String {
        self.files
            .borrow()
            .get(&Self::norm(path))
            .cloned()
            .unwrap_or_default()
    }

    pub fn mtime_of(&self, path: &Path) -> f64 {
        self.mtimes
            .borrow()
            .get(&Self::norm(path))
            .copied()
            .unwrap_or(0.0)
    }
}

impl Io for FakeIo {
    fn read_with_mtime(&self, path: &Path) -> std::io::Result<Option<(String, f64)>> {
        let path = &Self::norm(path);
        match self.files.borrow().get(path) {
            Some(content) => Ok(Some((
                content.clone(),
                self.mtimes.borrow().get(path).copied().unwrap_or(0.0),
            ))),
            None => Ok(None),
        }
    }

    fn read_dir(&self, path: &Path) -> std::io::Result<Vec<DirEntry>> {
        let path = &Self::norm(path);
        if !self.dirs.borrow().contains(path) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no such directory",
            ));
        }
        let mut entries: Vec<DirEntry> = Vec::new();
        for file in self.files.borrow().keys() {
            if file.parent() == Some(path) {
                if let Some(name) = file.file_name() {
                    entries.push(DirEntry {
                        name: name.to_string_lossy().to_string(),
                        is_dir: false,
                        is_file: true,
                    });
                }
            }
        }
        for dir in self.dirs.borrow().iter() {
            if dir.parent() == Some(path) {
                if let Some(name) = dir.file_name() {
                    entries.push(DirEntry {
                        name: name.to_string_lossy().to_string(),
                        is_dir: true,
                        is_file: false,
                    });
                }
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        entries.dedup_by(|a, b| a.name == b.name);
        Ok(entries)
    }

    fn is_directory(&self, path: &Path) -> bool {
        self.dirs.borrow().contains(&Self::norm(path))
    }

    fn create_dir_all(&self, path: &Path) -> std::io::Result<()> {
        let path = &Self::norm(path);
        let mut ancestors: Vec<PathBuf> = path.ancestors().map(|p| p.to_path_buf()).collect();
        ancestors.reverse();
        for dir in ancestors {
            if !dir.as_os_str().is_empty() {
                self.dirs.borrow_mut().insert(dir);
            }
        }
        Ok(())
    }

    fn write_file(&self, path: &Path, content: &str) -> std::io::Result<()> {
        self.advance();
        let path = &Self::norm(path);
        self.files
            .borrow_mut()
            .insert(path.to_path_buf(), content.to_string());
        self.mtimes
            .borrow_mut()
            .insert(path.to_path_buf(), self.now.get());
        Ok(())
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        let from = &Self::norm(from);
        let to = &Self::norm(to);
        self.rename_calls.set(self.rename_calls.get() + 1);
        if self.fail_rename_permission_times.get() > 0 {
            self.fail_rename_permission_times
                .set(self.fail_rename_permission_times.get() - 1);
            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        }
        self.advance();
        let content = self
            .files
            .borrow_mut()
            .remove(from)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no such file"))?;
        self.files.borrow_mut().insert(to.to_path_buf(), content);
        self.mtimes
            .borrow_mut()
            .insert(to.to_path_buf(), self.now.get());
        self.mtimes.borrow_mut().remove(from);
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        self.advance();
        self.files.borrow_mut().remove(path);
        self.mtimes.borrow_mut().remove(path);
        Ok(())
    }

    fn path_exists(&self, path: &Path) -> bool {
        self.files.borrow().contains_key(path) || self.dirs.borrow().contains(path)
    }

    fn now_ms(&self) -> i64 {
        self.now.get() as i64
    }

    fn pid(&self) -> u32 {
        self.pid
    }

    fn sleep_ms(&self, ms: u64) {
        self.sleeps.set(self.sleeps.get() + ms);
        self.now.set(self.now.get() + ms as f64);
    }
}

/// Deterministic single-pattern random source.
pub struct FixedRandom(pub u8);

impl refino_core::RandomSource for FixedRandom {
    fn fill_bytes(&self, buf: &mut [u8]) {
        for (i, b) in buf.iter_mut().enumerate() {
            *b = self.0.wrapping_mul(31).wrapping_add(i as u8 * 7 + 1);
        }
    }
}

/// Sequential random source: each call advances a xorshift64 state, giving
/// distinct outputs (id-collision loops in `create_node` terminate).
pub struct SeqRandom(pub Cell<u64>);

impl refino_core::RandomSource for SeqRandom {
    fn fill_bytes(&self, buf: &mut [u8]) {
        let mut x = self.0.get().max(1);
        for b in buf.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = (x >> 24) as u8;
        }
        self.0.set(x);
    }
}

/// Create a `.refino/` fixture under a fixed fake root. `files` are
/// `.refino`-relative paths and contents, mirroring `@refino/testkit`'s
/// `createRefino`.
pub fn create_refino(io: &FakeIo, files: &[(&str, &str)]) -> PathBuf {
    let root = PathBuf::from("/repo");
    let refino = root.join(".refino");
    io.create_dir_all(&refino).unwrap();
    for (relative, content) in files {
        io.seed_file(refino.join(relative), content);
    }
    root
}

/// Convenience: a premise node file at its canonical path for `id`.
pub fn premise_body(id: &str, body: &str) -> (String, String) {
    (
        format!("nodes/{}/{}-premise.md", &id[..2], &id[2..]),
        body.to_string(),
    )
}

/// A decision fixture with grounds and rationale frontmatter.
pub fn decision_body_rationale(id: &str, grounds: &[&str], body: &str, rationale: &str) -> String {
    let grounds_json: Vec<String> = grounds.iter().map(|g| format!("\"{g}\"")).collect();
    format!(
        "---\ngrounds: [{}]\nrationale: {}\n---\n\n{}",
        grounds_json.join(", "),
        rationale,
        body
    )
}

/// Recording watch sink: notes watches and timer settings.
pub struct RecordingSink {
    pub watched: Vec<PathBuf>,
    pub unwatched: Vec<PathBuf>,
    pub timers: Vec<(TimerKind, u64)>,
    pub fail_root_with: Option<WatchError>,
}

impl RecordingSink {
    pub fn new() -> Self {
        RecordingSink {
            watched: Vec::new(),
            unwatched: Vec::new(),
            timers: Vec::new(),
            fail_root_with: None,
        }
    }
}

impl Default for RecordingSink {
    fn default() -> Self {
        Self::new()
    }
}

impl refino_storage::WatchSink for RecordingSink {
    fn watch_dir(&mut self, path: &Path) -> Result<(), WatchError> {
        if path == PathBuf::from("/repo/.refino/nodes") {
            if let Some(error) = self.fail_root_with {
                return Err(error);
            }
        }
        self.watched.push(path.to_path_buf());
        Ok(())
    }

    fn unwatch_dir(&mut self, path: &Path) {
        self.unwatched.push(path.to_path_buf());
    }

    fn set_timer(&mut self, kind: TimerKind, delay_ms: u64) {
        self.timers.push((kind, delay_ms));
    }

    fn cancel_timer(&mut self, kind: TimerKind) {
        let _ = kind;
    }
}
