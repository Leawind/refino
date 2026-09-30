//! Shared command plumbing: the global options, the store openers and the
//! failure reporting. The openers do not hold the output sink — commands
//! write through their own captured `io`, and failures come back as typed
//! values that the caller renders.

use refino_fs::{FsIo, OsRandom};
use refino_storage::{RefinoStore, StorageIssueCode, StoreError, StoreIssue};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct GlobalOptions {
    pub root: PathBuf,
}

pub fn global_options(root: &Option<String>) -> GlobalOptions {
    let root = match root {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };
    GlobalOptions { root }
}

pub fn refino_dir(opts: &GlobalOptions) -> PathBuf {
    opts.root.join(".refino")
}

/// Why a read command did not produce a result.
pub enum QueryFailure {
    /// Graph issues make query results ambiguous: render + exit 1.
    Blocking(Vec<StoreIssue>),
    /// The repository was never adopted; the message names the directory.
    Unadopted(String),
    /// Anything else: `error: <message>` + exit 1.
    Other(String),
}

/// Open the store and run a query against it. Graph issues make query results
/// ambiguous, so the query closure only runs while no issues exist.
pub fn with_store<R>(
    opts: &GlobalOptions,
    query: impl FnOnce(&mut RefinoStore<FsIo>) -> Result<R, refino_core::RefinoError>,
) -> Result<R, QueryFailure> {
    let mut store = RefinoStore::new(&FsIo, &OsRandom, refino_dir(opts));
    match store.ready() {
        Err(error) => Err(classify_refino_error(error)),
        Ok(()) => {
            let issues = store.issues();
            if !issues.is_empty() {
                return Err(QueryFailure::Blocking(issues));
            }
            query(&mut store).map_err(|e| QueryFailure::Other(e.message))
        }
    }
}

/// Why a write command did not complete.
pub enum WriteFailure {
    Unadopted(String),
    /// Pre-write grounds validation rejected the change; render the issues.
    Rejected(Vec<StoreIssue>),
    Other(String),
}

/// Open the store for a write command. An unadopted repository is refused:
/// writing must never silently adopt it. Pre-existing issues elsewhere must
/// not block the write; the store's write methods validate the change itself
/// and reject it with the offending issues before anything is written.
pub fn with_store_for_write<R>(
    opts: &GlobalOptions,
    action: impl FnOnce(&mut RefinoStore<FsIo>) -> Result<R, StoreError>,
) -> Result<R, WriteFailure> {
    let mut store = RefinoStore::new(&FsIo, &OsRandom, refino_dir(opts));
    let outcome = match store.ready() {
        Ok(()) => action(&mut store),
        Err(error) => Err(StoreError::Other(error)),
    };
    outcome.map_err(|error| match error {
        StoreError::Rejected(rejected) => WriteFailure::Rejected(rejected.issues),
        StoreError::Other(error) => match classify_refino_error(error) {
            QueryFailure::Unadopted(message) => WriteFailure::Unadopted(message),
            QueryFailure::Other(message) => WriteFailure::Other(message),
            QueryFailure::Blocking(_) => WriteFailure::Other(String::new()),
        },
    })
}

fn classify_refino_error(error: refino_core::RefinoError) -> QueryFailure {
    if error.code == StorageIssueCode::REFINO_DIR_NOT_FOUND {
        QueryFailure::Unadopted(error.message)
    } else {
        QueryFailure::Other(error.message)
    }
}

/// Render a read failure: returns the exit code.
pub fn report_query_failure(io: &mut dyn crate::format::CliSink, failure: QueryFailure) -> i32 {
    match failure {
        QueryFailure::Blocking(issues) => {
            io.out(&format!("{}\n", crate::format::render_issues(&issues)));
            1
        }
        QueryFailure::Unadopted(message) => {
            io.err(&format!(
                "error: {message} — run \"refino init\" to adopt this repository\n"
            ));
            1
        }
        QueryFailure::Other(message) => {
            io.err(&format!("error: {message}\n"));
            1
        }
    }
}

/// Render a write failure: returns the exit code.
pub fn report_write_failure(io: &mut dyn crate::format::CliSink, failure: WriteFailure) -> i32 {
    match failure {
        WriteFailure::Rejected(issues) => {
            io.err(&format!("{}\n", crate::format::render_issues(&issues)));
            1
        }
        WriteFailure::Unadopted(message) => {
            io.err(&format!(
                "error: {message} — run \"refino init\" to adopt this repository\n"
            ));
            1
        }
        WriteFailure::Other(message) => {
            io.err(&format!("error: {message}\n"));
            1
        }
    }
}
