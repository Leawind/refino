//! Read-side graph queries.

use crate::types::{Graph, GraphNode, IssueCode, NodeType, QueryGroup, RefinoError, RefinoNode};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, PartialEq)]
pub struct NodeWithDepth {
    pub node: GraphNode,
    /// Distance from the queried node: direct grounds/dependents have depth 1.
    pub depth: usize,
}

/// Return the node with the given id, erroring if it does not exist.
pub fn require_node<'a>(graph: &'a Graph, id: &str) -> Result<&'a GraphNode, RefinoError> {
    graph.nodes.get(id).ok_or_else(|| {
        RefinoError::new(
            IssueCode::NODE_NOT_FOUND,
            format!("Node \"{id}\" not found"),
        )
    })
}

/// Direct grounds of a node, resolved and in declared order. Premises have
/// none.
pub fn get_grounds(graph: &Graph, id: &str) -> Result<Vec<GraphNode>, RefinoError> {
    let node = require_node(graph, id)?;
    let mut result = Vec::new();
    if let Some(decision) = node.as_decision() {
        for ground in &decision.grounds {
            if let Some(target) = graph.nodes.get(ground) {
                result.push(target.clone());
            }
        }
    }
    Ok(result)
}

/// Options shared by the traversal queries.
#[derive(Debug, Clone, Copy, Default)]
pub struct TraversalOptions {
    /// Maximum depth to include: 0 returns nothing (the start node itself is
    /// always excluded), 1 only direct grounds/dependents. `None` is
    /// unbounded.
    pub max_depth: Option<usize>,
}

/// All nodes reachable from a node by recursively following `grounds`
/// (premises and upstream decisions), excluding the node itself.
pub fn get_ancestors(
    graph: &Graph,
    id: &str,
    options: TraversalOptions,
) -> Result<Vec<NodeWithDepth>, RefinoError> {
    require_node(graph, id)?;
    Ok(breadth_first(
        graph,
        id,
        Direction::Grounds,
        options.max_depth,
    ))
}

/// All decision nodes that directly or indirectly depend on a node, i.e.
/// whose `grounds` transitively contain it, excluding the node itself.
pub fn get_dependents(
    graph: &Graph,
    id: &str,
    options: TraversalOptions,
) -> Result<Vec<NodeWithDepth>, RefinoError> {
    require_node(graph, id)?;
    Ok(breadth_first(
        graph,
        id,
        Direction::Children,
        options.max_depth,
    ))
}

#[derive(Debug, Clone, Copy)]
enum Direction {
    Grounds,
    Children,
}

/// Effective exploring status of a node: a decision is
/// effectively exploring when it carries the trial mark itself or any
/// (transitive) ground decision does; premises are never exploring.
/// Derived at read time along the grounds closure, never stored per node.
/// Errors when the id does not resolve.
pub fn effective_exploring(graph: &Graph, id: &str) -> Result<bool, RefinoError> {
    let node = require_node(graph, id)?;
    let Some(decision) = node.as_decision() else {
        return Ok(false);
    };
    if decision.exploring == Some(true) {
        return Ok(true);
    }
    let ancestors = get_ancestors(graph, id, TraversalOptions::default())?;
    Ok(ancestors.iter().any(|a| {
        a.node
            .as_decision()
            .and_then(|d| d.exploring)
            .unwrap_or(false)
    }))
}

#[derive(Debug, Clone)]
pub struct NodeWithOverlap {
    pub node: GraphNode,
    /// Number of direct grounds shared with the queried node.
    pub overlap: usize,
}

/// Strong siblings of a node: decisions sharing at least one direct ground
/// with it — never the node itself, never premises (dependents are always
/// decisions). Overlap-descending, id-ascending; unbounded, so callers
/// truncate to their own budget. Premises have no grounds and thus no
/// siblings.
pub fn get_siblings(graph: &Graph, id: &str) -> Result<Vec<NodeWithOverlap>, RefinoError> {
    let node = require_node(graph, id)?;
    let mut overlap: BTreeMap<String, usize> = BTreeMap::new();
    if let Some(decision) = node.as_decision() {
        for ground in &decision.grounds {
            for dependent in graph
                .nodes
                .get(ground)
                .map(|n| &n.children)
                .into_iter()
                .flatten()
            {
                if dependent == id {
                    continue;
                }
                *overlap.entry(dependent.clone()).or_insert(0) += 1;
            }
        }
    }
    // BTreeMap iteration is id-ascending; the stable sort keeps that order
    // within equal overlap.
    let mut entries: Vec<NodeWithOverlap> = overlap
        .into_iter()
        .map(|(sibling_id, count)| NodeWithOverlap {
            node: graph.nodes[&sibling_id].clone(),
            overlap: count,
        })
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.overlap));
    Ok(entries)
}

