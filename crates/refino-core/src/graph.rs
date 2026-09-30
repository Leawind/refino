//! Graph assembly and in-memory mutation. Pure and filesystem-free so the
//! engine can build graphs from any source.

use crate::types::{DecisionNode, Graph, GraphNode, IssueCode, RefinoError, RefinoNode};
use std::collections::BTreeMap;

/// Assemble a graph from resident node records: index them by id and derive
/// the children back-references (sorted, deduplicated; unknown grounds stay
/// out of the index — `validate_graph` reports them). Rejecting duplicate
/// ids is the caller's responsibility (last one wins).
pub fn build_graph(nodes: impl IntoIterator<Item = RefinoNode>) -> Graph {
    let mut by_id: BTreeMap<String, GraphNode> = BTreeMap::new();
    for node in nodes {
        by_id.insert(
            node.id().to_string(),
            GraphNode {
                node,
                children: Vec::new(),
            },
        );
    }
    let grounds_of: Vec<(String, Vec<String>)> = by_id
        .values()
        .filter_map(|n| n.as_decision().map(|d| (d.id.clone(), d.grounds.clone())))
        .collect();
    for (id, grounds) in &grounds_of {
        for ground in grounds {
            add_child(by_id.get_mut(ground), id);
        }
    }
    Graph { nodes: by_id }
}

/// Attach a node to the graph, maintaining the children back-references.
/// Errors on a duplicate id.
pub fn add_node(graph: &mut Graph, node: RefinoNode) -> Result<(), RefinoError> {
    if graph.nodes.contains_key(node.id()) {
        return Err(RefinoError::new(
            IssueCode::DUPLICATE_ID,
            format!("Node id \"{}\" is already in use.", node.id()),
        ));
    }
    let id = node.id().to_string();
    graph.nodes.insert(
        id.clone(),
        GraphNode {
            node,
            children: Vec::new(),
        },
    );
    let grounds: Vec<String> = graph
        .nodes
        .get(&id)
        .and_then(|n| n.as_decision())
        .map(|d| d.grounds.clone())
        .unwrap_or_default();
    for ground in &grounds {
        add_child(graph.nodes.get_mut(ground), &id);
    }
    Ok(())
}

/// Detach a node from the graph and return it. Errors when the id does not
/// resolve.
pub fn remove_node(graph: &mut Graph, id: &str) -> Result<GraphNode, RefinoError> {
    let node = graph.nodes.get(id).cloned().ok_or_else(|| {
        RefinoError::new(
            IssueCode::NODE_NOT_FOUND,
            format!("Node \"{id}\" does not exist."),
        )
    })?;
    graph.nodes.remove(id);
    if let Some(decision) = node.as_decision() {
        for ground in &decision.grounds {
            drop_child(graph.nodes.get_mut(ground), id);
        }
    }
    Ok(node)
}

/// Replace a decision's grounds, maintaining the children back-references.
/// Validity (existing references, acyclicity) is the caller's job — run
/// `check_grounds_change` before persisting; the primitive only keeps the
/// two-directional representation consistent. `id` locates an attached
/// decision node; anything else (missing id or a premise) is a
/// NODE_NOT_FOUND error.
pub fn set_grounds(graph: &mut Graph, id: &str, grounds: Vec<String>) -> Result<(), RefinoError> {
    let attached = graph.nodes.get(id).ok_or_else(|| {
        RefinoError::new(
            IssueCode::NODE_NOT_FOUND,
            format!("Node \"{id}\" does not exist."),
        )
    })?;
    if attached.as_decision().is_none() {
        return Err(RefinoError::new(
            IssueCode::NODE_NOT_FOUND,
            format!("Node \"{id}\" does not exist."),
        ));
    }
    replace_grounds(graph, id, grounds);
    Ok(())
}

/// Replace a node's resident fields with a fresh record (e.g. one re-read
/// from storage): summary, premise `confirmed`, decision `exploring` and
/// grounds in one step. The id and type of the attached node are fixed;
/// grounds back-references are maintained. A type mismatch is a no-op
/// (storage fixes the type by path; unreachable there).
pub fn update_node(graph: &mut Graph, node: RefinoNode) -> Result<(), RefinoError> {
    let id = node.id().to_string();
    let fresh_type = node.node_type();
    {
        let attached = graph.nodes.get_mut(&id).ok_or_else(|| {
            RefinoError::new(
                IssueCode::NODE_NOT_FOUND,
                format!("Node \"{id}\" does not exist."),
            )
        })?;
        if attached.node_type() != fresh_type {
            return Ok(());
        }
        match (&mut attached.node, &node) {
            (
                crate::types::RefinoNode::Premise(target),
                crate::types::RefinoNode::Premise(fresh),
            ) => {
                target.summary = fresh.summary.clone();
                target.confirmed = fresh.confirmed;
            }
            (
                crate::types::RefinoNode::Decision(target),
                crate::types::RefinoNode::Decision(fresh),
            ) => {
                target.summary = fresh.summary.clone();
                target.exploring = fresh.exploring;
            }
            _ => unreachable!("types checked equal above"),
        }
    }
    if let crate::types::RefinoNode::Decision(fresh) = node {
        replace_grounds(graph, &id, fresh.grounds);
    }
    Ok(())
}

/// Replace the attached node's grounds and update both directions.
fn replace_grounds(graph: &mut Graph, id: &str, grounds: Vec<String>) {
    let old: Vec<String> = graph
        .nodes
        .get(id)
        .and_then(|n| n.as_decision())
        .map(|d| d.grounds.clone())
        .unwrap_or_default();
    for ground in &old {
        drop_child(graph.nodes.get_mut(ground), id);
    }
    let interned: Vec<String> = grounds
        .into_iter()
        .map(|g| graph.nodes.get(&g).map(|n| n.id().to_string()).unwrap_or(g))
        .collect();
    for ground in &interned {
        add_child(graph.nodes.get_mut(ground), id);
    }
    if let Some(decision) = graph
        .nodes
        .get_mut(id)
        .and_then(|n| n.node.as_decision_mut())
    {
        decision.grounds = interned;
    }
}

/// Sorted, deduplicated insertion into the parent's children.
fn add_child(parent: Option<&mut GraphNode>, id: &str) {
    let Some(parent) = parent else {
        return; // unknown grounds stay out; validate_graph reports them
    };
    match parent.children.binary_search_by(|c| c.as_str().cmp(id)) {
        Ok(_) => {}
        Err(at) => parent.children.insert(at, id.to_string()),
    }
}

fn drop_child(parent: Option<&mut GraphNode>, id: &str) {
    let Some(parent) = parent else { return };
    if let Ok(at) = parent.children.binary_search_by(|c| c.as_str().cmp(id)) {
        parent.children.remove(at);
    }
}

/// Convenience: the decision fields of a graph-attached node.
impl GraphNode {
    pub fn decision(&self) -> Option<&DecisionNode> {
        self.node.as_decision()
    }
}
