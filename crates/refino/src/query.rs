//! Read commands: list, show and the grounds/ancestors/dependents graph
//! queries. All of them run through `with_store`: graph issues make query
//! results ambiguous, so reads refuse while issues exist.

use crate::format::{CliSink, TableRow, render_full_record, render_node_table};
use crate::shared::{GlobalOptions, finish, type_name, with_store};
use refino_core::{
    LayerNode, NodeType, QueryGroup, RefinoNode, TraversalOptions, assign_layers,
    effective_exploring, get_ancestors, get_dependents, get_grounds, query_groups, require_node,
};

pub fn cmd_list(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    type_filter: Option<NodeType>,
    unreferenced: bool,
) -> i32 {
    if unreferenced && type_filter == Some(NodeType::Decision) {
        io.err("error: --unreferenced only applies to premises\n");
        return 1;
    }
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        let mut nodes: Vec<RefinoNode> = sort_nodes(graph);
        if let Some(filter) = type_filter {
            nodes.retain(|n| n.node_type() == filter);
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
        }
        Ok(0)
    });
    finish(io, outcome)
}

pub fn cmd_show(io: &mut dyn CliSink, opts: &GlobalOptions, ids: &[String]) -> i32 {
    let ids = ids.to_vec();
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        // select only runs for ids that exist, so require_node cannot fail.
        let groups = query_groups(graph, &ids, |g, id| {
            vec![require_node(g, id).expect("id checked").node.clone()]
        });
        let missing = groups.iter().any(|g| matches!(g, QueryGroup::Error { .. }));
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
