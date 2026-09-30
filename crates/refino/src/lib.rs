//! Command line interface for Decision Lineage Graphs (DLG): the clap binary
//! over the refino-core engine and refino-storage core. `run` returns the
//! process exit code instead of calling `process.exit` so tests can exercise
//! it in-process with a capturing sink.

pub mod dev;
pub mod format;
pub mod guide;
pub mod shared;

use clap::{Parser, Subcommand, error::ContextKind, error::ContextValue, error::ErrorKind};
use format::{CliSink, TableRow, render_full_record, render_node_table};
use refino_core::{
    LayerNode, NodeType, QueryGroup, RefinoNode, TraversalOptions, assign_layers,
    effective_exploring, get_ancestors, get_dependents, get_grounds, is_valid_id, query_groups,
    require_node,
};
use refino_storage::{StoreError, confirmed_to_ms, is_valid_confirmed, node_relative_file};
use shared::{
    GlobalOptions, QueryFailure, WriteFailure, global_options, refino_dir, report_query_failure,
    report_write_failure, with_store, with_store_for_write,
};

/// Parse arguments (skipping the program name) and run; returns the exit code.
pub fn run(argv: &[String], io: &mut dyn CliSink) -> i32 {
    // The dev command exists only under REFINO_DEV=true, and it must not
    // exist at all otherwise — check before clap parses, since a bare
    // `refino dev` never reaches dispatch (missing subcommand error).
    let mut i = 0;
    while i < argv.len() && argv[i] == "--root" {
        i += 2; // skip --root <dir>
    }
    if argv.get(i).map(String::as_str) == Some("dev")
        && std::env::var("REFINO_DEV").as_deref() != Ok("true")
    {
        io.err("error: unknown command 'dev'\n");
        return 1;
    }
    // clap expects argv[0] to be the binary name; callers pass user args only.
    let mut full: Vec<String> = Vec::with_capacity(argv.len() + 1);
    full.push("refino".to_string());
    full.extend_from_slice(argv);
    let cli = match Cli::try_parse_from(full) {
        Ok(cli) => cli,
        Err(error) => {
            // Usage errors exit 1 and --help/--version exit 0, mirroring
            // commander's exitOverride contract. Unknown subcommands render
            // commander's phrasing, which agents match against.
            let text = if error.kind() == ErrorKind::InvalidSubcommand {
                match error.get(ContextKind::InvalidSubcommand) {
                    Some(ContextValue::String(name)) => {
                        format!("error: unknown command '{name}'\n\n{}", error.render())
                    }
                    _ => error.to_string(),
                }
            } else {
                error.to_string()
            };
            let code = if error.use_stderr() { 1 } else { 0 };
            if error.use_stderr() {
                io.err(&text);
            } else {
                io.out(&text);
            }
            return code;
        }
    };
    dispatch(cli, io)
}

/// Entry point used by the binary.
pub fn run_from_env() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut sink = format::ProcessSink;
    run(&argv, &mut sink)
}

#[derive(Parser)]
#[command(
    name = "refino",
    version,
    about = "Parse, validate and query a Decision Lineage Graph stored in .refino/.",
    after_help = "\nRun \"refino guide\" for the agent-facing usage guide (concepts, conventions, caveats)."
)]
struct Cli {
    /// Project root directory containing .refino/
    #[arg(long, global = true)]
    root: Option<String>,

    #[command(subcommand)]
    command: Command_,
}

