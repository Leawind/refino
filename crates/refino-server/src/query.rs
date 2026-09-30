//! Canvas on-demand query logic over the resident graph (docs/design.md,
//! "画布按需查询"). Pure graph functions: HTTP shaping lives in the server.

use refino_core::{
    get_ancestors, get_dependents, get_grounds, get_siblings, query_groups, Graph, NodeLite,
    NodeType, QueryGroup, RefinoNode, TraversalOptions,
};
use std::collections::BTreeMap;

/// A light node with its distance from the query's anchor; 0 for the anchor.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeWithDepth {
    #[serde(flatten)]
    pub lite: NodeLite,
    pub depth: usize,
}

/// One id's neighborhood: nearest-first, truncated when over budget.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Neighborhood {
    pub truncated: bool,
    pub nodes: Vec<NodeWithDepth>,
}

/// One id's expansion block: the unit the canvas working set grows by.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Expansion {
    pub truncated: bool,
    pub nodes: Vec<NodeWithDepth>,
}

pub struct ExpandParams {
    /// Descendant decision generations per anchor; None is unbounded.
    pub descendant_depth: Option<usize>,
    /// Whether strong siblings of the anchor join the block.
    pub show_siblings: bool,
    /// Sibling candidates kept per anchor (overlap-descending, id-ascending).
    pub sibling_limit: Option<usize>,
    /// Per-block truncation limit (nearest-first) and traversal cap.
    pub limit: Option<usize>,
}

/// The wire shape of a light node as the TypeScript engine produced it
/// (`grounds` present only on decisions).
pub fn to_lite(node: &RefinoNode) -> NodeLite {
    match node {
        RefinoNode::Premise(p) => NodeLite {
            id: p.id.clone(),
            node_type: NodeType::Premise,
            summary: p.summary.clone(),
            grounds: None,
            exploring: None,
        },
        RefinoNode::Decision(d) => NodeLite {
            id: d.id.clone(),
            node_type: NodeType::Decision,
            summary: d.summary.clone(),
            grounds: Some(d.grounds.clone()),
            exploring: d.exploring,
        },
    }
}

/// Per-id neighborhood: the anchor itself at depth 0, ancestors up to
/// `ancestor_depth` (decisions and premises) plus descendants up to
/// `descendant_depth` (decisions only — only decisions carry grounds).
/// Nearest-first; `limit` truncates.
pub fn neighbors(
    graph: &Graph,
    ids: &[String],
    params: &NeighborsParams,
) -> Vec<QueryGroup<Neighborhood>> {
    query_groups(graph, ids, |g, id| {
        let mut depth: BTreeMap<String, usize> = BTreeMap::new();
        depth.insert(id.to_string(), 0);
        if let Ok(entries) = get_ancestors(
            g,
            id,
            TraversalOptions { max_depth: Some(params.ancestor_depth) },
        ) {
            for entry in entries {
                depth.insert(entry.node.id().to_string(), entry.depth);
            }
        }
        if let Ok(entries) = get_dependents(
            g,
            id,
            TraversalOptions { max_depth: Some(params.descendant_depth) },
        ) {
            for entry in entries {
                match depth.get(entry.node.id()) {
                    None => {
                        depth.insert(entry.node.id().to_string(), entry.depth);
                    }
                    Some(previous) if entry.depth < *previous => {
                        depth.insert(entry.node.id().to_string(), entry.depth);
                    }
                    _ => {}
                }
            }
        }
        let mut sorted: Vec<(String, usize)> = depth.into_iter().collect();
        sorted.sort_by(depth_then_id);
        let truncated = params.limit.is_some_and(|limit| sorted.len() > limit);
        let kept: Vec<(String, usize)> = match params.limit {
            Some(limit) if truncated => sorted[..limit].to_vec(),
            _ => sorted,
        };
        vec![Neighborhood {
            truncated,
            nodes: kept
                .iter()
                .map(|(nid, d)| NodeWithDepth {
                    lite: to_lite(&graph.nodes[nid].node),
                    depth: *d,
                })
                .collect(),
        }]
    })
}

pub struct NeighborsParams {
    pub ancestor_depth: usize,
    pub descendant_depth: usize,
    pub limit: Option<usize>,
}

