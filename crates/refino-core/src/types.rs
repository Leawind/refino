//! Reference document: docs/dlg.md (Decision Lineage Graph).
//!
//! A graph holds two kinds of nodes:
//! - premise nodes: objective project facts, never have `grounds`;
//! - decision nodes: project decisions, optionally grounded on premises
//!   and/or upstream decisions.
//!
//! A `grounds` field on a premise is an ordinary misplaced attribute, exactly
//! like any unknown frontmatter field: producers silently ignore it. Edges
//! only ever come from decision `grounds`.
//!
//! These types are the engine's resident memory model (docs/design.md,
//! "渐进披露与常驻集"): id, type, summary and the graph relations always
//! stay in memory. Body and rationale are paged content supplied by the
//! storage layer by id — they are not part of engine types, and no topology
//! operation needs them.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    Premise,
    Decision,
}

/// An objective project fact: never grounds on other nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PremiseNode {
    pub id: String,
    /// Independent summary attribute for quick relevance checks; the storage
    /// layer may derive it from the body's first paragraph when none is
    /// declared.
    pub summary: String,
    /// Confirmation time as epoch milliseconds; the storage layer converts to
    /// and from the file's RFC 3339 form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<i64>,
}

/// A project decision that limits downstream choice space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecisionNode {
    pub id: String,
    /// Independent summary attribute for quick relevance checks; the storage
    /// layer may derive it from the body's first paragraph when none is
    /// declared.
    pub summary: String,
    /// Ground ids, deduplicated, in declared order; empty when the decision
    /// has no grounds (a root decision).
    pub grounds: Vec<String>,
    /// Trial-commitment mark: `None` means the decision is settled. This is
    /// the stored mark only — the effective status (a decision is exploring
    /// when marked so itself or any ground decision is) is derived at read
    /// time by `effective_exploring`, never stored per node.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exploring: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RefinoNode {
    Premise(PremiseNode),
    Decision(DecisionNode),
}

impl RefinoNode {
    pub fn id(&self) -> &str {
        match self {
            RefinoNode::Premise(n) => &n.id,
            RefinoNode::Decision(n) => &n.id,
        }
    }

    pub fn node_type(&self) -> NodeType {
        match self {
            RefinoNode::Premise(_) => NodeType::Premise,
            RefinoNode::Decision(_) => NodeType::Decision,
        }
    }

    pub fn summary(&self) -> &str {
        match self {
            RefinoNode::Premise(n) => &n.summary,
            RefinoNode::Decision(n) => &n.summary,
        }
    }

    pub fn as_premise(&self) -> Option<&PremiseNode> {
        match self {
            RefinoNode::Premise(n) => Some(n),
            RefinoNode::Decision(_) => None,
        }
    }

    pub fn as_decision(&self) -> Option<&DecisionNode> {
        match self {
            RefinoNode::Premise(_) => None,
            RefinoNode::Decision(n) => Some(n),
        }
    }

    pub fn as_decision_mut(&mut self) -> Option<&mut DecisionNode> {
        match self {
            RefinoNode::Premise(_) => None,
            RefinoNode::Decision(n) => Some(n),
        }
    }
}

/// Light node shape carried by batch query results (docs/design.md, "画布按
/// 需查询"): id, type, summary and grounds — the resident fields without
/// premise `confirmed`. Premises and not-yet-loaded decisions omit
/// `grounds`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeLite {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub summary: String,
    /// Decision nodes only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grounds: Option<Vec<String>>,
    /// Decision nodes only: the stored trial-commitment mark (absent =
    /// settled), not the derived effective status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exploring: Option<bool>,
}

/// Graph-attached node: the resident record plus the derived child
/// back-references (ids of decisions whose `grounds` directly contain this
/// id; sorted, deduplicated; maintained by `build_graph` and the mutation
/// primitives). Premises have children but no grounds; root decisions have
/// neither.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphNode {
    pub node: RefinoNode,
    pub children: Vec<String>,
}

