//! Node file writing: create, update, delete and the atomic write primitive.
//! This is the storage format's only write path; everything else stays
//! read-only.

use crate::io::Io;
use crate::parser::confirmed_to_rfc3339;
use crate::yaml::{FieldValue, serialize_node};
use refino_core::{IssueCode, NodeType, RefinoError, generate_id, is_valid_id};
use std::path::{Path, PathBuf};

pub const NODES_DIR: &str = "nodes";

/// The node types, in canonical order.
pub const NODE_TYPES: [NodeType; 2] = [NodeType::Premise, NodeType::Decision];

/// Canonical `.refino`-relative path of a node, always forward-slash:
/// `nodes/<first 2 id chars>/<rest>-<type>.md`. The `-` separator is
/// unambiguous because ids never contain `-` (engine id rule).
pub fn node_relative_file(node_type: NodeType, id: &str) -> String {
    let type_name = match node_type {
        NodeType::Premise => "premise",
        NodeType::Decision => "decision",
    };
    format!(
        "{NODES_DIR}/{}/{id_2}-{type_name}.md",
        &id[..2],
        id_2 = &id[2..]
    )
}

/// Inverse of `node_relative_file`: the node id encoded in a canonical
/// `.refino`-relative path, or None when the path is not a node file. Single
/// point of the path↔id mapping so consumers never hard-code the storage
/// layout.
pub fn node_id_from_relative_file(file: &str) -> Option<String> {
    let rest = file.strip_prefix("nodes/")?;
    let (shard, tail) = rest.split_once('/')?;
    if shard.chars().count() != 2 || !shard.bytes().all(is_id_byte) {
        return None;
    }
    let stem = tail.strip_suffix(".md")?;
    let dash = stem.rfind('-')?;
    let (id2, type_name) = (&stem[..dash], &stem[dash + 1..]);
    match type_name {
        "premise" | "decision" => {}
        _ => return None,
    }
    if id2.is_empty() {
        return None;
    }
    Some(format!("{shard}{id2}"))
}

fn is_id_byte(b: u8) -> bool {
    b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'
}

/// Absolute path of a node file of the given type (platform separators).
pub fn node_file_path(refino_dir: &Path, node_type: NodeType, id: &str) -> PathBuf {
    refino_dir.join(node_relative_file(node_type, id))
}

pub struct CreateOptions {
    pub body: String,
    /// Explicit node id, valid per the engine's id rule; generated when None.
    pub id: Option<String>,
    /// Independent summary attribute; stored as a "summary" frontmatter
    /// field. When None, readers fall back to the first paragraph of the body.
    pub summary: Option<String>,
}

pub struct CreatePremiseOptions {
    pub base: CreateOptions,
    /// Confirmation time as epoch milliseconds; stored as RFC 3339 (UTC).
    pub confirmed: Option<i64>,
}

pub struct CreateDecisionOptions {
    pub base: CreateOptions,
    /// Ids of upstream premise/decision nodes.
    pub grounds: Option<Vec<String>>,
    /// Why the decision was made.
    pub rationale: Option<String>,
    /// Trial-commitment mark; only `true` is ever written to the file, false
    /// and absent both mean settled.
    pub exploring: bool,
}

pub struct UpdateOptions {
    pub body: String,
    pub summary: Option<String>,
}

pub struct UpdatePremiseOptions {
    pub base: UpdateOptions,
    pub confirmed: Option<i64>,
}

pub struct UpdateDecisionOptions {
    pub base: UpdateOptions,
    pub grounds: Option<Vec<String>>,
    pub rationale: Option<String>,
    pub exploring: bool,
}

/// Create a premise node file under `<refinoDir>/nodes/`; returns the new id.
pub fn create_premise<I: Io>(
    io: &I,
    refino_dir: &Path,
    opts: &CreatePremiseOptions,
    random: &dyn refino_core::RandomSource,
) -> Result<String, RefinoError> {
    let mut fields: Vec<(String, FieldValue)> = Vec::new();
    if let Some(confirmed) = opts.confirmed {
        fields.push((
            "confirmed".to_string(),
            FieldValue::Str(confirmed_to_rfc3339(confirmed)?),
        ));
    }
    if let Some(summary) = &opts.base.summary {
        fields.push(("summary".to_string(), FieldValue::Str(summary.clone())));
    }
    create_node(
        io,
        refino_dir,
        NodeType::Premise,
        fields,
        &opts.base.body,
        opts.base.id.as_deref(),
        random,
    )
}

