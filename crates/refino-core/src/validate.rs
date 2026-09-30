//! Structural validation of a loaded graph:
//! 1. every `grounds` reference resolves to an existing node;
//! 2. decision -> decision paths are acyclic.
//!
//! Purely topological: resident fields only, so it runs regardless of which
//! paged content is loaded. Parse-level rules — unique ids, id validity, the
//! RFC 3339 form of premise `confirmed` — are checked while loading; see
//! `refino-storage`. A `grounds` field on a premise is a misplaced attribute
//! and silently ignored, not a validation target.
//!
//! Cycle reporting is deterministic: each distinct cycle is reported once,
//! rotated so its smallest id comes first.

use crate::types::{DecisionNode, Graph, IssueCode, RefinoIssue, RefinoNode};
use std::collections::{HashMap, HashSet};

pub fn validate_graph(graph: &Graph) -> Vec<RefinoIssue> {
    let mut issues: Vec<RefinoIssue> = Vec::new();

    for node in graph.nodes.values() {
        if node.node_type() != crate::types::NodeType::Decision {
            continue; // edges only come from decision grounds
        }
        let decision = node.as_decision().expect("decision typed");
        for ground in &decision.grounds {
            if !graph.nodes.contains_key(ground) {
                issues.push(
                    RefinoIssue::new(
                        IssueCode::UNKNOWN_GROUND,
                        format!("\"{}\" grounds on unknown node \"{ground}\".", node.id()),
                    )
                    .with_node_id(node.id())
                    .with_ground_id(ground.clone()),
                );
            }
        }
    }

    issues.extend(find_cycles(graph));
    issues
}

/// Validate a prospective change of a decision's grounds against the current
/// graph without mutating it. All write paths call this before persisting, so
/// graph-level grounds validation has a single source. Reports:
///
/// - repeated ground ids (INVALID_GROUNDS) — the storage format deduplicates
///   grounds on load, so writing them would not round-trip;
/// - grounds referencing nodes that do not exist (UNKNOWN_GROUND);
/// - cycles the change would close (CYCLE) — a ground that is the target
///   itself or reaches it along existing grounds edges.
///
/// `node` is the decision whose `id` locates the change within `graph` (a
/// missing id is the caller's error, not an issue here); a premise target is
/// unrepresentable — premises take no grounds, and misplaced grounds are
/// silently ignored everywhere. Pre-existing issues elsewhere in the graph
/// are not reported; callers run `validate_graph` for the full picture.
/// Ground entries are not shape-checked: an entry that cannot be a node id
/// simply does not resolve.
pub fn check_grounds_change(
    graph: &Graph,
    node: &DecisionNode,
    new_grounds: &[String],
) -> Vec<RefinoIssue> {
    let id = &node.id;
    let mut issues: Vec<RefinoIssue> = Vec::new();
    // Insertion-ordered counts: one INVALID_GROUNDS per repeated id, and each
    // distinct id checked (and cycled) exactly once, in declared order.
    let mut counts: Vec<(String, usize)> = Vec::new();
    for ground in new_grounds {
        match counts.iter_mut().find(|(k, _)| k == ground) {
            Some((_, count)) => *count += 1,
            None => counts.push((ground.clone(), 1)),
        }
    }
    for (ground, count) in &counts {
        if *count > 1 {
            issues.push(
                RefinoIssue::new(
                    IssueCode::INVALID_GROUNDS,
                    format!("\"grounds\" lists node \"{ground}\" more than once."),
                )
                .with_node_id(id.clone()),
            );
        }
        if !graph.nodes.contains_key(ground) {
            issues.push(
                RefinoIssue::new(
                    IssueCode::UNKNOWN_GROUND,
                    format!("\"{id}\" grounds on unknown node \"{ground}\"."),
                )
                .with_node_id(id.clone())
                .with_ground_id(ground.clone()),
            );
        }
    }
    let distinct: Vec<String> = counts.into_iter().map(|(k, _)| k).collect();
    issues.extend(closing_cycles(graph, id, &distinct));
    issues
}

const WHITE: u8 = 0;
const GRAY: u8 = 1;
const BLACK: u8 = 2;

fn find_cycles(graph: &Graph) -> Vec<RefinoIssue> {
    let mut color: HashMap<String, u8> = HashMap::new();
    let mut stack: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut issues: Vec<RefinoIssue> = Vec::new();

    for node in graph.nodes.values() {
        if node.node_type() != crate::types::NodeType::Decision {
            continue;
        }
        if color.get(node.id()).copied().unwrap_or(WHITE) == WHITE {
            visit(
                graph,
                node.id(),
                &mut color,
                &mut stack,
                &mut seen,
                &mut issues,
            );
        }
    }
    issues
}

