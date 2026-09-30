//! Loading: read every node file under `<refinoDir>/nodes/` and build the
//! resident in-memory graph, plus single-node reads for incremental index
//! updates. Loading is read-only; the only write path is `writer.rs`.

use crate::codes::{StorageIssue, StorageIssueCode};
use crate::io::{self, Io};
use crate::parser::{NodeContent, parse_node_source};
use crate::writer::{NODES_DIR, node_file_path, node_relative_file};
use refino_core::{Graph, IssueCode, NodeType, RefinoError, RefinoNode, build_graph, is_valid_id};
use std::collections::HashMap;
use std::path::Path;

/// A shard directory name: the first 2 characters of a node id, drawn from
/// the engine's id charset (the id rule itself lives in the engine).
fn is_shard_name(name: &str) -> bool {
    name.len() == 2
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

#[derive(Debug)]
pub struct LoadResult {
    pub graph: Graph,
    /// Issues found while reading and parsing node files (including duplicate ids).
    pub issues: Vec<StorageIssue>,
    /// Node id -> file mtime (ms) at read time; the baseline for change detection.
    pub mtimes: HashMap<String, f64>,
    /// Node id -> whether the summary came from an explicit frontmatter field.
    pub summary_explicit: HashMap<String, bool>,
}

#[derive(Debug)]
pub struct ReadNodeResult {
    /// The parsed node, or None when neither candidate file exists.
    pub node: Option<RefinoNode>,
    /// The node's paged content (body, rationale); None when node is None.
    pub content: Option<NodeContent>,
    pub issues: Vec<StorageIssue>,
    /// File mtime (ms) of the winning candidate; None when node is None.
    pub mtime_ms: Option<f64>,
    /// Whether the winning candidate's summary came from an explicit
    /// frontmatter field (as opposed to being derived from the body); None
    /// when node is None. Partial-update write paths use this to keep derived
    /// summaries from being materialized into the file.
    pub summary_explicit: Option<bool>,
}

/// Read a single node by id (path is identity): parse whichever of the two
/// candidate files exists. Incremental index updates use this instead of a
/// full rescan, so parse logic stays single-sourced in the storage layer.
///
/// Candidate order mirrors load_graph's within-shard lexicographic scan
/// ("decision" sorts before "premise"), so single-node reads agree with full
/// loads: parse issues from every existing candidate are reported, the first
/// candidate yielding a valid node wins, and a second valid candidate is
/// reported as DUPLICATE_ID.
pub fn read_node<I: Io>(
    io: &I,
    refino_dir: &Path,
    id: &str,
) -> Result<ReadNodeResult, RefinoError> {
    if !is_valid_id(id) {
        return Err(RefinoError::new(
            IssueCode::INVALID_ID,
            format!("Node id must be 3-16 characters of A-Z, 0-9 or _, got \"{id}\"."),
        ));
    }
    // [...NODE_TYPES].sort() — lexicographic: "decision" before "premise".
    let candidates = [NodeType::Decision, NodeType::Premise];
    let mut issues: Vec<StorageIssue> = Vec::new();
    let mut node: Option<RefinoNode> = None;
    let mut content: Option<NodeContent> = None;
    let mut mtime_ms: Option<f64> = None;
    let mut summary_explicit: Option<bool> = None;
    for candidate_type in candidates {
        let file = node_relative_file(candidate_type, id);
        let read = read_source_or_none(io, &node_file_path(refino_dir, candidate_type, id))?;
        let Some((source, mtime)) = read else {
            continue; // no file of this type
        };
        let parsed = parse_node_source(id, &file, candidate_type, &source);
        issues.extend(parsed.issues);
        let Some(parsed_node) = parsed.node else {
            continue;
        };
        if node.is_some() {
            let existing_type = node.as_ref().map(|n| n.node_type()).expect("set above");
            issues.push(
                StorageIssue::new(
                    IssueCode::DUPLICATE_ID,
                    format!(
                        "Duplicate node id \"{id}\" (already defined in {}).",
                        node_relative_file(existing_type, id)
                    ),
                    file,
                )
                .with_node_id(id),
            );
            break; // both candidates parsed: nothing left to read
        }
        node = Some(parsed_node);
        content = parsed.content;
        mtime_ms = Some(mtime);
        summary_explicit = Some(parsed.summary_explicit);
    }
    Ok(ReadNodeResult {
        node,
        content,
        issues,
        mtime_ms,
        summary_explicit,
    })
}

/// Read every node file under `<refinoDir>/nodes/` and build the resident
/// in-memory graph. Paged content (body, rationale) is parsed for summary
/// derivation and then discarded — the resident graph never holds it.
///
/// Layout: `nodes/<2-char shard>/<rest>-<type>.md`, where `<type>` is
/// `premise` or `decision`. The node id is derived from the file path (path
/// is identity): shard directory name + the segment before the `-`
/// separator (ids never contain `-`, so the split is unambiguous), and the
/// type travels in the file name, never in the frontmatter.
///
/// Directory names that are not valid shards and non-markdown files are
/// silently ignored; nested files are ignored; stray markdown files at the
/// top of `nodes/` and files whose name has no valid `<id_2>-<type>` shape
/// are reported as INVALID_NODE_PATH; ids that fail the engine's id rule are
/// reported as INVALID_ID. A missing `nodes/` directory is an empty graph.
/// Structural validation (unknown grounds, cycles) is a separate step:
/// `validate_graph`.
pub fn load_graph<I: Io>(io: &I, refino_dir: &Path) -> Result<LoadResult, RefinoError> {
    if !io.is_directory(refino_dir) {
        return Err(RefinoError::new(
            StorageIssueCode::REFINO_DIR_NOT_FOUND,
            format!("No .refino directory found at {}", refino_dir.display()),
        ));
    }

    let mut nodes: Vec<RefinoNode> = Vec::new();
    let mut issues: Vec<StorageIssue> = Vec::new();
    let mut seen_ids: HashMap<String, String> = HashMap::new();
    let mut mtimes: HashMap<String, f64> = HashMap::new();
    let mut summary_explicit: HashMap<String, bool> = HashMap::new();

    let nodes_dir = refino_dir.join(NODES_DIR);
    let shards = match io.read_dir(&nodes_dir) {
        Ok(entries) => entries,
        Err(error) if io::is_enoent(&error) => {
            return Ok(LoadResult {
                graph: build_graph(Vec::new()),
                issues,
                mtimes,
                summary_explicit,
            }); // empty store
        }
        Err(error) => return Err(RefinoError::new("IO_ERROR", error.to_string())),
    };

    let mut shards = shards;
    shards.sort_by(|a, b| a.name.cmp(&b.name));
    for shard in shards {
        if shard.is_file && shard.name.ends_with(".md") {
            let file = format!("{NODES_DIR}/{}", shard.name);
            issues.push(StorageIssue::new(
                StorageIssueCode::INVALID_NODE_PATH,
                format!(
                    "Node files must live at {NODES_DIR}/<shard>/<id_2>-<type>.md, e.g. {NODES_DIR}/01/9ABCDE-premise.md; got \"{file}\"."
                ),
                file,
            ));
            continue;
        }
        if !shard.is_dir || !is_shard_name(&shard.name) {
            continue; // silently ignored
        }
        let shard_dir = nodes_dir.join(&shard.name);
        let files = match io.read_dir(&shard_dir) {
            Ok(entries) => entries,
            Err(error) if io::is_enoent(&error) => continue, // changed mid-scan
            Err(error) => return Err(RefinoError::new("IO_ERROR", error.to_string())),
        };
        let mut files = files;
        files.sort_by(|a, b| a.name.cmp(&b.name));
        for entry in files {
            // Deeper directories and non-markdown files are silently ignored.
            if !entry.is_file || !entry.name.ends_with(".md") {
                continue;
            }
            let file = format!("{NODES_DIR}/{}/{}", shard.name, entry.name);
            let read = read_source_or_none(io, &shard_dir.join(&entry.name))?;
            let Some((source, mtime)) = read else {
                continue;
            }; // changed mid-scan
            let Some((id2, node_type)) =
                parse_file_name(entry.name.strip_suffix(".md").expect(".md checked"))
            else {
                issues.push(StorageIssue::new(
                    StorageIssueCode::INVALID_NODE_PATH,
                    format!(
                        "Node file names must be <id_2>-<type>.md with <type> one of premise|decision, got \"{}\".",
                        entry.name
                    ),
                    file,
                ));
                continue;
            };
            let id = format!("{}{}", shard.name, id2);
            if !is_valid_id(&id) {
                issues.push(StorageIssue::new(
                    refino_core::IssueCode::INVALID_ID,
                    format!(
                        "Node id must be 3-16 characters of A-Z, 0-9 or _ (the id is shard + id_2), got \"{id}\"."
                    ),
                    file,
                ));
                continue;
            }
            let parsed = parse_node_source(&id, &file, node_type, &source);
            issues.extend(parsed.issues);
            let Some(node) = parsed.node else { continue };
            if let Some(existing_file) = seen_ids.get(node.id()) {
                issues.push(
                    StorageIssue::new(
                        IssueCode::DUPLICATE_ID,
                        format!(
                            "Duplicate node id \"{}\" (already defined in {existing_file}).",
                            node.id()
                        ),
                        node_relative_file(node_type, &id),
                    )
                    .with_node_id(id),
                );
                continue;
            }
            seen_ids.insert(
                node.id().to_string(),
                node_relative_file(node.node_type(), node.id()),
            );
            mtimes.insert(node.id().to_string(), mtime);
            summary_explicit.insert(node.id().to_string(), parsed.summary_explicit);
            nodes.push(node);
        }
    }

    Ok(LoadResult {
        graph: build_graph(nodes),
        issues,
        mtimes,
        summary_explicit,
    })
}

/// `Ok(None)` when the file does not exist (changed mid-scan).
fn read_source_or_none<I: Io>(io: &I, path: &Path) -> Result<Option<(String, f64)>, RefinoError> {
    io.read_with_mtime(path)
        .map_err(|e| RefinoError::new("IO_ERROR", e.to_string()))
}

/// Split `<id_2>-<type>` into its parts; None when the shape is wrong. The
/// split is unambiguous: ids never contain `-` (engine id rule), so the last
/// `-` is always the id/type separator.
fn parse_file_name(name: &str) -> Option<(String, NodeType)> {
    let dash = name.rfind('-')?;
    let type_name = &name[dash + 1..];
    let node_type = match type_name {
        "premise" => NodeType::Premise,
        "decision" => NodeType::Decision,
        _ => return None,
    };
    Some((name[..dash].to_string(), node_type))
}

/// Locate the `.refino` directory for a working directory: the nearest
/// ancestor (the directory itself included) containing a `.refino` directory.
/// None when no ancestor has one, in which case the caller leaves the host
/// untouched (docs/design.md, 采用契约: locating `.refino` is the activation
/// precondition of an integration).
pub fn find_refino_dir<I: Io>(io: &I, cwd: &Path) -> Option<std::path::PathBuf> {
    let mut current = cwd.to_path_buf();
    loop {
        let candidate = current.join(".refino");
        if io.is_directory(&candidate) {
            return Some(candidate);
        }
        let parent = current.parent()?;
        current = parent.to_path_buf();
    }
}
