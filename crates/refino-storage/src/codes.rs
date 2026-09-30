//! Issue codes and issue shapes raised by the storage layer for
//! storage-format violations. Graph-level semantics reuse the engine's
//! `IssueCode` as-is; only the concepts owned by the storage format live
//! here. The string values are the wire format, so they keep their
//! SCREAMING_SNAKE spelling.

use refino_core::RefinoIssue;
use serde::Serialize;

/// Codes of issues and errors emitted by the storage layer itself.
pub struct StorageIssueCode;

impl StorageIssueCode {
    /// Frontmatter is not valid YAML, not a mapping, or a known field has the wrong shape.
    pub const INVALID_FRONTMATTER: &'static str = "INVALID_FRONTMATTER";
    /// `confirmed` is not an RFC 3339 timestamp with an explicit UTC offset
    /// (checked at the file boundary; the engine's memory form is epoch
    /// milliseconds).
    pub const INVALID_CONFIRMED: &'static str = "INVALID_CONFIRMED";
    /// `exploring` is not a boolean (decision files only; the canonical file
    /// form only ever writes `exploring: true`).
    pub const INVALID_EXPLORING: &'static str = "INVALID_EXPLORING";
    /// A file under `nodes/` does not have the `<id_2>-<type>.md` shape the
    /// storage format requires.
    pub const INVALID_NODE_PATH: &'static str = "INVALID_NODE_PATH";
    /// The `.refino` directory is missing or not a directory (raised as a
    /// `RefinoError`).
    pub const REFINO_DIR_NOT_FOUND: &'static str = "REFINO_DIR_NOT_FOUND";
}

/// An issue reported by the storage layer. File paths are persistence
/// vocabulary, so they live here, not on the engine's `RefinoIssue`: every
/// issue raised against a file carries its canonical path, which is the only
/// reliable locator for files that never resolve to a node.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StorageIssue {
    #[serde(flatten)]
    pub base: RefinoIssue,
    /// Canonical path of the node file, relative to the `.refino` directory.
    pub file: String,
}

impl StorageIssue {
    pub fn new(code: &str, message: impl Into<String>, file: impl Into<String>) -> Self {
        StorageIssue {
            base: RefinoIssue::new(code, message),
            file: file.into(),
        }
    }

    pub fn with_node_id(mut self, node_id: impl Into<String>) -> Self {
        self.base = self.base.with_node_id(node_id);
        self
    }

    pub fn with_ground_id(mut self, ground_id: impl Into<String>) -> Self {
        self.base = self.base.with_ground_id(ground_id);
        self
    }

    pub fn code(&self) -> &str {
        &self.base.code
    }

    pub fn message(&self) -> &str {
        &self.base.message
    }

    pub fn node_id(&self) -> Option<&str> {
        self.base.node_id.as_deref()
    }
}

/// Issues resident in the store: engine-raised graph issues and
/// storage-raised parse issues, unified under one wire shape (untagged: a
/// storage issue carries `file`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum StoreIssue {
    Graph(RefinoIssue),
    Storage(StorageIssue),
}

impl StoreIssue {
    pub fn code(&self) -> &str {
        match self {
            StoreIssue::Graph(i) => &i.code,
            StoreIssue::Storage(i) => &i.base.code,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            StoreIssue::Graph(i) => &i.message,
            StoreIssue::Storage(i) => &i.base.message,
        }
    }

    pub fn node_id(&self) -> Option<&str> {
        match self {
            StoreIssue::Graph(i) => i.node_id.as_deref(),
            StoreIssue::Storage(i) => i.base.node_id.as_deref(),
        }
    }

    pub fn file(&self) -> Option<&str> {
        match self {
            StoreIssue::Graph(_) => None,
            StoreIssue::Storage(i) => Some(&i.file),
        }
    }
}

impl From<StorageIssue> for StoreIssue {
    fn from(issue: StorageIssue) -> Self {
        StoreIssue::Storage(issue)
    }
}

impl From<RefinoIssue> for StoreIssue {
    fn from(issue: RefinoIssue) -> Self {
        StoreIssue::Graph(issue)
    }
}
