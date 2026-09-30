mod common;

use common::{decision, graph_of, premise, premise_with_confirmed};
use refino_core::{DecisionNode, IssueCode, check_grounds_change, validate_graph};

/// The graph-attached decision the grounds change targets.
fn target(graph: &refino_core::Graph, id: &str) -> DecisionNode {
    graph.nodes[id]
        .as_decision()
        .cloned()
        .unwrap_or_else(|| panic!("no decision \"{id}\""))
}

fn codes(issues: &[refino_core::RefinoIssue]) -> Vec<&'static str> {
    issues
        .iter()
        .map(|i| match i.code.as_str() {
            IssueCode::UNKNOWN_GROUND => IssueCode::UNKNOWN_GROUND,
            IssueCode::CYCLE => IssueCode::CYCLE,
            IssueCode::INVALID_GROUNDS => IssueCode::INVALID_GROUNDS,
            _ => "OTHER",
        })
        .collect()
}

#[test]
fn accepts_a_diamond_shaped_acyclic_graph() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
        decision("C3D4E5F6", &["A1B2C3D4"]),
        decision("D4E5F6G7", &["B2C3D4E5", "C3D4E5F6"]),
    ]);
    assert!(validate_graph(&graph).is_empty());
}

#[test]
fn reports_grounds_on_unknown_nodes() {
    let graph = graph_of(vec![decision("A1B2C3D4", &["Z9Y8X7W6"])]);
    let issues = validate_graph(&graph);
    assert_eq!(codes(&issues), vec![IssueCode::UNKNOWN_GROUND]);
    assert_eq!(issues[0].node_id.as_deref(), Some("A1B2C3D4"));
    assert_eq!(issues[0].ground_id.as_deref(), Some("Z9Y8X7W6"));
}

#[test]
fn reports_a_two_node_cycle_exactly_once_with_closed_path() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &["B2C3D4E5"]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
    ]);
    let issues = validate_graph(&graph);
    assert_eq!(codes(&issues), vec![IssueCode::CYCLE]);
    assert_eq!(
        issues[0].cycle,
        Some(vec![
            "A1B2C3D4".to_string(),
            "B2C3D4E5".to_string(),
            "A1B2C3D4".to_string()
        ])
    );
}

#[test]
fn reports_a_self_loop_as_a_cycle() {
    let graph = graph_of(vec![decision("A1B2C3D4", &["A1B2C3D4"])]);
    assert_eq!(codes(&validate_graph(&graph)), vec![IssueCode::CYCLE]);
}

#[test]
fn reports_a_three_node_cycle_once_regardless_of_entry_point() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &["B2C3D4E5"]),
        decision("B2C3D4E5", &["C3D4E5F6"]),
        decision("C3D4E5F6", &["A1B2C3D4"]),
        decision("D4E5F6G7", &["A1B2C3D4"]),
    ]);
    let issues = validate_graph(&graph);
    assert_eq!(
        issues.iter().filter(|i| i.code == IssueCode::CYCLE).count(),
        1
    );
    assert_eq!(
        issues[0].cycle,
        Some(vec![
            "A1B2C3D4".to_string(),
            "B2C3D4E5".to_string(),
            "C3D4E5F6".to_string(),
            "A1B2C3D4".to_string()
        ])
    );
}

#[test]
fn does_not_mistake_shared_premises_for_cycles() {
    let graph = graph_of(vec![
        premise("1A2B3C4D"),
        decision("A1B2C3D4", &["1A2B3C4D"]),
        decision("B2C3D4E5", &["1A2B3C4D", "A1B2C3D4"]),
    ]);
    assert!(validate_graph(&graph).is_empty());
}

fn s(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|x| x.to_string()).collect()
}

#[test]
fn check_accepts_existing_acyclic_grounds() {
    let graph = graph_of(vec![
        premise("1A2B3C4D"),
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["1A2B3C4D"]),
    ]);
    let issues = check_grounds_change(
        &graph,
        &target(&graph, "A1B2C3D4"),
        &s(&["1A2B3C4D", "B2C3D4E5"]),
    );
    assert!(issues.is_empty(), "unexpected issues: {issues:?}");
}

#[test]
fn check_accepts_clearing_grounds() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &["B2C3D4E5"]),
        decision("B2C3D4E5", &[]),
    ]);
    assert!(check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &[]).is_empty());
}