/// Per-id direct grounds (single hop, premises and decisions, declared order).
pub fn grounds(graph: &Graph, ids: &[String]) -> Vec<QueryGroup<NodeLite>> {
    query_groups(graph, ids, |g, id| {
        get_grounds(g, id)
            .map(|ns| ns.iter().map(|n| to_lite(&n.node)).collect())
            .unwrap_or_default()
    })
}

/// Per-id expansion block: the anchor's full upstream closure,
/// `descendant_depth` generations of decisions downstream, strong siblings,
/// and the upstream closure of every block decision.
pub fn expand(
    graph: &Graph,
    ids: &[String],
    params: &ExpandParams,
) -> Vec<QueryGroup<Expansion>> {
    query_groups(graph, ids, |g, id| vec![expand_one(g, id, params)])
}

#[allow(clippy::too_many_lines)]
fn expand_one(graph: &Graph, id: &str, params: &ExpandParams) -> Expansion {
    let mut depth: BTreeMap<String, usize> = BTreeMap::new();
    depth.insert(id.to_string(), 0);

    // Downstream decisions, nearest-first min-depth merge.
    if let Ok(entries) = get_dependents(graph, id, TraversalOptions { max_depth: params.descendant_depth }) {
        for entry in entries {
            match depth.get(entry.node.id()) {
                None => {
                    depth.insert(entry.node.id().to_string(), entry.depth);
                }
                Some(previous) if entry.depth < *previous => {
                    depth.insert(entry.node.id().to_string(), entry.depth);
                }
                _ => {}
            }
        }
    }

    // Upstream sources: the anchor at 0, every downstream node at its depth,
    // strong siblings at 2.
    let mut seeds: Vec<(String, usize)> = vec![(id.to_string(), 0)];
    for (node_id, d) in &depth {
        if node_id != id {
            seeds.push((node_id.clone(), *d));
        }
    }
    if params.show_siblings {
        if let Ok(all) = get_siblings(graph, id) {
            let kept: Vec<_> = match params.sibling_limit {
                Some(limit) => &all[..limit.min(all.len())],
                None => &all,
            };
            for entry in kept {
                seeds.push((entry.node.id().to_string(), 2));
            }
        }
    }
    seeds.sort_by(depth_then_id);

    let mut depths_ref = depth.clone();
    let (expansions, capped) = upstream_closure(graph, &seeds, &mut depths_ref, params.limit);
    depth = depths_ref;

    let mut sorted: Vec<(String, usize)> = depth.into_iter().collect();
    sorted.sort_by(depth_then_id);
    let truncated = params.limit.is_some_and(|limit| sorted.len() > limit);
    let kept: Vec<(String, usize)> = match params.limit {
        Some(limit) if truncated => sorted[..limit].to_vec(),
        _ => sorted,
    };
    Expansion {
        truncated: truncated || capped && expansions > 0 && params.limit.is_some(),
        nodes: kept
            .iter()
            .map(|(nid, d)| NodeWithDepth {
                lite: to_lite(&graph.nodes[nid].node),
                depth: *d,
            })
            .collect(),
    }
}

