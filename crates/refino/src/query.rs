//! Read commands: list, show and the grounds/ancestors/dependents graph
//! queries. All of them run through `with_store`: graph issues make query
//! results ambiguous, so reads refuse while issues exist.

use crate::format::{CliSink, TableRow, render_full_record, render_node_table};
use crate::shared::{GlobalOptions, finish, type_name, with_store};
use refino_core::{
    LayerNode, NodeLite, NodeType, QueryGroup, RefinoNode, TraversalOptions, assign_layers,
    effective_exploring, get_ancestors, get_dependents, get_grounds, query_groups, require_node,
};

/// One `list --json` row: the resident fields plus the derived effective
/// exploring status (the stored mark alone is `exploring`, absent when
/// settled).
#[derive(serde::Serialize)]
pub struct JsonListRow {
    #[serde(flatten)]
    lite: NodeLite,
    exploring_effective: bool,
}

/// One `show --json` result row: the full record as structured data.
#[derive(serde::Serialize)]
pub struct JsonShowRow {
    node: RefinoNode,
    content: refino_storage::NodeContent,
    exploring_effective: bool,
}

/// `search --json` page: mirrors the harness SearchPage contract.
#[derive(serde::Serialize)]
pub struct JsonSearchPage {
    query: String,
    nodes: Vec<JsonSearchNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

#[derive(serde::Serialize)]
pub struct JsonSearchNode {
    id: String,
    #[serde(rename = "type")]
    node_type: NodeType,
    summary: String,
}

pub fn cmd_list(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    type_filter: Option<NodeType>,
    unreferenced: bool,
    roots: bool,
    limit: Option<usize>,
    json: bool,
) -> i32 {
    if unreferenced && type_filter == Some(NodeType::Decision) {
        io.err("error: --unreferenced only applies to premises\n");
        return 1;
    }
    if roots && unreferenced {
        io.err("error: --roots and --unreferenced are mutually exclusive\n");
        return 1;
    }
    if roots && type_filter == Some(NodeType::Premise) {
        io.err("error: --roots only applies to decisions\n");
        return 1;
    }
    if limit == Some(0) {
        io.err("error: --limit must be at least 1\n");
        return 1;
    }
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        let mut nodes: Vec<RefinoNode> = sort_nodes(graph);
        if let Some(filter) = type_filter {
            nodes.retain(|n| n.node_type() == filter);
        }
        // Top-level decisions in the canvas sense (docs/design.md, "画布按需
        // 查询"): no direct ground is a decision, so decisions grounded only
        // on premises still count — every graph has at least one entry point.
        if roots {
            nodes.retain(|n| match n.as_decision() {
                Some(d) => !d.grounds.iter().any(|g| {
                    graph
                        .nodes
                        .get(g)
                        .is_some_and(|gn| gn.node_type() == NodeType::Decision)
                }),
                None => false,
            });
        }
        if unreferenced {
            let referenced: std::collections::HashSet<String> = graph
                .nodes
                .values()
                .filter_map(|n| n.as_decision())
                .flat_map(|d| d.grounds.iter().cloned())
                .collect();
            nodes.retain(|n| n.node_type() == NodeType::Premise && !referenced.contains(n.id()));
        }
        // The cap keeps the most upstream nodes: sort_nodes orders upstream
        // → downstream, which is the orientation a cold-start list wants.
        let total = nodes.len();
        if let Some(cap) = limit {
            nodes.truncate(cap);
        }
        if json {
            let rows: Vec<JsonListRow> = nodes
                .iter()
                .map(|n| JsonListRow {
                    lite: to_lite(n),
                    exploring_effective: n.node_type() == NodeType::Decision
                        && effective_exploring(graph, n.id()).unwrap_or(false),
                })
                .collect();
            io.out(&format!(
                "{}\n",
                serde_json::to_string(&rows).unwrap_or_default()
            ));
            return Ok(0);
        }
        if nodes.is_empty() {
            io.out("(no nodes)\n");
        } else {
            let rows: Vec<TableRow> = nodes
                .iter()
                .map(|n| TableRow {
                    id: n.id().to_string(),
                    node_type: type_name(n).to_string(),
                    summary: n.summary().to_string(),
                    depth: None,
                    exploring: Some(
                        n.node_type() == NodeType::Decision
                            && effective_exploring(graph, n.id()).unwrap_or(false),
                    ),
                })
                .collect();
            io.out(&format!("{}\n", render_node_table(&rows)));
            if limit.is_some_and(|cap| total > cap) {
                io.out(&format!(
                    "(truncated at {}; more nodes remain)\n",
                    rows.len()
                ));
            }
        }
        Ok(0)
    });
    finish(io, outcome)
}

