mod common;

use common::{decision, exploring_decision, graph_of, premise};
use refino_core::{
    IssueCode, TraversalOptions, build_graph, effective_exploring, get_ancestors, get_dependents,
    get_grounds, query_groups,
};

/// Fixture shape:
///   1A2B3C4D ──┐
///   A1B2C3D4 ──┴→ D4E5F6G7 → E5F6G7H8
fn fixture() -> refino_core::Graph {
    graph_of(vec![
        premise("1A2B3C4D"),
        decision("A1B2C3D4", &[]),
        decision("D4E5F6G7", &["A1B2C3D4"]),
        decision("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"]),
    ])
}

fn ids_with_depth(results: &[refino_core::NodeWithDepth]) -> Vec<(String, usize)> {
    results
        .iter()
        .map(|a| (a.node.id().to_string(), a.depth))
        .collect()
}

#[test]
fn grounds_are_resolved_in_declared_order() {
    let graph = fixture();
    let grounds = get_grounds(&graph, "E5F6G7H8").unwrap();
    let ids: Vec<String> = grounds.iter().map(|n| n.id().to_string()).collect();
    assert_eq!(ids, vec!["1A2B3C4D".to_string(), "D4E5F6G7".to_string()]);
    assert_eq!(
        get_grounds(&graph, "A1B2C3D4").unwrap(),
        Vec::<refino_core::GraphNode>::new()
    );
    assert_eq!(
        get_grounds(&graph, "1A2B3C4D").unwrap(),
        Vec::<refino_core::GraphNode>::new()
    );
}

#[test]
fn ancestors_cover_premises_and_upstream_decisions_with_minimal_depth() {
    let graph = fixture();
    let ancestors = get_ancestors(&graph, "E5F6G7H8", TraversalOptions::default()).unwrap();
    assert_eq!(
        ids_with_depth(&ancestors),
        vec![
            ("1A2B3C4D".to_string(), 1),
            ("D4E5F6G7".to_string(), 1),
            ("A1B2C3D4".to_string(), 2),
        ]
    );
}

