//! Filesystem storage format for Decision Lineage Graphs (DLG): the sole
//! reader and writer of the `.refino/` directory. Pure logic over an
//! injected synchronous [`Io`](io::Io) — hosts provide the filesystem
//! (natively via `refino-fs`, in Node via a node:fs adapter, in tests via an
//! in-memory fake).

pub mod clock;
pub mod codes;
pub mod io;
pub mod loader;
pub mod parser;
pub mod store;
pub mod watcher;
pub mod writer;
pub mod yaml;

pub use codes::{StorageIssue, StorageIssueCode, StoreIssue};
pub use io::{DirEntry, Io, WatchError};
pub use loader::{LoadResult, ReadNodeResult, find_refino_dir, load_graph, read_node};
pub use parser::{
    NodeContent, ParseResult, SUMMARY_MAX_LENGTH, confirmed_to_ms, confirmed_to_rfc3339,
    extract_summary, is_valid_confirmed, parse_node_source,
};
pub use store::{
    Origin, RefinoStore, Stats, StoreChange, StoreEntry, StoreError, WriteOutcome, WriteRejected,
};
pub use watcher::{ArmResult, DEFAULT_DEBOUNCE_MS, TimerKind, WatchSink, WatcherCore};
pub use writer::{
    CreateDecisionOptions, CreateOptions, CreatePremiseOptions, UpdateDecisionOptions,
    UpdateOptions, UpdatePremiseOptions, atomic_write_file, create_decision, create_premise,
    delete_node, node_id_from_relative_file, node_relative_file, update_decision, update_premise,
};
pub use yaml::serialize_node;