fn visit(
    graph: &Graph,
    id: &str,
    color: &mut HashMap<String, u8>,
    stack: &mut Vec<String>,
    seen: &mut HashSet<String>,
    issues: &mut Vec<RefinoIssue>,
) {
    color.insert(id.to_string(), GRAY);
    stack.push(id.to_string());
    // Premises declare no grounds, so only decisions can continue a cycle.
    let grounds: Vec<String> = match graph.nodes.get(id).map(|n| &n.node) {
        Some(RefinoNode::Decision(d)) => d.grounds.clone(),
        _ => Vec::new(),
    };
    for ground in &grounds {
        let Some(target) = graph.nodes.get(ground) else {
            continue;
        };
        if target.node.as_decision().is_none() {
            continue; // premises cannot take part in cycles
        }
        let state = color.get(ground).copied().unwrap_or(WHITE);
        if state == WHITE {
            visit(graph, ground, color, stack, seen, issues);
        } else if state == GRAY {
            let start = stack.iter().position(|x| x == ground).unwrap_or(0);
            let open: Vec<String> = stack[start..].to_vec();
            let cycle = close_cycle(open);
            let key = canonical_cycle_key(&cycle);
            if seen.insert(key) {
                issues.push(
                    RefinoIssue::new(
                        IssueCode::CYCLE,
                        format!("Decision cycle detected: {}.", cycle.join(" -> ")),
                    )
                    .with_node_id(id.to_string())
                    .with_cycle(cycle),
                );
            }
        }
    }
    stack.pop();
    color.insert(id.to_string(), BLACK);
}

/// A cycle found as an open path is closed by repeating its entry point.
fn close_cycle(mut open: Vec<String>) -> Vec<String> {
    if let Some(first) = open.first().cloned() {
        open.push(first);
    }
    open
}

fn canonical_cycle_key(closed: &[String]) -> String {
    let open = &closed[..closed.len() - 1];
    let mut min_index = 0;
    for (i, candidate) in open.iter().enumerate() {
        if candidate < &open[min_index] {
            min_index = i;
        }
    }
    let mut rotated: Vec<&str> = open[min_index..].iter().map(|s| s.as_str()).collect();
    rotated.extend(open[..min_index].iter().map(|s| s.as_str()));
    rotated.join(" -> ")
}

/// Cycles the change would close: for each new ground, the first path found
/// back to the changed node along existing grounds edges, reported in
/// `validate_graph`'s closed shape. Edges out of the changed node are
/// irrelevant for reaching it, so the current graph can be searched as-is.
/// Premises declare no grounds, so paths through them end immediately.
fn closing_cycles(graph: &Graph, id: &str, grounds: &[String]) -> Vec<RefinoIssue> {
    let mut issues: Vec<RefinoIssue> = Vec::new();
    for ground in grounds {
        let Some(path) = grounds_path(graph, ground, id) else {
            continue;
        };
        let mut cycle = vec![id.to_string()];
        cycle.extend(path);
        issues.push(
            RefinoIssue::new(
                IssueCode::CYCLE,
                format!("Decision cycle detected: {}.", cycle.join(" -> ")),
            )
            .with_node_id(id.to_string())
            .with_cycle(cycle),
        );
    }
    issues
}

/// First path from `start` to `target` along grounds edges, both ends
/// inclusive, or None. Neighbors are visited in declared grounds order, so
/// the result is deterministic; the visited set prunes branches that cannot
/// reach the target, keeping the search linear in the reachable subgraph even
/// when the graph already contains cycles.
fn grounds_path(graph: &Graph, start: &str, target: &str) -> Option<Vec<String>> {
    let mut path: Vec<String> = vec![start.to_string()];
    let mut visited: HashSet<String> = HashSet::new();
    let found = path_visit(graph, start, target, &mut path, &mut visited);
    found.then_some(path)
}

fn path_visit(
    graph: &Graph,
    current: &str,
    target: &str,
    path: &mut Vec<String>,
    visited: &mut HashSet<String>,
) -> bool {
    if current == target {
        return true;
    }
    if visited.contains(current) {
        return false;
    }
    visited.insert(current.to_string());
    let grounds: Vec<String> = match graph.nodes.get(current).map(|n| &n.node) {
        Some(RefinoNode::Decision(d)) => d.grounds.clone(),
        _ => Vec::new(),
    };
    for ground in &grounds {
        path.push(ground.clone());
        if path_visit(graph, ground, target, path, visited) {
            return true;
        }
        path.pop();
    }
    false
}