#[derive(Subcommand)]
enum Command_ {
    /// build the graph and report all validation issues
    Validate,
    /// list all nodes (id, type, summary)
    List {
        /// only list nodes of this type
        #[arg(long = "type")]
        node_type: Option<TypeArg>,
        /// list only premises that no decision grounds on
        #[arg(long)]
        unreferenced: bool,
    },
    /// print the full record of one or more nodes
    Show { ids: Vec<String> },
    /// direct grounds of one or more nodes
    Grounds { ids: Vec<String> },
    /// all nodes reachable by recursively following grounds
    Ancestors { ids: Vec<String> },
    /// decisions potentially affected if these nodes change
    Dependents { ids: Vec<String> },
    /// create a new node file in .refino/
    New {
        #[command(subcommand)]
        kind: NewKind,
    },
    /// update fields of an existing node; unspecified fields keep their current value
    Update {
        id: String,
        /// new content (markdown body)
        #[arg(long)]
        body: Option<String>,
        /// short summary for relevance checks (stored in frontmatter)
        #[arg(long)]
        summary: Option<String>,
        /// why the decision was made (decisions only)
        #[arg(long)]
        rationale: Option<String>,
        /// comma-separated ground node ids, replacing the whole list (decisions only)
        #[arg(long)]
        grounds: Option<String>,
        /// RFC 3339 timestamp with an explicit UTC offset (premises only)
        #[arg(long)]
        confirmed: Option<String>,
        /// confirm now: use the current UTC time as "confirmed" (premises only)
        #[arg(long)]
        now: bool,
        /// mark the decision as a trial commitment (decisions only)
        #[arg(long)]
        exploring: bool,
        /// settle the decision (remove the trial mark)
        #[arg(long)]
        no_exploring: bool,
    },
    /// delete one or more nodes; refuses while other nodes ground on the target
    Delete {
        ids: Vec<String>,
        /// delete even when other nodes ground on the target
        #[arg(long)]
        force: bool,
    },
    /// create the .refino/ directory skeleton (pure scaffolding)
    Init,
    /// print the agent-facing usage guide (concepts, conventions, caveats)
    Guide,
    /// development utilities (only registered when REFINO_DEV=true)
    #[command(hide = true)]
    Dev {
        #[command(subcommand)]
        kind: DevKind,
    },
}

#[derive(Subcommand)]
enum DevKind {
    /// programmatically generate a DLG fixture under .refino/
    Generate {
        /// total number of nodes to generate
        #[arg(long)]
        nodes: usize,
        /// fraction of premises among all nodes, 0-1 (default 0.3)
        #[arg(long)]
        premise_ratio: Option<f64>,
        /// number of root decisions with empty grounds (default 1)
        #[arg(long)]
        roots: Option<usize>,
        /// maximum grounds per non-root decision (default 8)
        #[arg(long)]
        max_grounds: Option<usize>,
        /// maximum decision-chain depth (default unlimited)
        #[arg(long)]
        max_depth: Option<usize>,
        /// fraction of companion grounds reaching across layers (default 0.2)
        #[arg(long)]
        cross_layer_ratio: Option<f64>,
        /// fraction of premises carrying a confirmed timestamp, 0-1 (default 1)
        #[arg(long)]
        confirmed_ratio: Option<f64>,
        /// random seed in [0, 2^32); same seed and options reproduce the graph
        #[arg(long)]
        seed: Option<u32>,
        /// allow generating into a non-empty .refino (new nodes are added)
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand)]
enum NewKind {
    /// create a premise node
    Premise {
        /// explicit node id (3-16 characters: A-Z, 0-9, _)
        #[arg(long)]
        id: Option<String>,
        /// fact content (markdown body); may be empty
        #[arg(long)]
        body: Option<String>,
        /// short summary for relevance checks (stored in frontmatter)
        #[arg(long)]
        summary: Option<String>,
        /// RFC 3339 timestamp with an explicit UTC offset
        #[arg(long)]
        confirmed: Option<String>,
        /// confirm now: use the current UTC time as "confirmed"
        #[arg(long)]
        now: bool,
    },
    /// create a decision node
    Decision {
        /// explicit node id (3-16 characters: A-Z, 0-9, _)
        #[arg(long)]
        id: Option<String>,
        /// decision content (markdown body); may be empty
        #[arg(long)]
        body: Option<String>,
        /// comma-separated ground node ids
        #[arg(long)]
        grounds: Option<String>,
        /// why the decision was made
        #[arg(long)]
        rationale: Option<String>,
        /// short summary for relevance checks (stored in frontmatter)
        #[arg(long)]
        summary: Option<String>,
        /// mark the decision as a trial commitment (default: settled)
        #[arg(long)]
        exploring: bool,
    },
}

