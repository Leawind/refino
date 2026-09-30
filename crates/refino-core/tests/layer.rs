use refino_core::{LayerNode, assign_layers};
use std::collections::BTreeMap;

fn node(id: &str, grounds: &[&str]) -> LayerNode {
    LayerNode {
        id: id.to_string(),
        grounds: grounds.iter().map(|g| g.to_string()).collect(),
    }
}

#[test]
fn puts_sources_at_layer_0_and_follows_the_longest_path() {
    let layers = assign_layers(&[
        node("A", &[]),
        node("B", &["A"]),
        node("C", &["A"]),
        node("D", &["B", "C"]),
        node("E", &["D"]),
    ]);
    let get = |id: &str| layers[id];
    assert_eq!(get("A"), 0);
    assert_eq!(get("B"), 1);
    assert_eq!(get("C"), 1);
    assert_eq!(get("D"), 2);
    assert_eq!(get("E"), 3);
}

#[test]
fn takes_the_maximum_over_multiple_grounds_chains() {
    let layers = assign_layers(&[
        node("A", &[]),
        node("B", &["A"]),
        node("C", &["A"]),
        node("D", &["C"]),
        node("E", &["B", "D"]),
    ]);
    assert_eq!(layers["E"], 3);
}

#[test]
fn lays_out_disjoint_components_independently() {
    let layers = assign_layers(&[
        node("A", &[]),
        node("B", &["A"]),
        node("C", &[]),
        node("D", &["C"]),
    ]);
    assert_eq!(layers["B"], 1);
    assert_eq!(layers["C"], 0);
    assert_eq!(layers["D"], 1);
}

#[test]
fn ignores_grounds_pointing_outside_the_set() {
    let layers = assign_layers(&[node("A", &["GHOST"]), node("B", &["A", "GHOST"])]);
    assert_eq!(layers["A"], 0);
    assert_eq!(layers["B"], 1);
}

#[test]
fn assigns_a_layer_to_every_node_on_a_cycle() {
    let layers = assign_layers(&[
        node("A", &["C"]),
        node("B", &["A"]),
        node("C", &["B"]),
        node("D", &["A"]),
    ]);
    assert_eq!(layers.len(), 4);
    // Downstream of the cycle still lands past it.
    assert!(layers["D"] > layers["A"]);
}

#[test]
fn is_independent_of_input_order() {
    let forward = vec![
        node("A", &[]),
        node("B", &["A"]),
        node("C", &["B"]),
        node("D", &["B", "C"]),
    ];
    let mut backward = forward.clone();
    backward.reverse();
    let to_pairs = |m: BTreeMap<String, usize>| -> Vec<(String, usize)> { m.into_iter().collect() };
    assert_eq!(
        to_pairs(assign_layers(&backward)),
        to_pairs(assign_layers(&forward))
    );
}

#[test]
fn handles_empty_and_self_referencing_inputs() {
    assert!(assign_layers(&[]).is_empty());
    let layers = assign_layers(&[node("A", &["A"])]);
    assert_eq!(layers["A"], 0);
}
