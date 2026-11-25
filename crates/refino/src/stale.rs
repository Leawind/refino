//! `refino stale` — maintenance view of the nodes that are due for review.
//! Decisions age from `reviewed`, premises from `confirmed`; nodes without
//! the corresponding timestamp are listed as never reviewed.

use crate::format::{CliSink, StaleTableRow, render_stale_table};
use crate::shared::{GlobalOptions, finish, type_name_of, with_store};
use refino_core::{NodeType, StaleNode, stale_nodes};

#[derive(serde::Serialize)]
struct JsonStaleReport {
    /// The age threshold the report was built with, echoed for consumers.
    days: u32,
    overdue: Vec<JsonStaleRow>,
    never_reviewed: Vec<JsonStaleRow>,
}

#[derive(serde::Serialize)]
struct JsonStaleRow {
    id: String,
    #[serde(rename = "type")]
    node_type: NodeType,
    /// Completed days since the last review/confirmation; absent for nodes
    /// that have no such timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    age_days: Option<i64>,
    summary: String,
}

pub fn cmd_stale(io: &mut dyn CliSink, opts: &GlobalOptions, days: u32, json: bool) -> i32 {
    let outcome = with_store(opts, |store| {
        let report = stale_nodes(store.graph(), store.now_ms(), i64::from(days));
        if json {
            let payload = JsonStaleReport {
                days,
                overdue: to_json_rows(&report.overdue),
                never_reviewed: to_json_rows(&report.never_reviewed),
            };
            io.out(&format!(
                "{}\n",
                serde_json::to_string(&payload).unwrap_or_default()
            ));
            return Ok(0);
        }
        io.out(&format!("超期（超过 {days} 天）：\n"));
        emit_group(io, &report.overdue, false);
        io.out("从未复核：\n");
        emit_group(io, &report.never_reviewed, true);
        Ok(0)
    });
    finish(io, outcome)
}

fn emit_group(io: &mut dyn CliSink, nodes: &[StaleNode], never_reviewed: bool) {
    if nodes.is_empty() {
        io.out("（无）\n");
        return;
    }
    let rows: Vec<StaleTableRow> = nodes
        .iter()
        .map(|node| StaleTableRow {
            id: node.id.clone(),
            node_type: type_name_of(node.node_type).to_string(),
            age: if never_reviewed {
                "从未".to_string()
            } else {
                node.age_days.map(|d| d.to_string()).unwrap_or_default()
            },
            summary: node.summary.clone(),
        })
        .collect();
    io.out(&format!("{}\n", render_stale_table(&rows)));
}

fn to_json_rows(nodes: &[StaleNode]) -> Vec<JsonStaleRow> {
    nodes
        .iter()
        .map(|node| JsonStaleRow {
            id: node.id.clone(),
            node_type: node.node_type,
            age_days: node.age_days,
            summary: node.summary.clone(),
        })
        .collect()
}