#[derive(clap::ValueEnum, Clone, Copy, PartialEq)]
enum TypeArg {
    Premise,
    Decision,
}

impl From<TypeArg> for NodeType {
    fn from(value: TypeArg) -> Self {
        match value {
            TypeArg::Premise => NodeType::Premise,
            TypeArg::Decision => NodeType::Decision,
        }
    }
}

fn dispatch(cli: Cli, io: &mut dyn CliSink) -> i32 {
    let opts = global_options(&cli.root);
    match cli.command {
        Command_::Validate => cmd_validate(io, &opts),
        Command_::List {
            node_type,
            unreferenced,
        } => cmd_list(io, &opts, node_type, unreferenced),
        Command_::Show { ids } => cmd_show(io, &opts, &ids),
        Command_::Grounds { ids } => cmd_graph_query(io, &opts, &ids, GraphQuery::Grounds),
        Command_::Ancestors { ids } => cmd_graph_query(io, &opts, &ids, GraphQuery::Ancestors),
        Command_::Dependents { ids } => cmd_graph_query(io, &opts, &ids, GraphQuery::Dependents),
        Command_::New { kind } => cmd_new(io, &opts, kind),
        Command_::Update {
            id,
            body,
            summary,
            rationale,
            grounds,
            confirmed,
            now,
            exploring,
            no_exploring,
        } => cmd_update(
            io,
            &opts,
            &id,
            body,
            summary,
            rationale,
            grounds,
            confirmed,
            now,
            exploring,
            no_exploring,
        ),
        Command_::Delete { ids, force } => cmd_delete(io, &opts, &ids, force),
        Command_::Init => cmd_init(io, &opts),
        Command_::Guide => {
            io.out(&guide::guide_text());
            0
        }
        Command_::Dev { kind } => {
            // Without REFINO_DEV=true the command does not exist at all —
            // help output, unknown command errors and completions are
            // indistinguishable from a bare CLI.
            if std::env::var("REFINO_DEV").as_deref() != Ok("true") {
                io.err("error: unknown command 'dev'\n");
                return 1;
            }
            match kind {
                DevKind::Generate {
                    nodes,
                    premise_ratio,
                    roots,
                    max_grounds,
                    max_depth,
                    cross_layer_ratio,
                    confirmed_ratio,
                    seed,
                    force,
                } => dev::cmd_dev_generate(
                    io,
                    &opts,
                    &dev::GenerateDlgParams {
                        nodes,
                        premise_ratio: premise_ratio.unwrap_or(0.3),
                        roots,
                        max_grounds: max_grounds.unwrap_or(8),
                        max_depth,
                        cross_layer_ratio: cross_layer_ratio.unwrap_or(0.2),
                        confirmed_ratio: confirmed_ratio.unwrap_or(1.0),
                    },
                    seed,
                    force,
                ),
            }
        }
    }
}

fn cmd_validate(io: &mut dyn CliSink, opts: &GlobalOptions) -> i32 {
    // The blocking-issues path (render + exit 1) is with_store's own: graph
    // issues make query results ambiguous.
    let outcome = with_store(opts, |store| {
        let counts = count_nodes(store.graph());
        io.out(&format!(
            "valid: {} decisions, {} premises ({})\n",
            counts.decisions,
            counts.premises,
            refino_dir(opts).display()
        ));
        Ok(0)
    });
    finish(io, outcome)
}

fn finish(io: &mut dyn CliSink, outcome: Result<i32, QueryFailure>) -> i32 {
    match outcome {
        Ok(code) => code,
        Err(failure) => report_query_failure(io, failure),
    }
}

struct Counts {
    decisions: usize,
    premises: usize,
}

fn count_nodes(graph: &refino_core::Graph) -> Counts {
    let mut counts = Counts {
        decisions: 0,
        premises: 0,
    };
    for node in graph.nodes.values() {
        match node.node_type() {
            NodeType::Premise => counts.premises += 1,
            NodeType::Decision => counts.decisions += 1,
        }
    }
    counts
}