/// Create a decision node file under `<refinoDir>/nodes/`; returns the new id.
pub fn create_decision<I: Io>(
    io: &I,
    refino_dir: &Path,
    opts: &CreateDecisionOptions,
    random: &dyn refino_core::RandomSource,
) -> Result<String, RefinoError> {
    let mut fields: Vec<(String, FieldValue)> = Vec::new();
    if let Some(grounds) = &opts.grounds {
        fields.push(("grounds".to_string(), FieldValue::StrList(grounds.clone())));
    }
    if let Some(rationale) = &opts.rationale {
        fields.push(("rationale".to_string(), FieldValue::Str(rationale.clone())));
    }
    if let Some(summary) = &opts.base.summary {
        fields.push(("summary".to_string(), FieldValue::Str(summary.clone())));
    }
    if opts.exploring {
        fields.push(("exploring".to_string(), FieldValue::BoolTrue));
    }
    create_node(
        io,
        refino_dir,
        NodeType::Decision,
        fields,
        &opts.base.body,
        opts.base.id.as_deref(),
        random,
    )
}

fn create_node<I: Io>(
    io: &I,
    refino_dir: &Path,
    node_type: NodeType,
    fields: Vec<(String, FieldValue)>,
    body: &str,
    explicit_id: Option<&str>,
    random: &dyn refino_core::RandomSource,
) -> Result<String, RefinoError> {
    let id: String = match explicit_id {
        Some(explicit) => {
            if !is_valid_id(explicit) {
                return Err(RefinoError::new(
                    IssueCode::INVALID_ID,
                    format!(
                        "Node id must be 3-16 characters of A-Z, 0-9 or _, got \"{explicit}\"."
                    ),
                ));
            }
            if id_exists(io, refino_dir, explicit) {
                return Err(RefinoError::new(
                    IssueCode::DUPLICATE_ID,
                    format!("Node id \"{explicit}\" is already in use."),
                ));
            }
            explicit.to_string()
        }
        None => loop {
            let candidate = generate_id(random);
            if !id_exists(io, refino_dir, &candidate) {
                break candidate;
            }
        },
    };
    let file = node_file_path(refino_dir, node_type, &id);
    if let Some(parent) = file.parent() {
        io.create_dir_all(parent).map_err(|e| refino_error_io(&e))?;
    }
    atomic_write_file(io, &file, &serialize_node(&fields, body))?;
    Ok(id)
}

/// Overwrite an existing premise node file; NODE_NOT_FOUND when absent.
pub fn update_premise<I: Io>(
    io: &I,
    refino_dir: &Path,
    id: &str,
    opts: &UpdatePremiseOptions,
) -> Result<(), RefinoError> {
    let mut fields: Vec<(String, FieldValue)> = Vec::new();
    if let Some(confirmed) = opts.confirmed {
        fields.push((
            "confirmed".to_string(),
            FieldValue::Str(confirmed_to_rfc3339(confirmed)?),
        ));
    }
    if let Some(summary) = &opts.base.summary {
        fields.push(("summary".to_string(), FieldValue::Str(summary.clone())));
    }
    update_node(
        io,
        refino_dir,
        NodeType::Premise,
        id,
        fields,
        &opts.base.body,
    )
}

/// Overwrite an existing decision node file; NODE_NOT_FOUND when absent.
pub fn update_decision<I: Io>(
    io: &I,
    refino_dir: &Path,
    id: &str,
    opts: &UpdateDecisionOptions,
) -> Result<(), RefinoError> {
    let mut fields: Vec<(String, FieldValue)> = Vec::new();
    if let Some(grounds) = &opts.grounds {
        fields.push(("grounds".to_string(), FieldValue::StrList(grounds.clone())));
    }
    if let Some(rationale) = &opts.rationale {
        fields.push(("rationale".to_string(), FieldValue::Str(rationale.clone())));
    }
    if let Some(summary) = &opts.base.summary {
        fields.push(("summary".to_string(), FieldValue::Str(summary.clone())));
    }
    if opts.exploring {
        fields.push(("exploring".to_string(), FieldValue::BoolTrue));
    }
    update_node(
        io,
        refino_dir,
        NodeType::Decision,
        id,
        fields,
        &opts.base.body,
    )
}

