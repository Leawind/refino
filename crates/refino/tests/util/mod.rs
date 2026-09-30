//! Shared CLI test helpers over the real temporary filesystem.
#![allow(dead_code)]

use refino::format::CaptureSink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

/// Pair helper so fixture arrays can mix static and built bodies.
pub fn file(path: &str, body: &str) -> (String, String) {
    (path.to_string(), body.to_string())
}

/// Create a fixture under a fresh temp root. An empty `files` leaves the root
/// bare (no `.refino/`), mirroring the TS testkit.
pub fn create_refino(files: &[(String, String)]) -> PathBuf {
    let n = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("refino-cli-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for (relative, content) in files {
        let path = root.join(".refino").join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    root
}

pub fn remove_root(root: &Path) {
    let _ = std::fs::remove_dir_all(root);
}

pub fn root_arg(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

/// Run the CLI in-process and capture its output.
pub fn run(argv: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let mut sink = CaptureSink::default();
    let code = refino::run(&args, &mut sink);
    (code, sink.out, sink.err)
}
