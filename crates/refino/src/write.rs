//! Write commands: new, update, edit and delete. Writes never require a
//! clean graph — pre-existing issues elsewhere must not block them; the
//! store's write methods validate each change itself and reject it before
//! anything touches the disk.

use crate::format::CliSink;
use crate::shared::{GlobalOptions, finish_write, type_name, with_store_for_write};
use refino_core::{NodeType, RefinoNode, is_valid_id};
use refino_storage::{
    CreateDecisionOptions, CreateOptions, CreatePremiseOptions, StoreError, UpdateDecisionOptions,
    UpdateOptions, UpdatePremiseOptions, confirmed_to_ms, is_valid_confirmed, node_relative_file,
};

/// Per-type argument bundle for `new`, decoupled from the clap enum.
pub enum NewKindArgs {
    Premise {
        id: Option<String>,
        body: Option<String>,
        body_file: Option<String>,
        summary: Option<String>,
        confirmed: Option<String>,
        now: bool,
    },
    Decision {
        id: Option<String>,
        body: Option<String>,
        body_file: Option<String>,
        grounds: Option<String>,
        rationale: Option<String>,
        rationale_file: Option<String>,
        summary: Option<String>,
        exploring: bool,
    },
}

/// Field bundle for `update`, decoupled from the clap enum.
pub struct UpdateArgs {
    pub id: String,
    pub body: Option<String>,
    pub body_file: Option<String>,
    pub summary: Option<String>,
    pub rationale: Option<String>,
    pub rationale_file: Option<String>,
    pub grounds: Option<String>,
    pub confirmed: Option<String>,
    pub now: bool,
    pub exploring: bool,
    pub no_exploring: bool,
}

/// Resolve a content option pair (`--x` text or `--x-file` path) to its
/// text; a path of `-` reads stdin. Long bodies and rationales go through
/// files or pipes: argv passing hits shell escaping and the ~32k Windows
/// command-line limit on exactly the content agents write.
fn resolve_content(
    io: &mut dyn CliSink,
    name: &str,
    arg: &Option<String>,
    file: &Option<String>,
) -> Result<Option<String>, i32> {
    match (arg, file) {
        (Some(_), Some(_)) => {
            io.err(&format!(
                "error: --{name} and --{name}-file are mutually exclusive\n"
            ));
            Err(1)
        }
        (None, None) => Ok(None),
        (Some(text), None) => Ok(Some(text.clone())),
        (None, Some(path)) => {
            let read = if path == "-" {
                io.input()
                    .map_err(|e| format!("error: cannot read stdin: {e}\n"))
            } else {
                std::fs::read_to_string(path)
                    .map_err(|e| format!("error: cannot read --{name}-file \"{path}\": {e}\n"))
            };
            match read {
                Ok(text) => Ok(Some(text)),
                Err(message) => {
                    io.err(&message);
                    Err(1)
                }
            }
        }
    }
}