impl GraphNode {
    pub fn id(&self) -> &str {
        self.node.id()
    }

    pub fn node_type(&self) -> NodeType {
        self.node.node_type()
    }

    pub fn summary(&self) -> &str {
        self.node.summary()
    }

    pub fn as_decision(&self) -> Option<&DecisionNode> {
        self.node.as_decision()
    }

    pub fn as_premise(&self) -> Option<&PremiseNode> {
        self.node.as_premise()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Graph {
    /// All nodes indexed by id. Node identity is the `id`.
    pub nodes: BTreeMap<String, GraphNode>,
}

/// Result of one id in a batch query: the queried results, or a per-id error
/// when the id does not resolve. The shared return contract of all batch
/// query interfaces (CLI, harness tools, Web on-demand queries) — batch
/// queries use partial-success semantics, so a missing id never aborts the
/// remaining ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QueryGroup<T> {
    Results { id: String, results: Vec<T> },
    Error { id: String, error: String },
}

/// Codes of issues and thrown errors emitted by the engine itself, all of
/// them graph-level semantics. The string values are the wire format (CLI
/// output, web API responses), so they keep their SCREAMING_SNAKE spelling.
/// Other emitters define their own codes (`RefinoIssue.code` and
/// `RefinoError.code` accept any string): storage-format codes belong to
/// `refino-storage`, request-shape codes to the web layer, and so on.
pub struct IssueCode;

impl IssueCode {
    /// A node id (from any source) fails the engine's id rule.
    pub const INVALID_ID: &'static str = "INVALID_ID";
    /// A `grounds` list or entry is malformed, or lists the same id more than once.
    pub const INVALID_GROUNDS: &'static str = "INVALID_GROUNDS";
    /// Two nodes carry the same id; ids are globally unique across the graph.
    pub const DUPLICATE_ID: &'static str = "DUPLICATE_ID";
    /// A `grounds` reference does not resolve to an existing node; carries `ground_id`.
    pub const UNKNOWN_GROUND: &'static str = "UNKNOWN_GROUND";
    /// A decision -> decision `grounds` path closes; carries `cycle`.
    pub const CYCLE: &'static str = "CYCLE";
    /// An id does not resolve to a node (raised as a `RefinoError`).
    pub const NODE_NOT_FOUND: &'static str = "NODE_NOT_FOUND";
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinoIssue {
    /// Wire code; the engine emits `IssueCode` values, other emitters their own.
    pub code: String,
    pub message: String,
    /// Node id the issue relates to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// Only for `IssueCode::UNKNOWN_GROUND`: the referenced id that does not exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ground_id: Option<String>,
    /// Only for `IssueCode::CYCLE`: the closed path, e.g. ["01ABCDEF","02ABCDEF","01ABCDEF"].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle: Option<Vec<String>>,
}

impl RefinoIssue {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        RefinoIssue {
            code: code.to_string(),
            message: message.into(),
            node_id: None,
            ground_id: None,
            cycle: None,
        }
    }

    pub fn with_node_id(mut self, node_id: impl Into<String>) -> Self {
        self.node_id = Some(node_id.into());
        self
    }

    pub fn with_ground_id(mut self, ground_id: impl Into<String>) -> Self {
        self.ground_id = Some(ground_id.into());
        self
    }

    pub fn with_cycle(mut self, cycle: Vec<String>) -> Self {
        self.cycle = Some(cycle);
        self
    }
}

/// Error raised by engine primitives when an operation cannot proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefinoError {
    /// Wire code; the engine raises with `IssueCode` values, other emitters their own.
    pub code: String,
    pub message: String,
}

impl RefinoError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        RefinoError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RefinoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RefinoError {}

/// Injected random source (docs/design.md, "引擎纯净性"): the engine itself
/// has no entropy dependency. Native hosts provide an OS-backed
/// implementation, wasm hosts inject one from the JS side (Web Crypto in
/// browsers).
pub trait RandomSource {
    fn fill_bytes(&self, buf: &mut [u8]);
}
