mod common;

use common::{decision, premise};
use refino_core::{
    IssueCode, RefinoError, RefinoNode, add_node, build_graph, is_valid_id, remove_node,
    set_grounds, update_node,
};

#[test]
fn build_graph_derives_sorted_deduplicated_children() {
    let graph = build_graph(vec![
        premise("1A2B3C4D"),
        decision("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"]),
        decision("D4E5F6G7", &["1A2B3C4D"]),
    ]);
    let children = |id: &str| -> Vec<String> { graph.nodes[id].children.clone() };
    assert_eq!(
        children("1A2B3C4D"),
        vec!["D4E5F6G7".to_string(), "E5F6G7H8".to_string()]
    );
    assert_eq!(children("E5F6G7H8"), Vec::<String>::new());
}

#[test]
fn build_graph_keeps_grounds_in_declared_order() {
    let graph = build_graph(vec![
        decision("D4E5F6G7", &[]),
        decision("A1B2C3D4", &["D4E5F6G7"]),
    ]);
    let grounds = graph.nodes["A1B2C3D4"]
        .as_decision()
        .unwrap()
        .grounds
        .clone();
    assert_eq!(grounds, vec!["D4E5F6G7".to_string()]);
}

#[test]
fn add_node_attaches_and_updates_parents_children() {
    let mut graph = build_graph(vec![decision("A1B2C3D4", &[])]);
    add_node(&mut graph, decision("B2C3D4E5", &["A1B2C3D4"])).unwrap();
    assert_eq!(
        graph.nodes["B2C3D4E5"].as_decision().unwrap().grounds,
        vec!["A1B2C3D4".to_string()]
    );
    assert_eq!(
        graph.nodes["A1B2C3D4"].children,
        vec!["B2C3D4E5".to_string()]
    );
}

#[test]
fn add_node_errors_duplicate_id() {
    let mut graph = build_graph(vec![decision("A1B2C3D4", &[])]);
    let error = add_node(&mut graph, premise("A1B2C3D4")).unwrap_err();
    assert_eq!(error.code, IssueCode::DUPLICATE_ID);
}

#[test]
fn remove_node_detaches_and_cleans_parents_children() {
    let mut graph = build_graph(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
    ]);
    let removed = remove_node(&mut graph, "B2C3D4E5").unwrap();
    assert_eq!(removed.id(), "B2C3D4E5");
    assert!(!graph.nodes.contains_key("B2C3D4E5"));
    assert_eq!(graph.nodes["A1B2C3D4"].children, Vec::<String>::new());
}

#[test]
fn remove_node_errors_unknown_id() {
    let mut graph = build_graph(vec![decision("A1B2C3D4", &[])]);
    let error = remove_node(&mut graph, "Z9Y8X7W6").unwrap_err();
    assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
}

#[test]
fn set_grounds_replaces_and_migrates_children() {
    let mut graph = build_graph(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &[]),
        decision("C3D4E5F6", &["A1B2C3D4"]),
    ]);
    set_grounds(&mut graph, "C3D4E5F6", vec!["B2C3D4E5".to_string()]).unwrap();
    assert_eq!(
        graph.nodes["C3D4E5F6"].as_decision().unwrap().grounds,
        vec!["B2C3D4E5".to_string()]
    );
    assert_eq!(graph.nodes["A1B2C3D4"].children, Vec::<String>::new());
    assert_eq!(
        graph.nodes["B2C3D4E5"].children,
        vec!["C3D4E5F6".to_string()]
    );
}

#[test]
fn set_grounds_errors_on_premise_or_unknown_target() {
    let mut graph = build_graph(vec![premise("1A2B3C4D")]);
    let error = set_grounds(&mut graph, "1A2B3C4D", vec![]).unwrap_err();
    assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
    let error = set_grounds(&mut graph, "Z9Y8X7W6", vec![]).unwrap_err();
    assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
}

#[test]
fn update_node_replaces_premise_fields_including_clearing_confirmed() {
    let mut graph = build_graph(vec![premise("1A2B3C4D")]);
    update_node(
        &mut graph,
        RefinoNode::Premise(refino_core::PremiseNode {
            id: "1A2B3C4D".to_string(),
            summary: "New.".to_string(),
            confirmed: Some(1_757_000_000_000),
        }),
    )
    .unwrap();
    assert_eq!(graph.nodes["1A2B3C4D"].summary(), "New.");
    assert_eq!(
        graph.nodes["1A2B3C4D"].as_premise().unwrap().confirmed,
        Some(1_757_000_000_000)
    );
    update_node(
        &mut graph,
        RefinoNode::Premise(refino_core::PremiseNode {
            id: "1A2B3C4D".to_string(),
            summary: "Newer.".to_string(),
            confirmed: None,
        }),
    )
    .unwrap();
    assert_eq!(
        graph.nodes["1A2B3C4D"].as_premise().unwrap().confirmed,
        None
    );
}

#[test]
fn update_node_replaces_decision_grounds_and_keeps_children_consistent() {
    let mut graph = build_graph(vec![
        decision("A1B2C3D4", &[]),
        decision("B2C3D4E5", &["A1B2C3D4"]),
    ]);
    update_node(&mut graph, decision("B2C3D4E5", &[])).unwrap();
    assert_eq!(
        graph.nodes["B2C3D4E5"].as_decision().unwrap().grounds,
        Vec::<String>::new()
    );
    assert_eq!(graph.nodes["A1B2C3D4"].children, Vec::<String>::new());
}

#[test]
fn update_node_sets_and_clears_exploring_mark() {
    let mut graph = build_graph(vec![decision("A1B2C3D4", &[])]);
    let marked = decision("A1B2C3D4", &[]);
    let RefinoNode::Decision(mut d) = marked else {
        unreachable!()
    };
    d.exploring = Some(true);
    update_node(&mut graph, RefinoNode::Decision(d)).unwrap();
    assert_eq!(
        graph.nodes["A1B2C3D4"].as_decision().unwrap().exploring,
        Some(true)
    );
    update_node(&mut graph, decision("A1B2C3D4", &[])).unwrap();
    assert_eq!(
        graph.nodes["A1B2C3D4"].as_decision().unwrap().exploring,
        None
    );
}

#[test]
fn update_node_errors_when_id_does_not_resolve() {
    let mut graph = build_graph(vec![decision("A1B2C3D4", &[])]);
    assert!(update_node(&mut graph, premise("Z9Y8X7W6")).is_err());
}

#[test]
fn build_graph_leaves_unknown_grounds_out_of_children_index() {
    let graph = build_graph(vec![decision("A1B2C3D4", &["Z9Y8X7W6"])]);
    assert!(!graph.nodes.contains_key("Z9Y8X7W6"));
    assert_eq!(graph.nodes["A1B2C3D4"].children, Vec::<String>::new());
}

#[test]
fn last_node_wins_on_duplicate_ids() {
    let graph = build_graph(vec![
        premise("A1B2C3D4"),
        RefinoNode::Decision(refino_core::DecisionNode {
            id: "A1B2C3D4".to_string(),
            summary: "Decision.".to_string(),
            grounds: vec![],
            exploring: None,
        }),
    ]);
    assert!(graph.nodes["A1B2C3D4"].as_decision().is_some());
}

#[test]
fn is_valid_id_rule_shape() {
    // Sanity anchor for the storage layer's reliance on is_valid_id.
    assert!(is_valid_id("ABC"));
    assert!(!is_valid_id("A-B-CD"));
}

#[test]
fn refino_error_displays_message() {
    let error = RefinoError::new(IssueCode::NODE_NOT_FOUND, "boom");
    assert_eq!(error.to_string(), "boom");
}