fn cmd_list(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    type_filter: Option<TypeArg>,
    unreferenced: bool,
) -> i32 {
    if unreferenced && type_filter == Some(TypeArg::Decision) {
        io.err("error: --unreferenced only applies to premises\n");
        return 1;
    }
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        let mut nodes: Vec<RefinoNode> = sort_nodes(graph);
        if let Some(filter) = type_filter {
            let want: NodeType = filter.into();
            nodes.retain(|n| n.node_type() == want);
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

fn type_name(node: &RefinoNode) -> &'static str {
    match node.node_type() {
        NodeType::Premise => "premise",
        NodeType::Decision => "decision",
    }
}

/// List order: upstream → downstream by longest-path layer, ties in id order.
fn sort_nodes(graph: &refino_core::Graph) -> Vec<RefinoNode> {
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

fn cmd_show(io: &mut dyn CliSink, opts: &GlobalOptions, ids: &[String]) -> i32 {
    let outcome = with_store(opts, |store| {
        let graph = store.graph();
        // select only runs for ids that exist, so require_node cannot fail.
        let groups = query_groups(graph, ids, |g, id| {
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
enum GraphQuery {
    Grounds,
    Ancestors,
    Dependents,
}

fn cmd_graph_query(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    ids: &[String],
    query: GraphQuery,
) -> i32 {
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
        let groups = query_groups(graph, ids, select);
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

fn cmd_new(io: &mut dyn CliSink, opts: &GlobalOptions, kind: NewKind) -> i32 {
    match kind {
        NewKind::Premise {
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
                let outcome = store.create_premise(&refino_storage::CreatePremiseOptions {
                    base: refino_storage::CreateOptions {
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
        NewKind::Decision {
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
                let outcome = store.create_decision(&refino_storage::CreateDecisionOptions {
                    base: refino_storage::CreateOptions {
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

fn finish_write(io: &mut dyn CliSink, outcome: Result<i32, WriteFailure>) -> i32 {
    match outcome {
        Ok(code) => code,
        Err(failure) => report_write_failure(io, failure),
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

#[allow(clippy::too_many_arguments)]
fn cmd_update(
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
            return Err(StoreError::Other(refino_core::RefinoError::new(
                "NODE_NOT_FOUND",
                format!("node \"{id}\" not found"),
            )));
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
                    &refino_storage::UpdatePremiseOptions {
                        base: refino_storage::UpdateOptions {
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
                    &refino_storage::UpdateDecisionOptions {
                        base: refino_storage::UpdateOptions {
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

fn cmd_delete(io: &mut dyn CliSink, opts: &GlobalOptions, ids: &[String], force: bool) -> i32 {
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
    type_name: &str,
    verb: &str,
    affected: Option<&[String]>,
) {
    // Display keeps the canonical forward-slash form.
    let node_type = if type_name == "premise" {
        NodeType::Premise
    } else {
        NodeType::Decision
    };
    let file = node_relative_file(node_type, id);
    io.out(&format!("{verb} {id} (.refino/{file})\n"));
    if let Some(affected) = affected
        && !affected.is_empty()
    {
        io.out(&format!("下游受影响，建议复核：{}\n", affected.join(", ")));
    }
}

fn cmd_init(io: &mut dyn CliSink, opts: &GlobalOptions) -> i32 {
    let dir = refino_dir(opts);
    // no recursive: EEXIST is the interesting case
    if let Err(error) = std::fs::create_dir(&dir) {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            io.err(&format!(
                "error: {} already exists (nothing to initialize)\n",
                dir.display()
            ));
            return 1;
        }
        io.err(&format!("error: {error}\n"));
        return 1;
    }
    if let Err(error) = std::fs::create_dir_all(dir.join("nodes")) {
        io.err(&format!("error: {error}\n"));
        return 1;
    }
    io.out(&format!(
        "initialized {} (empty graph; create nodes with \"refino new\")\n",
        dir.display()
    ));
    0
}
