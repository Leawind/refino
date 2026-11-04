//! Command line interface for Decision Lineage Graphs (DLG): the clap binary
//! over the refino-core engine and refino-storage core. `run` returns the
//! process exit code instead of calling `process.exit` so tests can exercise
//! it in-process with a capturing sink. Argument parsing and dispatch live
//! here; command implementations live in `query` and `write`.

pub mod dev;
pub mod format;
pub mod guide;
pub mod query;
pub mod shared;
pub mod write;

use clap::{Parser, Subcommand, error::ContextKind, error::ContextValue, error::ErrorKind};
use format::CliSink;
use refino_core::NodeType;
use shared::{GlobalOptions, finish, global_options, refino_dir, with_store};
use write::NewKindArgs;

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
        /// list only top-level decisions: none of their direct grounds is a
        /// decision (grounds may be empty or premises only)
        #[arg(long)]
        roots: bool,
        /// cap the number of listed nodes
        #[arg(long)]
        limit: Option<usize>,
    },
    /// print the full record of one or more nodes
    Show { ids: Vec<String> },
    /// search nodes by id prefix or summary substring (case-insensitive;
    /// bodies are not searched)
    Search {
        /// id prefix or summary substring to match (empty: match all)
        q: Option<String>,
        /// only match nodes of this type
        #[arg(long = "type")]
        node_type: Option<TypeArg>,
        /// page size (default 50, clamped to [1, 500])
        #[arg(long)]
        limit: Option<usize>,
        /// resume strictly after this id (keyset pagination)
        #[arg(long)]
        cursor: Option<String>,
    },
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
    /// start the web UI server
    Web {
        /// IP address to bind
        #[arg(long)]
        host: Option<String>,
        /// port to listen on (default: 5649; bumps to the next free port when taken)
        #[arg(long)]
        port: Option<String>,
    },
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
            roots,
            limit,
        } => query::cmd_list(
            io,
            &opts,
            node_type.map(NodeType::from),
            unreferenced,
            roots,
            limit,
        ),
        Command_::Show { ids } => query::cmd_show(io, &opts, &ids),
        Command_::Search {
            q,
            node_type,
            limit,
            cursor,
        } => query::cmd_search(
            io,
            &opts,
            q.as_deref(),
            node_type.map(NodeType::from),
            limit,
            cursor.as_deref(),
        ),
        Command_::Grounds { ids } => {
            query::cmd_graph_query(io, &opts, &ids, query::GraphQuery::Grounds)
        }
        Command_::Ancestors { ids } => {
            query::cmd_graph_query(io, &opts, &ids, query::GraphQuery::Ancestors)
        }
        Command_::Dependents { ids } => {
            query::cmd_graph_query(io, &opts, &ids, query::GraphQuery::Dependents)
        }
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
        } => write::cmd_update(
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
        Command_::Delete { ids, force } => write::cmd_delete(io, &opts, &ids, force),
        Command_::Init => cmd_init(io, &opts),
        Command_::Guide => {
            io.out(&guide::guide_text());
            0
        }
        Command_::Web { host, port } => cmd_web(io, &opts, host, port),
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

fn cmd_new(io: &mut dyn CliSink, opts: &GlobalOptions, kind: NewKind) -> i32 {
    let args = match kind {
        NewKind::Premise {
            id,
            body,
            summary,
            confirmed,
            now,
        } => NewKindArgs::Premise {
            id,
            body,
            summary,
            confirmed,
            now,
        },
        NewKind::Decision {
            id,
            body,
            grounds,
            rationale,
            summary,
            exploring,
        } => NewKindArgs::Decision {
            id,
            body,
            grounds,
            rationale,
            summary,
            exploring,
        },
    };
    write::cmd_new(io, opts, args)
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

/// `refino web` — start the local HTTP service and block until interrupted.
fn cmd_web(
    io: &mut dyn CliSink,
    opts: &GlobalOptions,
    host: Option<String>,
    port: Option<String>,
) -> i32 {
    let port_number = match port {
        None => None,
        Some(text) => match text.parse::<u16>() {
            Ok(parsed) => Some(parsed),
            Err(_) => {
                io.err(&format!("error: invalid port \"{text}\"\n"));
                return 1;
            }
        },
    };
    let static_root = refino_server::resolve_ui_static_root(&opts.root);
    let options = refino_server::WebServerOptions {
        host: host.unwrap_or_else(|| "127.0.0.1".to_string()),
        port: port_number,
        refino_dir: refino_dir(opts),
        static_root,
        watch_debounce_ms: None,
    };
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            io.err(&format!("error: {error}\n"));
            return 1;
        }
    };
    runtime.block_on(async move {
        let server = match refino_server::start_web_server(options).await {
            Ok(server) => server,
            Err(error) => {
                io.err(&format!("error: {error}\n"));
                return 1;
            }
        };
        io.out(&format!("listening on {}\n", server.url));
        // Block on SIGINT/SIGTERM, then shut the socket and watcher down.
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = sigterm() => {},
        };
        server.shutdown().await;
        0
    })
}

async fn sigterm() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    }
    #[cfg(not(unix))]
    {
        std::future::pending::<()>().await
    }
}
