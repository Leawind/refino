//! Write commands: new, update and delete. Writes never require a clean
//! graph — pre-existing issues elsewhere must not block them; the store's
//! write methods validate each change itself and reject it before anything
//! touches the disk.

use crate::format::CliSink;
use crate::shared::{GlobalOptions, finish_write, type_name, with_store_for_write};
use refino_core::{NodeType, RefinoNode, is_valid_id};
use refino_storage::{
    CreateDecisionOptions, CreateOptions, CreatePremiseOptions, UpdateDecisionOptions,
    UpdateOptions, UpdatePremiseOptions, confirmed_to_ms, is_valid_confirmed, node_relative_file,
};

pub fn cmd_new(io: &mut dyn CliSink, opts: &GlobalOptions, kind: NewKindArgs) -> i32 {
    match kind {
        NewKindArgs::Premise {
            id,
            body,
            summary,
            confirmed,
            now,
        } => {
            if now && confirmed.is_some() {
                io.err("error: --now and --confirmed are mutually exclusive\n");
                return 1;
            }
            if let Some(text) = &confirmed
                && !is_valid_confirmed(text)
            {
                io.err(&format!(
                        "error: \"confirmed\" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got \"{text}\"\n"
                    ));
                return 1;
            }
            let outcome = with_store_for_write(opts, |store| {
                let outcome = store.create_premise(&CreatePremiseOptions {
                    base: CreateOptions {
                        body: body.unwrap_or_default(),
                        id,
                        summary,
                    },
                    confirmed: confirmed.map_or(if now { Some(now_ms()) } else { None }, |c| {
                        confirmed_to_ms(&c)
                    }),
                })?;
                emit_written(io, &outcome.id, "premise", "created", None);
                Ok(0)
            });
            finish_write(io, outcome)
        }
        NewKindArgs::Decision {
            id,
            body,
            grounds,
            rationale,
            summary,
            exploring,
        } => {
            let ground_ids = parse_ground_ids(grounds.as_deref());
            if let Some(bad) = ground_ids.iter().find(|g| !is_valid_id(g)) {
                io.err(&format!(
                    "error: invalid ground id \"{bad}\" (must be 3-16 characters of A-Z, 0-9 or _)\n"
                ));
                return 1;
            }
            let outcome = with_store_for_write(opts, |store| {
                // Grounds validation runs inside the store's write method;
                // pre-existing parse issues elsewhere do not block creation.
                let outcome = store.create_decision(&CreateDecisionOptions {
                    base: CreateOptions {
                        body: body.unwrap_or_default(),
                        id,
                        summary,
                    },
                    grounds: if ground_ids.is_empty() {
                        None
                    } else {
                        Some(ground_ids)
                    },
                    rationale,
                    exploring,
                })?;
                emit_written(io, &outcome.id, "decision", "created", None);
                Ok(0)
            });
            finish_write(io, outcome)
        }
    }
}

/// Per-type argument bundle for `new`, decoupled from the clap enum.
pub enum NewKindArgs {
    Premise {
        id: Option<String>,
        body: Option<String>,
        summary: Option<String>,
        confirmed: Option<String>,
        now: bool,
    },
    Decision {
        id: Option<String>,
        body: Option<String>,
        grounds: Option<String>,
        rationale: Option<String>,
        summary: Option<String>,
        exploring: bool,
    },
}

