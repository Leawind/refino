//! Pure engine for Decision Lineage Graphs (DLG).
//!
//! Graph model, validation, queries, longest-path layering and id handling.
//! wasm-clean: no filesystem, clock or network dependencies; the random
//! source is injected (docs/design.md, "引擎纯净性").

pub mod graph;
pub mod id;
pub mod layer;
pub mod query;
pub mod types;
pub mod validate;

pub use graph::{add_node, build_graph, remove_node, set_grounds, update_node};
pub use id::{ID_CHARSET, generate_id, is_valid_id};
pub use layer::{LayerNode, assign_layers};
pub use query::{
    NodeWithDepth, NodeWithOverlap, TraversalOptions, effective_exploring, get_ancestors,
    get_dependents, get_grounds, get_siblings, query_groups, require_node,
};
pub use types::{
    DecisionNode, Graph, GraphNode, IssueCode, NodeLite, NodeType, PremiseNode, QueryGroup,
    RandomSource, RefinoError, RefinoIssue, RefinoNode,
};
pub use validate::{check_grounds_change, validate_graph};