#[test]
fn ancestors_of_a_premise_are_empty() {
    let graph = fixture();
    assert!(
        get_ancestors(&graph, "1A2B3C4D", TraversalOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn max_depth_bounds_the_traversal_without_changing_order() {
    let graph = fixture();
    let bounded =
        get_ancestors(&graph, "E5F6G7H8", TraversalOptions { max_depth: Some(1) }).unwrap();
    assert_eq!(
        bounded.iter().map(|a| a.node.id()).collect::<Vec<_>>(),
        vec!["1A2B3C4D", "D4E5F6G7"]
    );
    let bounded =
        get_dependents(&graph, "A1B2C3D4", TraversalOptions { max_depth: Some(1) }).unwrap();
    assert_eq!(
        bounded.iter().map(|a| a.node.id()).collect::<Vec<_>>(),
        vec!["D4E5F6G7"]
    );
    // Depth 0 includes nothing: the queried node itself is always excluded.
    assert!(
        get_ancestors(&graph, "E5F6G7H8", TraversalOptions { max_depth: Some(0) })
            .unwrap()
            .is_empty()
    );
    assert!(
        get_dependents(&graph, "A1B2C3D4", TraversalOptions { max_depth: Some(0) })
            .unwrap()
            .is_empty()
    );
    // The full closure still equals the unbounded default.
    assert_eq!(
        get_ancestors(
            &graph,
            "E5F6G7H8",
            TraversalOptions {
                max_depth: Some(99)
            }
        )
        .unwrap(),
        get_ancestors(&graph, "E5F6G7H8", TraversalOptions::default()).unwrap()
    );
    assert_eq!(
        get_dependents(
            &graph,
            "A1B2C3D4",
            TraversalOptions {
                max_depth: Some(99)
            }
        )
        .unwrap(),
        get_dependents(&graph, "A1B2C3D4", TraversalOptions::default()).unwrap()
    );
}

#[test]
fn dependents_are_the_transitive_closure_of_downstream_decisions() {
    let graph = fixture();
    let dependents = get_dependents(&graph, "A1B2C3D4", TraversalOptions::default()).unwrap();
    assert_eq!(
        ids_with_depth(&dependents),
        vec![("D4E5F6G7".to_string(), 1), ("E5F6G7H8".to_string(), 2)]
    );
    let dependents = get_dependents(&graph, "1A2B3C4D", TraversalOptions::default()).unwrap();
    assert_eq!(
        dependents.iter().map(|d| d.node.id()).collect::<Vec<_>>(),
        vec!["E5F6G7H8"]
    );
    assert!(
        get_dependents(&graph, "E5F6G7H8", TraversalOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn build_graph_derives_children_of_premises_and_decisions() {
    let graph = fixture();
    let children = |id: &str| -> Vec<String> { graph.nodes[id].children.clone() };
    assert_eq!(children("1A2B3C4D"), vec!["E5F6G7H8".to_string()]);
    assert_eq!(children("A1B2C3D4"), vec!["D4E5F6G7".to_string()]);
    assert_eq!(children("D4E5F6G7"), vec!["E5F6G7H8".to_string()]);
    assert_eq!(children("E5F6G7H8"), Vec::<String>::new());
}

#[test]
fn queries_on_unknown_nodes_error_node_not_found() {
    let graph = fixture();
    let results = (
        get_grounds(&graph, "9M8N7P6Q").err(),
        get_ancestors(&graph, "9M8N7P6Q", TraversalOptions::default()).err(),
        get_dependents(&graph, "9M8N7P6Q", TraversalOptions::default()).err(),
        effective_exploring(&graph, "9M8N7P6Q").err(),
    );
    let (a, b, c, d) = results;
    for error in [a, b, c, d] {
        let error = error.expect("expected an error");
        assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
    }
}

/// Fixture shape:
///   1A2B3C4D ──┐
///   A1B2C3D4* ─┴→ D4E5F6G7 → E5F6G7H8
///
/// Only A1B2C3D4 carries the stored trial mark (the `*`); everything
/// downstream of it derives the effective status, everything else stays
/// settled.
fn exploring_fixture() -> refino_core::Graph {
    graph_of(vec![
        premise("1A2B3C4D"),
        exploring_decision("A1B2C3D4", &[]),
        decision("D4E5F6G7", &["A1B2C3D4"]),
        decision("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"]),
    ])
}

#[test]
fn effective_exploring_is_true_for_the_marked_node_itself() {
    let graph = exploring_fixture();
    assert!(effective_exploring(&graph, "A1B2C3D4").unwrap());
}

#[test]
fn effective_exploring_propagates_to_transitive_downstream() {
    let graph = exploring_fixture();
    assert!(effective_exploring(&graph, "D4E5F6G7").unwrap());
    assert!(effective_exploring(&graph, "E5F6G7H8").unwrap());
}

#[test]
fn effective_exploring_settles_once_the_upstream_mark_is_removed() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("D4E5F6G7", &["A1B2C3D4"]),
    ]);
    assert!(!effective_exploring(&graph, "D4E5F6G7").unwrap());
    assert!(!effective_exploring(&graph, "A1B2C3D4").unwrap());
}

#[test]
fn effective_exploring_is_false_for_premises_and_unmarked_branches() {
    let graph = exploring_fixture();
    assert!(!effective_exploring(&graph, "1A2B3C4D").unwrap());
    let other = graph_of(vec![
        decision("B2C3D4E5", &[]),
        decision("C3D4E5F6", &["B2C3D4E5"]),
    ]);
    assert!(!effective_exploring(&other, "C3D4E5F6").unwrap());
}

#[test]
fn effective_exploring_follows_any_of_multiple_grounds() {
    let graph = graph_of(vec![
        premise("1A2B3C4D"),
        decision("A1B2C3D4", &[]),
        exploring_decision("B2C3D4E5", &[]),
        decision("E5F6G7H8", &["1A2B3C4D", "B2C3D4E5"]),
    ]);
    assert!(effective_exploring(&graph, "E5F6G7H8").unwrap());
}

#[test]
fn query_groups_group_results_under_each_queried_id() {
    let graph = fixture();
    let groups = query_groups(&graph, &["D4E5F6G7".to_string()], |g, id| {
        get_grounds(g, id).unwrap()
    });
    let [refino_core::QueryGroup::Results { results, .. }] = &groups[..] else {
        panic!("expected a result group");
    };
    let ids: Vec<&str> = results.iter().map(|n| n.id()).collect();
    assert_eq!(ids, vec!["A1B2C3D4"]);
}

#[test]
fn query_groups_yield_per_id_error_without_aborting_the_rest() {
    let graph = fixture();
    let groups = query_groups(
        &graph,
        &["9M8N7P6Q".to_string(), "D4E5F6G7".to_string()],
        |g, id| get_ancestors(g, id, TraversalOptions::default()).unwrap(),
    );
    assert_eq!(groups.len(), 2);
    assert_eq!(
        groups[0],
        refino_core::QueryGroup::Error {
            id: "9M8N7P6Q".to_string(),
            error: "Node \"9M8N7P6Q\" not found".to_string(),
        }
    );
    let [_, refino_core::QueryGroup::Results { id, results }] = &groups[..] else {
        panic!("expected a result group");
    };
    assert_eq!(id, "D4E5F6G7");
    let ids: Vec<&str> = results.iter().map(|a| a.node.id()).collect();
    assert_eq!(ids, vec!["A1B2C3D4"]);
}

#[test]
fn query_groups_do_not_call_select_for_missing_ids() {
    use std::cell::Cell;
    let graph = fixture();
    let calls = Cell::new(0);
    query_groups(
        &graph,
        &["9M8N7P6Q".to_string(), "A1B2C3D4".to_string()],
        |_g, _id| {
            calls.set(calls.get() + 1);
            Vec::<refino_core::GraphNode>::new()
        },
    );
    assert_eq!(calls.get(), 1);
}

#[test]
fn query_groups_return_empty_list_for_empty_batch() {
    let graph = fixture();
    let groups = query_groups(&graph, &[], |_g, _id| Vec::<refino_core::GraphNode>::new());
    assert!(groups.is_empty());
}

#[test]
fn build_graph_leaves_unknown_grounds_out_of_children_index() {
    let dangling = build_graph(vec![decision("A1B2C3D4", &["Z9Y8X7W6"])]);
    assert!(!dangling.nodes.contains_key("Z9Y8X7W6"));
    assert_eq!(dangling.nodes["A1B2C3D4"].children, Vec::<String>::new());
}