/// Run a query for each id with batch, partial-success semantics: ids that do
/// not resolve yield a per-id error group while the remaining ids keep their
/// results. `select` is only called for ids that exist in the graph.
pub fn query_groups<T>(
    graph: &Graph,
    ids: &[String],
    select: impl Fn(&Graph, &str) -> Vec<T>,
) -> Vec<QueryGroup<T>> {
    ids.iter()
        .map(|id| {
            if graph.nodes.contains_key(id) {
                QueryGroup::Results {
                    id: id.clone(),
                    results: select(graph, id),
                }
            } else {
                QueryGroup::Error {
                    id: id.clone(),
                    error: format!("Node \"{id}\" not found"),
                }
            }
        })
        .collect()
}

fn breadth_first(
    graph: &Graph,
    start: &str,
    direction: Direction,
    max_depth: Option<usize>,
) -> Vec<NodeWithDepth> {
    let mut depth: HashMap<String, usize> = HashMap::new();
    depth.insert(start.to_string(), 0);
    let mut queue: Vec<String> = vec![start.to_string()];
    let mut head = 0;
    while head < queue.len() {
        let current = &queue[head];
        let current_depth = depth[current];
        head += 1;
        // BFS queue depths are non-decreasing, so no later node can expand either.
        if max_depth.is_some_and(|max| current_depth >= max) {
            break;
        }
        let Some(node) = graph.nodes.get(current) else {
            continue; // unknown ids can only appear in an invalid graph
        };
        let neighbors: Vec<String> = match direction {
            Direction::Grounds => match &node.node {
                RefinoNode::Decision(d) => d
                    .grounds
                    .iter()
                    .filter(|g| graph.nodes.contains_key(*g))
                    .cloned()
                    .collect(),
                _ => Vec::new(),
            },
            Direction::Children => node.children.clone(),
        };
        for neighbor in neighbors {
            if !depth.contains_key(&neighbor) {
                depth.insert(neighbor.clone(), current_depth + 1);
                queue.push(neighbor);
            }
        }
    }
    depth.remove(start);
    let mut results: Vec<NodeWithDepth> = depth
        .into_iter()
        .map(|(node_id, d)| NodeWithDepth {
            node: graph.nodes[&node_id].clone(),
            depth: d,
        })
        .collect();
    results.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| a.node.id().cmp(b.node.id()))
    });
    results
}

/// Milliseconds in a day, the unit of node ages.
const DAY_MS: i64 = 86_400_000;

/// One node due for review, with the number of completed days since its last
/// review (decisions) or confirmation (premises).
#[derive(Debug, Clone, PartialEq)]
pub struct StaleNode {
    pub id: String,
    pub node_type: NodeType,
    pub summary: String,
    /// Completed days since the last review/confirmation; `None` when the
    /// node has no such timestamp.
    pub age_days: Option<i64>,
}

/// Nodes due for review, split into the two maintenance groups.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StaleReport {
    /// Age strictly greater than the threshold, oldest first (ties by id).
    pub overdue: Vec<StaleNode>,
    /// No review/confirmation timestamp at all, id ascending.
    pub never_reviewed: Vec<StaleNode>,
}

/// Split nodes into overdue and never-reviewed groups. A decision's age comes
/// from `reviewed`, a premise's from `confirmed`; `days` is the age threshold
/// in completed days. `now_ms` is epoch milliseconds supplied by the caller:
/// the engine has no clock dependency, so hosts inject it (`Io::now_ms` on
/// native hosts) instead of reading the system time here.
pub fn stale_nodes(graph: &Graph, now_ms: i64, days: i64) -> StaleReport {
    let mut overdue: Vec<StaleNode> = Vec::new();
    let mut never_reviewed: Vec<StaleNode> = Vec::new();
    for node in graph.nodes.values() {
        let timestamp = match &node.node {
            RefinoNode::Decision(decision) => decision.reviewed,
            RefinoNode::Premise(premise) => premise.confirmed,
        };
        let Some(timestamp) = timestamp else {
            never_reviewed.push(stale_row(node, None));
            continue;
        };
        // Future timestamps (clock skew) count as reviewed today.
        let age_days = now_ms.saturating_sub(timestamp).max(0) / DAY_MS;
        if age_days > days {
            overdue.push(stale_row(node, Some(age_days)));
        }
    }
    overdue.sort_by(|a, b| b.age_days.cmp(&a.age_days).then_with(|| a.id.cmp(&b.id)));
    never_reviewed.sort_by(|a, b| a.id.cmp(&b.id));
    StaleReport {
        overdue,
        never_reviewed,
    }
}

fn stale_row(node: &GraphNode, age_days: Option<i64>) -> StaleNode {
    StaleNode {
        id: node.id().to_string(),
        node_type: node.node_type(),
        summary: node.summary().to_string(),
        age_days,
    }
}