fn update_node<I: Io>(
    io: &I,
    refino_dir: &Path,
    node_type: NodeType,
    id: &str,
    fields: Vec<(String, FieldValue)>,
    body: &str,
) -> Result<(), RefinoError> {
    assert_valid_id(id)?;
    let file = node_file_path(refino_dir, node_type, id);
    if !io.path_exists(&file) {
        return Err(RefinoError::new(
            IssueCode::NODE_NOT_FOUND,
            format!("Node \"{id}\" does not exist."),
        ));
    }
    atomic_write_file(io, &file, &serialize_node(&fields, body))
}

/// Delete a node file. Ids are globally unique across both candidate paths,
/// so deleting removes whichever type-specific file exists; NODE_NOT_FOUND
/// when neither does. Referencing nodes are left untouched — dangling grounds
/// surface as UNKNOWN_GROUND issues on the next load.
pub fn delete_node<I: Io>(io: &I, refino_dir: &Path, id: &str) -> Result<(), RefinoError> {
    assert_valid_id(id)?;
    for node_type in NODE_TYPES {
        let file = node_file_path(refino_dir, node_type, id);
        if io.path_exists(&file) {
            io.remove_file(&file).map_err(|e| refino_error_io(&e))?;
            return Ok(());
        }
    }
    Err(RefinoError::new(
        IssueCode::NODE_NOT_FOUND,
        format!("Node \"{id}\" does not exist."),
    ))
}

/// Monotonic suffix making temp names unique within the process; the pid
/// disambiguates across processes. (The TS implementation keeps this counter
/// module-global; so do we.)
static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Sole filesystem write primitive: write to a temp file in the target's
/// directory, then rename it into place, so readers (loader scans, directory
/// watchers) never observe a half-written node file. The temp name never
/// matches the `<id_2>-<type>.md` node shape, so the loader silently skips
/// it. On Windows a concurrent reader holding the destination open can
/// transiently fail the replace; back off briefly (10ms * attempt, three
/// attempts) before giving up.
pub fn atomic_write_file<I: Io>(io: &I, file: &Path, content: &str) -> Result<(), RefinoError> {
    let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // `<file>.<pid>-<seq>.tmp`: appended to the full file name, never
    // matching the node shape.
    let tmp = sibling_path(
        file,
        &format!(
            "{}.{}-{}.tmp",
            file.file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default(),
            io.pid(),
            seq
        ),
    );
    io.write_file(&tmp, content).map_err(|e| {
        let _ = io.remove_file(&tmp);
        refino_error_io(&e)
    })?;
    let mut attempt = 1;
    loop {
        match io.rename(&tmp, file) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let retryable = is_permission_error(&error);
                if attempt >= 3 || !retryable {
                    let _ = io.remove_file(&tmp); // best-effort temp cleanup
                    return Err(refino_error_io(&error));
                }
                io.sleep_ms(10 * attempt as u64);
                attempt += 1;
            }
        }
    }
}

fn sibling_path(file: &Path, name: &str) -> PathBuf {
    file.with_file_name(name)
}

/// EPERM/EACCES-class failures.
fn is_permission_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied
}

fn refino_error_io(error: &std::io::Error) -> RefinoError {
    RefinoError::new("IO_ERROR", error.to_string())
}

/// Whether either candidate path of the id exists (ids are globally unique).
fn id_exists<I: Io>(io: &I, refino_dir: &Path, id: &str) -> bool {
    NODE_TYPES
        .iter()
        .any(|t| io.path_exists(&node_file_path(refino_dir, *t, id)))
}

fn assert_valid_id(id: &str) -> Result<(), RefinoError> {
    if !is_valid_id(id) {
        return Err(RefinoError::new(
            IssueCode::INVALID_ID,
            format!("Node id must be 3-16 characters of A-Z, 0-9 or _, got \"{id}\"."),
        ));
    }
    Ok(())
}