/// The resident fields of a node as the light wire shape (`grounds` present
/// only on decisions; `exploring` is the stored mark, absent when settled).
fn to_lite(node: &RefinoNode) -> NodeLite {
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

/// `search` — the CLI face of the shared node-search contract (the harness
/// `search` tool and the web `/api/search` endpoint use the same matching):
/// a query matches id prefixes and summary substrings, both case-insensitively
/// (ids are Crockford base32); empty queries match everything. Results come
/// in ascending id order, keyset-paginated by cursor. Bodies are paged
/// content and deliberately not searched.
pub fn cmd_search(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    q: Option<&str>,
    type_filter: Option<NodeType>,
    limit: Option<usize>,
    cursor: Option<&str>,
    json: bool,
) -> i32 {
    const DEFAULT_LIMIT: usize = 50;
    const MAX_LIMIT: usize = 500;
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let q = q.unwrap_or("").trim();
        let q_upper = q.to_uppercase();
        let q_lower = q_upper.to_lowercase();
        // Keyset cursor: resume strictly after the given id; unknown cursors
        // degrade to "the next id in order", mirroring the harness contract.
        let start: std::collections::Bound<&str> = match cursor {
            Some(id) => std::collections::Bound::Excluded(id),
            None => std::collections::Bound::Unbounded,
        };
        let range: (std::collections::Bound<&str>, std::collections::Bound<&str>) =
            (start, std::collections::Bound::Unbounded);
        let mut matched: Vec<(&String, &refino_core::GraphNode)> = Vec::new();
        let mut more = false;
        for (id, entry) in graph.nodes.range::<str, _>(range) {
            if type_filter.is_some_and(|t| entry.node_type() != t) {
                continue;
            }
            if !q_upper.is_empty()
                && !id.to_uppercase().starts_with(&q_upper)
                && !entry.summary().to_lowercase().contains(&q_lower)
            {
                continue;
            }
            if matched.len() == limit {
                more = true;
                break;
            }
            matched.push((id, entry));
        }
        if json {
            let page = JsonSearchPage {
                query: q.to_string(),
                nodes: matched
                    .iter()
                    .map(|(id, entry)| JsonSearchNode {
                        id: (*id).clone(),
                        node_type: entry.node_type(),
                        summary: entry.summary().to_string(),
                    })
                    .collect(),
                next_cursor: more
                    .then(|| matched.last().map(|(id, _)| (*id).clone()))
                    .flatten(),
            };
            io.out(&format!(
                "{}\n",
                serde_json::to_string(&page).unwrap_or_default()
            ));
            return Ok(0);
        }
        if matched.is_empty() {
            io.out("(no matches)\n");
        } else {
            let rows: Vec<TableRow> = matched
                .iter()
                .map(|(id, entry)| TableRow {
                    id: (*id).clone(),
                    node_type: type_name(&entry.node).to_string(),
                    summary: entry.summary().to_string(),
                    depth: None,
                    exploring: Some(
                        entry.node_type() == NodeType::Decision
                            && effective_exploring(graph, id).unwrap_or(false),
                    ),
                })
                .collect();
            io.out(&format!("{}\n", render_node_table(&rows)));
            if more {
                let last = matched.last().map(|(id, _)| id.as_str()).unwrap_or("");
                io.out(&format!("(more results; continue with --cursor {last})\n"));
            }
        }
        Ok(0)
    });
    finish(io, outcome)
}