/// Default expansion budget per endpoint when the caller sends none.
pub const DEFAULT_RANGE_BUDGET: usize = 10_000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeNode {
    #[serde(flatten)]
    pub lite: NodeLite,
    pub depth: Option<usize>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeResult {
    pub mode: &'static str,
    pub nodes: Vec<RangeNode>,
}

/// Range selection between two endpoints: ancestor / branches / disconnected.
#[allow(clippy::too_many_lines)]
pub fn range(graph: &Graph, focus_id: &str, clicked_id: &str, budget: usize) -> RangeResult {
    let mut focus_anc = ancestors_within(graph, focus_id, budget.max(1));
    let focus_expansions = focus_anc.expansions;
    let clicked_anc = ancestors_within(graph, clicked_id, budget.saturating_sub(focus_expansions).max(1));

    // A node is trivially its own ancestor; treat self-selection as ancestor.
    if focus_id == clicked_id || focus_anc.depths.contains_key(clicked_id) {
        let ancestor_id = if focus_id == clicked_id { focus_id } else { clicked_id };
        return ancestor_range(graph, focus_id, clicked_id, ancestor_id, &focus_anc, &clicked_anc);
    }
    if clicked_anc.depths.contains_key(focus_id) {
        return ancestor_range(graph, focus_id, clicked_id, focus_id, &focus_anc, &clicked_anc);
    }

    // Nearest common ancestor: minimal total path length, then decision nodes
    // before premises, then id order.
    let mut lca: Option<String> = None;
    let mut best = usize::MAX;
    let mut lca_is_premise = false;
    for (id, from_focus) in &focus_anc.depths {
        let Some(from_clicked) = clicked_anc.depths.get(id) else { continue };
        let total = from_focus + from_clicked;
        let premise = graph.nodes.get(id).map(|n| n.node_type()) != Some(NodeType::Decision);
        let better = total < best
            || (total == best
                && match &lca {
                    None => true,
                    Some(existing) => {
                        (lca_is_premise && !premise)
                            || (lca_is_premise == premise && id < existing)
                    }
                });
        if better {
            best = total;
            lca = Some(id.clone());
            lca_is_premise = premise;
        }
    }
    if let Some(lca) = lca {
        let from_focus_lca = focus_anc.depths[&lca];
        let from_clicked_lca = clicked_anc.depths[&lca];
        // One shortest path per side, both walked down from the LCA.
        let mut depth_from_focus: BTreeMap<String, usize> = BTreeMap::new();
        shortest_path_down(graph, &lca, focus_id, &focus_anc.depths, &mut |id, left| {
            depth_from_focus.insert(id.to_string(), left);
        });
        shortest_path_down(graph, &lca, clicked_id, &clicked_anc.depths, &mut |id, left| {
            let total = from_focus_lca + (from_clicked_lca - left);
            match depth_from_focus.get(id) {
                None => {
                    depth_from_focus.insert(id.to_string(), total);
                }
                Some(previous) if total < *previous => {
                    depth_from_focus.insert(id.to_string(), total);
                }
                _ => {}
            }
        });
        // Endpoints are kept even when premises.
        depth_from_focus.insert(focus_id.to_string(), 0);
        depth_from_focus.insert(clicked_id.to_string(), from_focus_lca + from_clicked_lca);
        return RangeResult { mode: "branches", nodes: materialize(graph, &depth_from_focus, None) };
    }

    RangeResult {
        mode: "disconnected",
        nodes: vec![RangeNode {
            lite: to_lite(&graph.nodes[clicked_id].node),
            depth: clicked_anc.depths.get(focus_id).copied(),
        }],
    }
}

/// Ancestor relationship: decisions on all paths between the endpoints plus
/// both endpoints, ordered by depth from focus.
#[allow(clippy::too_many_arguments)]
fn ancestor_range(
    graph: &Graph,
    focus_id: &str,
    clicked_id: &str,
    ancestor_id: &str,
    focus_anc: &BoundedAncestors,
    clicked_anc: &BoundedAncestors,
) -> RangeResult {
    let focus_is_ancestor = ancestor_id == focus_id;
    let descendant_id = if focus_is_ancestor { clicked_id } else { focus_id };
    let descendant_ancestors = if focus_is_ancestor { &clicked_anc.depths } else { &focus_anc.depths };

    let down = get_dependents(graph, ancestor_id, TraversalOptions::default()).unwrap_or_default();
    let mut ids: BTreeMap<String, ()> = BTreeMap::new();
    ids.insert(ancestor_id.to_string(), ());
    ids.insert(descendant_id.to_string(), ());
    for entry in &down {
        if descendant_ancestors.contains_key(entry.node.id()) {
            ids.insert(entry.node.id().to_string(), ());
        }
    }

    let mut depth_from_focus = focus_anc.depths.clone();
    if focus_is_ancestor {
        for entry in &down {
            match depth_from_focus.get(entry.node.id()) {
                None => {
                    depth_from_focus.insert(entry.node.id().to_string(), entry.depth);
                }
                Some(previous) if entry.depth < *previous => {
                    depth_from_focus.insert(entry.node.id().to_string(), entry.depth);
                }
                _ => {}
            }
        }
        if let Some(clicked_depth) = clicked_anc.depths.get(focus_id) {
            depth_from_focus.insert(clicked_id.to_string(), *clicked_depth);
        }
    }
    let ids = ids.into_keys().collect::<Vec<_>>();
    RangeResult { mode: "ancestor", nodes: materialize(graph, &depth_from_focus, Some(&ids)) }
}

/// One shortest decision path from the LCA down to an endpoint.
fn shortest_path_down(
    graph: &Graph,
    lca_id: &str,
    end_id: &str,
    depths: &BTreeMap<String, usize>,
    assign: &mut dyn FnMut(&str, usize),
) {
    let mut current = lca_id.to_string();
    if graph.nodes.get(&current).map(|n| n.node_type()) == Some(NodeType::Decision) {
        assign(&current, depths[&current]);
    }
    while current != end_id {
        let remaining = depths[&current];
        let mut next: Option<String> = None;
        let dependents =
            get_dependents(graph, &current, TraversalOptions { max_depth: Some(1) }).unwrap_or_default();
        for entry in dependents {
            if depths.get(entry.node.id()) != Some(&(remaining - 1)) {
                continue;
            }
            if next.as_deref().is_none_or(|n| entry.node.id() < n) {
                next = Some(entry.node.id().to_string());
            }
        }
        let Some(next) = next else { break };
        current = next;
        if graph.nodes.get(&current).map(|n| n.node_type()) == Some(NodeType::Decision) {
            assign(&current, depths[&current]);
        }
    }
}

fn materialize(
    graph: &Graph,
    depth_from_focus: &BTreeMap<String, usize>,
    ids: Option<&[String]>,
) -> Vec<RangeNode> {
    let keys: Vec<String> = match ids {
        Some(ids) => ids.to_vec(),
        None => depth_from_focus.keys().cloned().collect(),
    };
    let mut rows: Vec<(String, Option<usize>)> = keys
        .into_iter()
        .map(|id| {
            let d = depth_from_focus.get(&id).copied();
            (id, d)
        })
        .collect();
    rows.sort_by(|a, b| {
        a.1.unwrap_or(usize::MAX)
            .cmp(&b.1.unwrap_or(usize::MAX))
            .then_with(|| a.0.cmp(&b.0))
    });
    rows.into_iter()
        .map(|(id, depth)| RangeNode {
            lite: to_lite(&graph.nodes[&id].node),
            depth,
        })
        .collect()
}

struct BoundedAncestors {
    /// Id -> depth from the start node; includes the start at depth 0.
    depths: BTreeMap<String, usize>,
    expansions: usize,
}

/// Breadth-first ancestor search along grounds edges, counting expansions
/// against the budget so range queries stay bounded at scale.
fn ancestors_within(graph: &Graph, start: &str, budget: usize) -> BoundedAncestors {
    let mut depths: BTreeMap<String, usize> = BTreeMap::new();
    depths.insert(start.to_string(), 0);
    let (expansions, _) =
        upstream_closure(graph, &[(start.to_string(), 0)], &mut depths, Some(budget.max(1)));
    BoundedAncestors { depths, expansions }
}

/// Multi-source upstream closure over grounds edges. Sources are processed in
/// ascending seed-depth order; each runs one breadth-first walk merging
/// minimal depths into `depths`. `cap` bounds total expansions (dequeues);
/// the flag reports an early stop.
fn upstream_closure(
    graph: &Graph,
    seeds: &[(String, usize)],
    depths: &mut BTreeMap<String, usize>,
    cap: Option<usize>,
) -> (usize, bool) {
    let limit = cap.map(|c| c.max(1));
    let mut expansions = 0usize;
    for (seed_id, base) in seeds {
        match depths.get(seed_id) {
            Some(previous) if *base >= *previous => {}
            _ => {
                depths.insert(seed_id.clone(), *base);
            }
        }
        if limit.is_some_and(|limit| expansions >= limit) {
            return (expansions, true);
        }
        let seed_depth = depths[seed_id];
        let mut queue: Vec<(String, usize)> = vec![(seed_id.clone(), seed_depth)];
        let mut visited: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        visited.insert(seed_id.clone());
        let mut capped = false;
        let mut head = 0;
        while head < queue.len() {
            if limit.is_some_and(|limit| expansions >= limit) {
                capped = true;
                break;
            }
            let (current, depth) = queue[head].clone();
            head += 1;
            expansions += 1;
            let grounds: Vec<String> = graph
                .nodes
                .get(&current)
                .and_then(|n| n.as_decision())
                .map(|d| d.grounds.clone())
                .unwrap_or_default();
            for ground in grounds {
                if !graph.nodes.contains_key(&ground) || visited.contains(&ground) {
                    continue;
                }
                visited.insert(ground.clone());
                depths.entry(ground.clone()).or_insert(depth + 1);
                queue.push((ground, depth + 1));
            }
        }
        if capped {
            return (expansions, true);
        }
    }
    (expansions, false)
}

fn depth_then_id(a: &(String, usize), b: &(String, usize)) -> std::cmp::Ordering {
    a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0))
}