#[allow(clippy::too_many_arguments)]
pub fn cmd_update(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    id: &str,
    body: Option<String>,
    summary: Option<String>,
    rationale: Option<String>,
    grounds: Option<String>,
    confirmed: Option<String>,
    now: bool,
    exploring: bool,
    no_exploring: bool,
) -> i32 {
    let exploring_set: Option<bool> = if exploring {
        Some(true)
    } else if no_exploring {
        Some(false)
    } else {
        None
    };
    let touched = body.is_some()
        || summary.is_some()
        || rationale.is_some()
        || grounds.is_some()
        || confirmed.is_some()
        || now
        || exploring_set.is_some();
    if !touched {
        io.err("error: specify at least one field to update\n");
        return 1;
    }
    if summary.as_deref().is_some_and(|s| s.trim().is_empty()) {
        io.err("error: --summary must be a non-empty string\n");
        return 1;
    }
    if let Some(text) = &confirmed
        && !is_valid_confirmed(text)
    {
        io.err(&format!(
                "error: \"confirmed\" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got \"{text}\"\n"
            ));
        return 1;
    }
    let id = id.to_string();
    let outcome = with_store_for_write(opts, |store| {
        let Some(entry) = store.entry(&id).cloned() else {
            return Err(refino_storage::StoreError::Other(
                refino_core::RefinoError::new("NODE_NOT_FOUND", format!("node \"{id}\" not found")),
            ));
        };
        let node = entry.node.node.clone();
        let content = store.content(&id)?.unwrap_or_default();

        // Partial update: unspecified fields keep their current value. A
        // summary that was derived from the body stays derived (not passed),
        // so updating the body keeps the fallback in sync. Options that do
        // not apply to the node's type are misplaced attributes and silently
        // ignored (docs/design.md, "存储格式容错").
        let summary = summary.or_else(|| {
            if entry.summary_explicit {
                Some(node.summary().to_string())
            } else {
                None
            }
        });
        let outcome = match &node {
            RefinoNode::Premise(premise) => {
                if now && confirmed.is_some() {
                    io.err("error: --now and --confirmed are mutually exclusive\n");
                    return Ok(1);
                }
                store.update_premise(
                    &id,
                    &UpdatePremiseOptions {
                        base: UpdateOptions {
                            body: body.clone().unwrap_or_else(|| content.body.clone()),
                            summary,
                        },
                        confirmed: confirmed.as_ref().map_or(
                            if now {
                                Some(now_ms())
                            } else {
                                premise.confirmed
                            },
                            |c| confirmed_to_ms(c),
                        ),
                    },
                )?
            }
            RefinoNode::Decision(decision) => {
                let ground_ids = grounds.as_ref().map(|g| parse_ground_ids(Some(g)));
                if let Some(list) = &ground_ids
                    && let Some(bad) = list.iter().find(|g| !is_valid_id(g))
                {
                    io.err(&format!(
                            "error: invalid ground id \"{bad}\" (must be 3-16 characters of A-Z, 0-9 or _)\n"
                        ));
                    return Ok(1);
                }
                // Grounds validation runs inside the store's write method.
                store.update_decision(
                    &id,
                    &UpdateDecisionOptions {
                        base: UpdateOptions {
                            body: body.clone().unwrap_or_else(|| content.body.clone()),
                            summary,
                        },
                        grounds: Some(ground_ids.unwrap_or_else(|| decision.grounds.clone())),
                        rationale: rationale.clone().or(content.rationale.clone()),
                        exploring: exploring_set.unwrap_or(decision.exploring == Some(true)),
                    },
                )?
            }
        };
        let affected = outcome.change.map(|c| c.affected).unwrap_or_default();
        emit_written(io, &id, type_name(&node), "updated", Some(&affected));
        Ok(0)
    });
    finish_write(io, outcome)
}

pub fn cmd_delete(io: &mut dyn CliSink, opts: &GlobalOptions, ids: &[String], force: bool) -> i32 {
    let ids = ids.to_vec();
    let outcome = with_store_for_write(opts, |store| {
        let mut failure = false;
        let mut lines: Vec<String> = Vec::new();
        for id in &ids {
            let Some(node) = store.graph().nodes.get(id).cloned() else {
                lines.push(format!("error: node \"{id}\" not found"));
                failure = true;
                continue;
            };
            // Direct dependents only: deleting is refused exactly when it
            // would leave dangling grounds behind (mirrors the web API's 409).
            let dependents = node.children.clone();
            if !dependents.is_empty() {
                let detail = format!("grounded on by {}", dependents.join(", "));
                if !force {
                    lines.push(format!("error: {detail} (use --force to delete anyway)"));
                    failure = true;
                    continue;
                }
                io.err(&format!("warning: deleted \"{id}\" is still {detail}\n"));
            }
            match store.delete_node(id) {
                Ok(outcome) => {
                    let affected = outcome.change.map(|c| c.affected).unwrap_or_default();
                    lines.push(format!("deleted {id}"));
                    if !affected.is_empty() {
                        lines.push(format!("下游受影响，建议复核：{}", affected.join(", ")));
                    }
                }
                Err(error) => {
                    lines.push(format!("error: {error}"));
                    failure = true;
                }
            }
        }
        io.out(&format!("{}\n", lines.join("\n")));
        Ok(if failure { 1 } else { 0 })
    });
    finish_write(io, outcome)
}

fn emit_written(
    io: &mut dyn CliSink,
    id: &str,
    node_type: &str,
    verb: &str,
    affected: Option<&[String]>,
) {
    // Display keeps the canonical forward-slash form.
    let resolved_type = if node_type == "premise" {
        NodeType::Premise
    } else {
        NodeType::Decision
    };
    let file = node_relative_file(resolved_type, id);
    io.out(&format!("{verb} {id} (.refino/{file})\n"));
    if let Some(affected) = affected
        && !affected.is_empty()
    {
        io.out(&format!("下游受影响，建议复核：{}\n", affected.join(", ")));
    }
}

fn parse_ground_ids(grounds: Option<&str>) -> Vec<String> {
    grounds
        .unwrap_or("")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