pub fn cmd_new(io: &mut dyn CliSink, opts: &GlobalOptions, kind: NewKindArgs) -> i32 {
    match kind {
        NewKindArgs::Premise {
            id,
            body,
            body_file,
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
            let body = match resolve_content(io, "body", &body, &body_file) {
                Ok(resolved) => resolved,
                Err(code) => return code,
            };
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
            body_file,
            grounds,
            rationale,
            rationale_file,
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
            let body = match resolve_content(io, "body", &body, &body_file) {
                Ok(resolved) => resolved,
                Err(code) => return code,
            };
            let rationale = match resolve_content(io, "rationale", &rationale, &rationale_file) {
                Ok(resolved) => resolved,
                Err(code) => return code,
            };
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

pub fn cmd_update(io: &mut dyn CliSink, opts: &GlobalOptions, args: UpdateArgs) -> i32 {
    let UpdateArgs {
        id,
        body,
        body_file,
        summary,
        rationale,
        rationale_file,
        grounds,
        confirmed,
        now,
        exploring,
        no_exploring,
    } = args;
    let exploring_set: Option<bool> = if exploring {
        Some(true)
    } else if no_exploring {
        Some(false)
    } else {
        None
    };
    let body = match resolve_content(io, "body", &body, &body_file) {
        Ok(resolved) => resolved,
        Err(code) => return code,
    };
    let rationale = match resolve_content(io, "rationale", &rationale, &rationale_file) {
        Ok(resolved) => resolved,
        Err(code) => return code,
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
    let outcome = with_store_for_write(opts, |store| {
        let Some(entry) = store.entry(&id).cloned() else {
            return Err(StoreError::Other(refino_core::RefinoError::new(
                "NODE_NOT_FOUND",
                format!("node \"{id}\" not found"),
            )));
        };
        let node = entry.node.node.clone();
        let content = store.content(&id)?.unwrap_or_default();

        // Misplaced options are rejected, not ignored: an option for the
        // other node's type is explicit user intent, and silently dropping
        // it (exit 0, "updated") would leave the caller believing it took
        // effect. The storage-format tolerance for unknown fields covers
        // file frontmatter, not typed CLI flags.
        let mut violations: Vec<&str> = Vec::new();
        if matches!(node, RefinoNode::Premise(_)) {
            if rationale.is_some() {
                violations.push("--rationale only applies to decisions");
            }
            if grounds.is_some() {
                violations.push("--grounds only applies to decisions");
            }
            if exploring {
                violations.push("--exploring only applies to decisions");
            }
            if no_exploring {
                violations.push("--no-exploring only applies to decisions");
            }
        } else {
            if confirmed.is_some() {
                violations.push("--confirmed only applies to premises");
            }
            if now {
                violations.push("--now only applies to premises");
            }
        }
        if !violations.is_empty() {
            for violation in violations {
                io.err(&format!("error: {violation}\n"));
            }
            return Ok(1);
        }

        // Partial update: unspecified fields keep their current value. A
        // summary that was derived from the body stays derived (not passed),
        // so updating the body keeps the fallback in sync.
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

/// `edit` — the harness file-editor pattern (the same contract as
/// agent-memory's memory_edit): the caller cites the exact span to change
/// instead of restating the whole body, so a one-word fix on a long body
/// costs tokens for the span only and the untouched parts cannot drift.
/// Matching is byte-exact; ambiguity fails without side effects.
pub fn cmd_edit(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    id: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> i32 {
    if old.is_empty() {
        io.err("error: --old must not be empty (an empty match is ambiguous; to rewrite the whole body use --body or --body-file)\n");
        return 1;
    }
    if old == new {
        io.err("error: --old and --new are identical: nothing to replace\n");
        return 1;
    }
    let id = id.to_string();
    let old = old.to_string();
    let new = new.to_string();
    let outcome = with_store_for_write(opts, |store| {
        let Some(entry) = store.entry(&id).cloned() else {
            return Err(StoreError::Other(refino_core::RefinoError::new(
                "NODE_NOT_FOUND",
                format!("node \"{id}\" not found"),
            )));
        };
        let node = entry.node.node.clone();
        let content = store.content(&id)?.unwrap_or_default();
        let count = content.body.matches(&old).count();
        if count == 0 {
            io.err(&format!(
                "error: --old not found in \"{id}\" (matching is byte-exact: case-sensitive, whitespace-significant); run \"refino show {id}\" to re-read the current body\n"
            ));
            return Ok(1);
        }
        if count > 1 && !replace_all {
            io.err(&format!(
                "error: --old matches {count} times in \"{id}\": add surrounding text to make the match unique, or pass --replace-all\n"
            ));
            return Ok(1);
        }
        let body = if replace_all {
            content.body.replace(&old, &new)
        } else {
            content.body.replacen(&old, &new, 1)
        };
        // Everything but the body stays as it is; the summary discipline
        // mirrors update: a derived summary stays derived so it re-derives
        // from the edited body, an explicit one is passed through unchanged.
        let summary = if entry.summary_explicit {
            Some(node.summary().to_string())
        } else {
            None
        };
        let outcome = match &node {
            RefinoNode::Premise(premise) => store.update_premise(
                &id,
                &UpdatePremiseOptions {
                    base: UpdateOptions { body, summary },
                    confirmed: premise.confirmed,
                },
            )?,
            RefinoNode::Decision(decision) => store.update_decision(
                &id,
                &UpdateDecisionOptions {
                    base: UpdateOptions { body, summary },
                    grounds: Some(decision.grounds.clone()),
                    rationale: content.rationale.clone(),
                    exploring: decision.exploring == Some(true),
                },
            )?,
        };
        let affected = outcome.change.map(|c| c.affected).unwrap_or_default();
        let replaced = if replace_all { count } else { 1 };
        emit_edited(io, &id, type_name(&node), replaced, Some(&affected));
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
    let line = format!("{} {}\n", verb, node_file_label(id, node_type));
    io.out(&line);
    emit_affected(io, affected);
}

fn emit_edited(
    io: &mut dyn CliSink,
    id: &str,
    node_type: &str,
    replaced: usize,
    affected: Option<&[String]>,
) {
    let line = format!(
        "edited {} replaced {replaced}\n",
        node_file_label(id, node_type)
    );
    io.out(&line);
    emit_affected(io, affected);
}

/// Canonical one-line identity, e.g. `D4E5F6G7 (.refino/nodes/D4/E5F6G7-decision.md)`;
/// display keeps the forward-slash form across platforms.
fn node_file_label(id: &str, node_type: &str) -> String {
    let resolved_type = if node_type == "premise" {
        NodeType::Premise
    } else {
        NodeType::Decision
    };
    let file = node_relative_file(resolved_type, id);
    format!("{id} (.refino/{file})")
}

fn emit_affected(io: &mut dyn CliSink, affected: Option<&[String]>) {
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
