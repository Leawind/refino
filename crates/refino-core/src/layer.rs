//! Longest-path layering (ui README, "布局：分层").
//!
//! Sources sit at layer 0; every other node takes one past the deepest
//! ground reachable behind it, so a node's layer is the length of the
//! longest grounds chain ending there. Layer 0 is the upstream frontier,
//! higher layers are strictly downstream.
//!
//! Decision→decision cycles cannot be layered strictly, and the graph
//! tolerates them until validated. For the leftovers the assignment breaks
//! back edges deterministically: unlayered grounds are ignored, and each
//! remaining node takes max(layer of layered grounds) + 1, iterating in id
//! order until every node has a layer.

use std::collections::{BTreeMap, HashMap};

/// Minimal read-only node shape the layering needs. An empty `grounds`
/// equals the TypeScript shape's absent field.
#[derive(Debug, Clone)]
pub struct LayerNode {
    pub id: String,
    pub grounds: Vec<String>,
}

/// Assigns each node its longest-path layer over the given node set.
/// Grounds pointing outside the set are ignored.
pub fn assign_layers(nodes: &[LayerNode]) -> BTreeMap<String, usize> {
    let by_id: BTreeMap<String, &LayerNode> = nodes.iter().map(|n| (n.id.clone(), n)).collect();
    let mut grounds_in: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in by_id.keys() {
        let node = by_id[id];
        grounds_in.insert(
            id.clone(),
            node.grounds
                .iter()
                .filter(|g| *g != id && by_id.contains_key(*g))
                .cloned()
                .collect(),
        );
    }

    let mut layers: BTreeMap<String, usize> = BTreeMap::new();
    // Strict phase (Kahn over grounds edges): a node layers only once every
    // in-set ground is layered, and its layer is the longest grounds chain
    // ending there. The layer values are unique for the input set, so the
    // processing order only affects traversal, never the result.
    let mut tentative: HashMap<String, usize> = HashMap::new();
    let mut pending: BTreeMap<String, usize> = BTreeMap::new();
    let mut dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut queue: Vec<String> = Vec::new();
    for (id, grounds) in &grounds_in {
        pending.insert(id.clone(), grounds.len());
        if grounds.is_empty() {
            layers.insert(id.clone(), 0);
            queue.push(id.clone());
        }
        for g in grounds {
            dependents.entry(g.clone()).or_default().push(id.clone());
        }
    }
    queue.sort();
    let mut head = 0;
    while head < queue.len() {
        let ground = queue[head].clone();
        head += 1;
        let ground_layer = layers[&ground];
        for dependent in dependents.get(&ground).into_iter().flatten() {
            let candidate = ground_layer + 1;
            let slot = tentative.entry(dependent.clone()).or_insert(0);
            if candidate > *slot {
                *slot = candidate;
            }
            if let Some(left) = pending.get_mut(dependent) {
                *left -= 1;
                if *left == 0 {
                    layers.insert(dependent.clone(), tentative[dependent]);
                    queue.push(dependent.clone());
                }
            }
        }
    }
    // Cycle-breaking phase: leftover nodes sit on or behind a cycle. Id
    // order keeps the approximation deterministic; ignoring still-unlayered
    // grounds cuts the cycle's back edge wherever it happens to fall.
    let leftover: Vec<String> = by_id
        .keys()
        .filter(|id| !layers.contains_key(*id))
        .cloned()
        .collect();
    let mut remaining = leftover.len();
    while remaining > 0 {
        let mut settled = 0;
        for id in &leftover {
            if layers.contains_key(id) {
                continue;
            }
            let mut layer = 0;
            for g in &grounds_in[id] {
                if let Some(ground) = layers.get(g) {
                    layer = layer.max(ground + 1);
                }
            }
            layers.insert(id.clone(), layer);
            settled += 1;
        }
        if settled == 0 {
            break;
        }
        remaining -= settled;
    }
    layers
}