pub fn cmd_show(io: &mut dyn CliSink, opts: &GlobalOptions, ids: &[String], json: bool) -> i32 {
    let ids = ids.to_vec();
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        // select only runs for ids that exist, so require_node cannot fail.
        let groups = query_groups(graph, &ids, |g, id| {
            vec![require_node(g, id).expect("id checked").node.clone()]
        });
        let missing = groups.iter().any(|g| matches!(g, QueryGroup::Error { .. }));
        if json {
            // The shared batch contract (per-id error entries, results for
            // the remaining ids) with the full record as the payload.
            let mut payload: Vec<QueryGroup<JsonShowRow>> = Vec::new();
            for group in &groups {
                match group {
                    QueryGroup::Error { id, error } => {
                        payload.push(QueryGroup::Error {
                            id: id.clone(),
                            error: error.clone(),
                        });
                    }
                    QueryGroup::Results { id, results } => {
                        let node = &results[0];
                        let content = store.content(id)?.unwrap_or_default();
                        let effective = effective_exploring(store.graph(), id).unwrap_or(false);
                        payload.push(QueryGroup::Results {
                            id: id.clone(),
                            results: vec![JsonShowRow {
                                node: node.clone(),
                                content,
                                exploring_effective: effective,
                            }],
                        });
                    }
                }
            }
            io.out(&format!(
                "{}\n",
                serde_json::to_string(&payload).unwrap_or_default()
            ));
            return Ok(if missing { 1 } else { 0 });
        }
        let mut parts: Vec<String> = Vec::new();
        for group in &groups {
            match group {
                QueryGroup::Error { error, .. } => parts.push(format!("error: {error}")),
                QueryGroup::Results { id, results } => {
                    let node = &results[0];
                    let content = store.content(id)?;
                    let effective = effective_exploring(store.graph(), id).unwrap_or(false);
                    parts.push(render_full_record(node, content.as_ref(), effective).to_string());
                }
            }
        }
        io.out(&format!("{}\n", parts.join("\n\n")));
        Ok(if missing { 1 } else { 0 })
    });
    finish(io, outcome)
}

#[derive(Clone, Copy)]
pub enum GraphQuery {
    Grounds,
    Ancestors,
    Dependents,
}

pub fn cmd_graph_query(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    ids: &[String],
    query: GraphQuery,
) -> i32 {
    let ids = ids.to_vec();
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        let select = |g: &refino_core::Graph, id: &str| -> Vec<(RefinoNode, Option<usize>)> {
            match query {
                GraphQuery::Grounds => get_grounds(g, id)
                    .map(|ns| ns.into_iter().map(|n| (n.node.clone(), None)).collect())
                    .unwrap_or_default(),
                GraphQuery::Ancestors => get_ancestors(g, id, TraversalOptions::default())
                    .map(|ns| {
                        ns.into_iter()
                            .map(|n| (n.node.node.clone(), Some(n.depth)))
                            .collect()
                    })
                    .unwrap_or_default(),
                GraphQuery::Dependents => get_dependents(g, id, TraversalOptions::default())
                    .map(|ns| {
                        ns.into_iter()
                            .map(|n| (n.node.node.clone(), Some(n.depth)))
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        };
        let groups = query_groups(graph, &ids, select);
        if groups.len() == 1 {
            emit_group(io, graph, &groups[0]);
        } else {
            for group in &groups {
                let id = match group {
                    QueryGroup::Results { id, .. } => id,
                    QueryGroup::Error { id, .. } => id,
                };
                io.out(&format!("{id}:\n"));
                emit_group(io, graph, group);
            }
        }
        let missing = groups.iter().any(|g| matches!(g, QueryGroup::Error { .. }));
        Ok(if missing { 1 } else { 0 })
    });
    finish(io, outcome)
}

fn emit_group(
    io: &mut dyn CliSink,
    graph: &refino_core::Graph,
    group: &QueryGroup<(RefinoNode, Option<usize>)>,
) {
    match group {
        QueryGroup::Error { error, .. } => io.out(&format!("error: {error}\n")),
        QueryGroup::Results { results, .. } => {
            if results.is_empty() {
                io.out("(empty)\n");
            } else {
                let rows: Vec<TableRow> = results
                    .iter()
                    .map(|(node, depth)| TableRow {
                        id: node.id().to_string(),
                        node_type: type_name(node).to_string(),
                        summary: node.summary().to_string(),
                        depth: *depth,
                        exploring: Some(
                            node.node_type() == NodeType::Decision
                                && effective_exploring(graph, node.id()).unwrap_or(false),
                        ),
                    })
                    .collect();
                io.out(&format!("{}\n", render_node_table(&rows)));
            }
        }
    }
}

/// List order: upstream → downstream by longest-path layer, ties in id order.
pub fn sort_nodes(graph: &refino_core::Graph) -> Vec<RefinoNode> {
    let layer_nodes: Vec<LayerNode> = graph
        .nodes
        .values()
        .map(|n| LayerNode {
            id: n.id().to_string(),
            grounds: n
                .as_decision()
                .map(|d| d.grounds.clone())
                .unwrap_or_default(),
        })
        .collect();
    let layers = assign_layers(&layer_nodes);
    let mut nodes: Vec<RefinoNode> = graph.nodes.values().map(|n| n.node.clone()).collect();
    nodes.sort_by(|a, b| {
        let la = layers.get(a.id()).copied().unwrap_or(0);
        let lb = layers.get(b.id()).copied().unwrap_or(0);
        la.cmp(&lb).then_with(|| a.id().cmp(b.id()))
    });
    nodes
}