#[test]
fn check_reports_each_repeated_ground_id_once() {
    let graph = graph_of(vec![decision("A1B2C3D4", &[]), decision("B2C3D4E5", &[])]);
    let issues = check_grounds_change(
        &graph,
        &target(&graph, "A1B2C3D4"),
        &s(&["B2C3D4E5", "B2C3D4E5", "B2C3D4E5"]),
    );
    assert_eq!(codes(&issues), vec![IssueCode::INVALID_GROUNDS]);
    assert!(issues[0].message.contains("\"B2C3D4E5\""));
}

#[test]
fn check_reports_grounds_on_unknown_nodes() {
    let graph = graph_of(vec![decision("A1B2C3D4", &[])]);
    let issues = check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["Z9Y8X7W6"]));
    assert_eq!(codes(&issues), vec![IssueCode::UNKNOWN_GROUND]);
    assert_eq!(issues[0].node_id.as_deref(), Some("A1B2C3D4"));
    assert_eq!(issues[0].ground_id.as_deref(), Some("Z9Y8X7W6"));
}

#[test]
fn check_reports_self_referencing_ground_as_closed_cycle() {
    let graph = graph_of(vec![decision("A1B2C3D4", &[])]);
    let issues = check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["A1B2C3D4"]));
    assert_eq!(codes(&issues), vec![IssueCode::CYCLE]);
    assert_eq!(issues[0].cycle, Some(s(&["A1B2C3D4", "A1B2C3D4"])));
}

#[test]
fn check_reports_cycle_closed_through_direct_ground() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
    ]);
    let issues = check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["B2C3D4E5"]));
    assert_eq!(codes(&issues), vec![IssueCode::CYCLE]);
    assert_eq!(
        issues[0].cycle,
        Some(s(&["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]))
    );
}

#[test]
fn check_reports_cycle_closed_through_transitive_path() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
        decision("C3D4E5F6", &["B2C3D4E5"]),
        decision("D4E5F6G7", &["C3D4E5F6"]),
    ]);
    let issues = check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["D4E5F6G7"]));
    assert_eq!(
        issues[0].cycle,
        Some(s(&[
            "A1B2C3D4", "D4E5F6G7", "C3D4E5F6", "B2C3D4E5", "A1B2C3D4"
        ]))
    );
}

#[test]
fn check_follows_declared_grounds_order_when_picking_the_path() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["C3D4E5F6", "D4E5F6G7"]),
        decision("C3D4E5F6", &["A1B2C3D4"]),
        decision("D4E5F6G7", &["A1B2C3D4"]),
    ]);
    let issues = check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["B2C3D4E5"]));
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0].cycle,
        Some(s(&["A1B2C3D4", "B2C3D4E5", "C3D4E5F6", "A1B2C3D4"]))
    );
}

#[test]
fn check_reports_one_cycle_per_closing_ground() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
        decision("C3D4E5F6", &["A1B2C3D4"]),
    ]);
    let issues = check_grounds_change(
        &graph,
        &target(&graph, "A1B2C3D4"),
        &s(&["B2C3D4E5", "C3D4E5F6"]),
    );
    assert_eq!(
        issues
            .iter()
            .map(|i| i.cycle.clone().unwrap())
            .collect::<Vec<_>>(),
        vec![
            s(&["A1B2C3D4", "B2C3D4E5", "A1B2C3D4"]),
            s(&["A1B2C3D4", "C3D4E5F6", "A1B2C3D4"]),
        ]
    );
}

#[test]
fn check_does_not_report_pre_existing_cycles_elsewhere() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &[]),
        decision("C3D4E5F6", &["D4E5F6G7"]),
        decision("D4E5F6G7", &["C3D4E5F6"]),
    ]);
    assert!(
        check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["B2C3D4E5"])).is_empty()
    );
}

#[test]
fn check_leaves_the_graph_untouched() {
    let graph = graph_of(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
    ]);
    check_grounds_change(&graph, &target(&graph, "A1B2C3D4"), &s(&["B2C3D4E5"]));
    // The decision keeps its (empty) grounds list: the check never mutates.
    assert_eq!(
        graph.nodes["A1B2C3D4"].as_decision().unwrap().grounds,
        Vec::<String>::new()
    );
    assert_eq!(
        graph.nodes["B2C3D4E5"].as_decision().unwrap().grounds,
        vec!["A1B2C3D4".to_string()]
    );
}

#[test]
fn premise_confirmed_is_accepted_by_factories() {
    // The validate.test.ts factory supports confirmed; keep the helper used.
    let graph = graph_of(vec![premise_with_confirmed("1A2B3C4D", 1)]);
    assert_eq!(
        graph.nodes["1A2B3C4D"].as_premise().unwrap().confirmed,
        Some(1)
    );
}
