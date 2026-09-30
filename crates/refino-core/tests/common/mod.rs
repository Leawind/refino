//! Shared test helpers: node factories bypassing storage parsing.
//!
//! Included per test binary, so unused helpers here are expected.
#![allow(dead_code)]

use refino_core::{DecisionNode, Graph, PremiseNode, RefinoNode, build_graph};

pub fn premise(id: &str) -> RefinoNode {
    RefinoNode::Premise(PremiseNode {
        id: id.to_string(),
        summary: "Body.".to_string(),
        confirmed: None,
    })
}

pub fn premise_with_confirmed(id: &str, confirmed: i64) -> RefinoNode {
    RefinoNode::Premise(PremiseNode {
        id: id.to_string(),
        summary: "Body.".to_string(),
        confirmed: Some(confirmed),
    })
}

pub fn decision(id: &str, grounds: &[&str]) -> RefinoNode {
    RefinoNode::Decision(DecisionNode {
        id: id.to_string(),
        summary: "Body.".to_string(),
        grounds: grounds.iter().map(|g| g.to_string()).collect(),
        exploring: None,
    })
}

pub fn exploring_decision(id: &str, grounds: &[&str]) -> RefinoNode {
    RefinoNode::Decision(DecisionNode {
        id: id.to_string(),
        summary: "Body.".to_string(),
        grounds: grounds.iter().map(|g| g.to_string()).collect(),
        exploring: Some(true),
    })
}

pub fn graph_of(nodes: Vec<RefinoNode>) -> Graph {
    build_graph(nodes)
}
