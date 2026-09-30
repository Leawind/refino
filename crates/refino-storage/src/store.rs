//! Stateful resident projection of a `.refino/` directory (docs/design.md,
//! "存储层 Store"): the authoritative data lives in the files, the store
//! mirrors it in memory (resident graph + paged content LRU + issue caches)
//! and keeps the projection consistent with the disk by construction — every
//! write method validates, persists atomically, re-reads the file and applies
//! the parsed result through the engine's mutation primitives in one call,
//! then broadcasts the change. External file events enter through the same
//! `apply_change`, so forgetting to sync the projection is impossible.
//!
//! The TypeScript implementation serializes mutations through a promise
//! queue; here every method is synchronous, so calls are serialized by the
//! caller (single-threaded hosts, or a mutex at the binding boundary).

use crate::codes::{StorageIssue, StoreIssue};
use crate::io::{Io, is_enoent};
use crate::loader::{load_graph, read_node};
use crate::parser::NodeContent;
use crate::writer::{
    CreateDecisionOptions, CreatePremiseOptions, UpdateDecisionOptions, UpdatePremiseOptions,
    create_decision as write_decision, create_premise as write_premise,
    delete_node as remove_node_file, node_relative_file, update_decision as write_decision_update,
    update_premise as write_premise_update,
};
use refino_core::{
    DecisionNode, Graph, GraphNode, IssueCode, NodeType, RefinoError, RefinoNode, add_node,
    check_grounds_change, generate_id, remove_node, update_node, validate_graph,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

/// A subscribed change-batch callback.
type ChangeHandler = Box<dyn FnMut(&StoreChange)>;

/// Write entry that produced an incremental event; absent on snapshots and reloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Api,
    File,
}

/// One change batch applied to the store. API writes and external file events
/// go through the same entry, so every consumer sees the same shape; the
/// pending-review accumulation policy, SSE envelopes and origin presentation
/// belong to the consumers, not the store.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreChange {
    pub revision: u64,
    pub changed: Vec<String>,
    pub deleted: Vec<String>,
    /// Direct dependents (one hop) of the changed nodes in the new graph plus
    /// the removed nodes' pre-mutation dependents — the pending-review raw
    /// material (docs/dlg.md 1.6). Sorted, deduplicated.
    pub affected: Vec<String>,
    /// Write entry that produced an incremental event; absent on snapshots and reloads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// Present on full rebuilds: clients refresh wholesale instead of patching.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reload: Option<bool>,
}

/// One resident node record in the store.
#[derive(Debug, Clone)]
pub struct StoreEntry {
    /// Resident graph-attached node record; body and rationale are paged.
    pub node: GraphNode,
    /// Global revision at which this node last changed.
    pub revision: u64,
    /// File mtime (ms) captured with the last read; content-level change signal.
    pub mtime_ms: f64,
    /// Whether the summary came from an explicit frontmatter field (not derived from the body).
    pub summary_explicit: bool,
}

/// Result of a store write: the written id and the applied change batch.
#[derive(Debug)]
pub struct WriteOutcome {
    pub id: String,
    /// None when the write turned out to be a no-op (identical file state).
    pub change: Option<StoreChange>,
}

/// Raised by the store's write methods when pre-write validation rejects the
/// change (grounds that do not resolve, close a cycle, or repeat an id).
/// Carries the issues so consumers can present them; hard storage errors
/// (unknown id, duplicate id, bad RFC 3339 confirmed) stay `RefinoError`.
#[derive(Debug, Clone)]
pub struct WriteRejected {
    pub issues: Vec<StoreIssue>,
}

impl WriteRejected {
    pub fn new(issues: Vec<StoreIssue>) -> Self {
        WriteRejected { issues }
    }
}

impl std::fmt::Display for WriteRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "The change was rejected by grounds validation.")
    }
}

impl std::error::Error for WriteRejected {}

/// Error type of the store's write methods: pre-write validation rejections
/// (carrying their issues) vs everything else.
#[derive(Debug, Clone)]
pub enum StoreError {
    Rejected(WriteRejected),
    Other(RefinoError),
}

impl StoreError {
    pub fn other(error: RefinoError) -> Self {
        StoreError::Other(error)
    }
}

impl From<RefinoError> for StoreError {
    fn from(error: RefinoError) -> Self {
        StoreError::Other(error)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Rejected(rejected) => write!(f, "{rejected}"),
            StoreError::Other(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StoreError {}

const CONTENT_CACHE_MAX: usize = 500;
/// Initial revision after the first full load.
const INITIAL_REVISION: u64 = 1;

pub struct RefinoStore<I: Io> {
    pub refino_dir: std::path::PathBuf,
    io: I,
    random: Box<dyn refino_core::RandomSource>,
    graph: Graph,
    entries: BTreeMap<String, StoreEntry>,
    /// Issue cache in two layers. Parse issues come from reading node files
    /// (loader/`read_node` output) and are re-stored whenever a file is
    /// re-read; graph issues come from structural checks (`validate_graph` at
    /// load, `checkGroundsChange` rechecks afterwards) and are recomputed per
    /// applied change and its direct dependents. Both are keyed by node id or
    /// by the `.refino`-relative file for issues that never resolved to an id.
    parse_issues: BTreeMap<String, Vec<StoreIssue>>,
    graph_issues: BTreeMap<String, Vec<StoreIssue>>,
    revision: u64,
    /// Insertion-ordered content LRU.
    contents: HashMap<String, NodeContent>,
    content_order: Vec<String>,
    sorted_ids: Option<Vec<String>>,
    subscribers: Vec<ChangeHandler>,
    loaded: bool,
}

impl<I: Io> RefinoStore<I> {
    /// Create a store over the directory. Loading is lazy and retried: call
    /// `ready()` before reading, and a failed load (e.g. a missing directory
    /// the caller treats as recoverable) surfaces through `ready()` again on
    /// the next call.
    pub fn new(
        io: I,
        random: impl refino_core::RandomSource + 'static,
        refino_dir: std::path::PathBuf,
    ) -> Self {
        RefinoStore {
            refino_dir,
            io,
            random: Box::new(random),
            graph: Graph::default(),
            entries: BTreeMap::new(),
            parse_issues: BTreeMap::new(),
            graph_issues: BTreeMap::new(),
            revision: 0,
            contents: HashMap::new(),
            content_order: Vec::new(),
            sorted_ids: None,
            subscribers: Vec::new(),
            loaded: false,
        }
    }

    /// Full load once per store lifetime; retried after a failed attempt.
    pub fn ready(&mut self) -> Result<(), RefinoError> {
        if self.loaded {
            return Ok(());
        }
        self.load()?;
        self.loaded = true;
        Ok(())
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// The resident graph (topology and summaries; content is paged).
    pub fn graph(&self) -> &Graph {
        &self.graph
    }

    pub fn entry(&self, id: &str) -> Option<&StoreEntry> {
        self.entries.get(id)
    }

    /// Issue entries flattened, deduplicated by message and deterministically ordered.
    pub fn issues(&self) -> Vec<StoreIssue> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut all: Vec<StoreIssue> = Vec::new();
        for list in self.parse_issues.values().chain(self.graph_issues.values()) {
            for issue in list {
                if seen.contains(issue.message()) {
                    continue;
                }
                seen.insert(issue.message().to_string());
                all.push(issue.clone());
            }
        }
        all.sort_by(|a, b| {
            a.code()
                .cmp(b.code())
                .then_with(|| a.message().cmp(b.message()))
        });
        all
    }

    /// Issues that relate to the given node (by id or by its candidate files).
    pub fn issues_for(&self, id: &str) -> Vec<StoreIssue> {
        let keys: HashSet<String> = candidate_files(id)
            .into_iter()
            .chain([id.to_string()])
            .collect();
        self.issues()
            .into_iter()
            .filter(|issue| {
                issue.node_id().map(|n| keys.contains(n)).unwrap_or(false)
                    || issue.file().map(|f| keys.contains(f)).unwrap_or(false)
            })
            .collect()
    }

    /// Node content on demand (path is identity), LRU-cached.
    pub fn content(&mut self, id: &str) -> Result<Option<NodeContent>, RefinoError> {
        if !self.entries.contains_key(id) {
            return Ok(None);
        }
        if self.contents.contains_key(id) {
            let content = self.contents.get(id).cloned().expect("checked");
            self.touch_content(id);
            return Ok(Some(content));
        }
        let read = read_node(&self.io, &self.refino_dir, id)?;
        let Some(content) = read.content else {
            return Ok(None);
        };
        self.cache_content(id.to_string(), content.clone());
        Ok(Some(content))
    }

    /// Counts for project-overview cold starts; derived from the resident
    /// graph. Roots are canvas-scope: a decision is a root when none of its
    /// direct grounds is a decision (premise-only or empty grounds both
    /// qualify).
    pub fn stats(&self) -> Stats {
        let mut decisions = 0u64;
        let mut premises = 0u64;
        let mut roots = 0u64;
        for node in self.graph.nodes.values() {
            match node.node_type() {
                NodeType::Premise => premises += 1,
                NodeType::Decision => {
                    decisions += 1;
                    let grounded_on_decision = node
                        .as_decision()
                        .map(|d| {
                            d.grounds.iter().any(|g| {
                                self.entries.get(g).map(|e| e.node.node_type())
                                    == Some(NodeType::Decision)
                            })
                        })
                        .unwrap_or(false);
                    if !grounded_on_decision {
                        roots += 1;
                    }
                }
            }
        }
        Stats {
            nodes: decisions + premises,
            decisions,
            premises,
            roots,
        }
    }

    /// Ids in ascending order; the sorted view is cached and invalidated on writes.
    pub fn sorted_ids(&mut self) -> Vec<String> {
        if self.sorted_ids.is_none() {
            self.sorted_ids = Some(self.entries.keys().cloned().collect());
        }
        self.sorted_ids.clone().expect("just set")
    }

    /// Subscribe to applied change batches; returns the subscriber index to
    /// pass to `unsubscribe`.
    pub fn on_change(&mut self, handler: impl FnMut(&StoreChange) + 'static) -> usize {
        self.subscribers.push(Box::new(handler));
        self.subscribers.len() - 1
    }

    pub fn unsubscribe(&mut self, index: usize) {
        if index < self.subscribers.len() {
            drop(self.subscribers.remove(index));
        }
    }

    /// POST /api/reload equivalent: full rescan and projection rebuild — the
    /// authoritative recovery channel after missed events, watcher loss or
    /// service restart. Always bumps the revision so clients refresh.
    pub fn reload(&mut self) -> Result<StoreChange, RefinoError> {
        let previous = self.revision;
        self.load()?;
        self.loaded = true;
        self.revision = previous + 1;
        for entry in self.entries.values_mut() {
            entry.revision = self.revision;
        }
        let change = StoreChange {
            revision: self.revision,
            changed: vec![],
            deleted: vec![],
            affected: vec![],
            origin: None,
            reload: Some(true),
        };
        self.broadcast(&change);
        Ok(change)
    }

    /// The single incremental update entry. Re-reads every id from disk (path
    /// is identity), applies additions/updates/removals, and reports only ids
    /// whose resident fields actually changed — no-ops never bump the
    /// revision, so duplicate notifications (a write followed by its own
    /// watcher echo) stay silent. Every re-read's parse issues are
    /// (re)stored, so externally introduced problems surface here as they do
    /// on a full load.
    ///
    /// `shards` are directories touched by the incoming file events. Parse
    /// issues are keyed by file for nodes whose id never resolved (invalid id
    /// shape, duplicate id, ...), and such files are invisible to id-based
    /// reporting — a rename or delete of one would leave its issue stuck. For
    /// each touched shard, file-keyed issues whose file has vanished are
    /// dropped; surviving files keep their issues (their content is re-read
    /// through the ids anyway).
    pub fn apply_change(
        &mut self,
        changed: &[String],
        deleted: &[String],
        shards: &[String],
        origin: Option<Origin>,
    ) -> Result<Option<StoreChange>, RefinoError> {
        self.apply(changed, deleted, shards, origin)
    }

    // ---- write methods: validate -> persist -> re-read -> apply -> broadcast ----

    /// Create a premise node file; no grounds validation applies.
    pub fn create_premise(
        &mut self,
        opts: &CreatePremiseOptions,
    ) -> Result<WriteOutcome, StoreError> {
        let id = write_premise(&self.io, &self.refino_dir, opts, self.random.as_ref())
            .map_err(StoreError::Other)?;
        let change = self
            .apply(std::slice::from_ref(&id), &[], &[], Some(Origin::Api))
            .map_err(StoreError::Other)?;
        Ok(WriteOutcome { id, change })
    }

    /// Create a decision node file. The grounds are validated before
    /// persisting (unknown references, duplicates; a brand-new node cannot
    /// close a cycle), so rejected writes never touch the disk.
    pub fn create_decision(
        &mut self,
        opts: &CreateDecisionOptions,
    ) -> Result<WriteOutcome, StoreError> {
        let grounds = opts.grounds.clone().unwrap_or_default();
        // The id is generated by the writer when omitted; validation only
        // needs a target id that cannot be reached by existing grounds edges.
        let probe_id = opts.base.id.clone().unwrap_or_else(|| self.probe_id());
        let probe = DecisionNode {
            id: probe_id,
            summary: String::new(),
            grounds: grounds.clone(),
            exploring: None,
        };
        let issues: Vec<StoreIssue> = check_grounds_change(&self.graph, &probe, &grounds)
            .into_iter()
            .map(StoreIssue::Graph)
            .collect();
        if !issues.is_empty() {
            return Err(StoreError::Rejected(WriteRejected::new(issues)));
        }
        let id = write_decision(&self.io, &self.refino_dir, opts, self.random.as_ref())
            .map_err(StoreError::Other)?;
        let change = self
            .apply(std::slice::from_ref(&id), &[], &[], Some(Origin::Api))
            .map_err(StoreError::Other)?;
        Ok(WriteOutcome { id, change })
    }

    /// Overwrite a premise node file.
    pub fn update_premise(
        &mut self,
        id: &str,
        opts: &UpdatePremiseOptions,
    ) -> Result<WriteOutcome, StoreError> {
        self.require_entry(id, NodeType::Premise)
            .map_err(StoreError::Other)?;
        write_premise_update(&self.io, &self.refino_dir, id, opts).map_err(StoreError::Other)?;
        let change = self
            .apply(&[id.to_string()], &[], &[], Some(Origin::Api))
            .map_err(StoreError::Other)?;
        Ok(WriteOutcome {
            id: id.to_string(),
            change,
        })
    }

    /// Overwrite a decision node file. Non-empty grounds are validated before
    /// persisting (unknown references, duplicates, cycles the change would
    /// close), so rejected writes never touch the disk.
    pub fn update_decision(
        &mut self,
        id: &str,
        opts: &UpdateDecisionOptions,
    ) -> Result<WriteOutcome, StoreError> {
        let entry = self
            .require_entry(id, NodeType::Decision)
            .map_err(StoreError::Other)?;
        let node = match &entry.node.node {
            RefinoNode::Decision(d) => d.clone(),
            _ => {
                return Err(StoreError::Other(RefinoError::new(
                    IssueCode::NODE_NOT_FOUND,
                    format!("Node \"{id}\" does not exist."),
                )));
            }
        };
        if let Some(grounds) = &opts.grounds {
            let issues: Vec<StoreIssue> = check_grounds_change(&self.graph, &node, grounds)
                .into_iter()
                .map(StoreIssue::Graph)
                .collect();
            if !issues.is_empty() {
                return Err(StoreError::Rejected(WriteRejected::new(issues)));
            }
        }
        write_decision_update(&self.io, &self.refino_dir, id, opts).map_err(StoreError::Other)?;
        let change = self
            .apply(&[id.to_string()], &[], &[], Some(Origin::Api))
            .map_err(StoreError::Other)?;
        Ok(WriteOutcome {
            id: id.to_string(),
            change,
        })
    }

    /// Delete a node file. Referencing nodes are left untouched — dangling
    /// grounds surface as UNKNOWN_GROUND issues on the applied change;
    /// whether deletion may leave them behind is the caller's policy.
    pub fn delete_node(&mut self, id: &str) -> Result<WriteOutcome, StoreError> {
        remove_node_file(&self.io, &self.refino_dir, id).map_err(StoreError::Other)?;
        let change = self
            .apply(&[], &[id.to_string()], &[], Some(Origin::Api))
            .map_err(StoreError::Other)?;
        Ok(WriteOutcome {
            id: id.to_string(),
            change,
        })
    }

    // ---- internals ----

    /// The resident entry for a write target; NODE_NOT_FOUND when absent or of the other type.
    fn require_entry(&self, id: &str, node_type: NodeType) -> Result<&StoreEntry, RefinoError> {
        match self.entries.get(id) {
            Some(entry) if entry.node.node_type() == node_type => Ok(entry),
            _ => Err(RefinoError::new(
                IssueCode::NODE_NOT_FOUND,
                format!("Node \"{id}\" does not exist."),
            )),
        }
    }

    /// An id absent from the resident graph, for write-time validation probes.
    fn probe_id(&self) -> String {
        loop {
            let id = generate_id(self.random.as_ref());
            if !self.graph.nodes.contains_key(&id) {
                return id;
            }
        }
    }

    /// Full rescan; replaces every projection structure.
    fn load(&mut self) -> Result<(), RefinoError> {
        let result = load_graph(&self.io, &self.refino_dir)?;
        let mut parse_map: BTreeMap<String, Vec<StoreIssue>> = BTreeMap::new();
        for issue in result.issues {
            store_issue(&mut parse_map, StoreIssue::Storage(issue));
        }
        let mut graph_map: BTreeMap<String, Vec<StoreIssue>> = BTreeMap::new();
        for issue in validate_graph(&result.graph) {
            store_issue(&mut graph_map, StoreIssue::Graph(issue));
        }
        let entries: BTreeMap<String, StoreEntry> = result
            .graph
            .nodes
            .iter()
            .map(|(id, node)| {
                (
                    id.clone(),
                    StoreEntry {
                        node: node.clone(),
                        revision: INITIAL_REVISION,
                        mtime_ms: result.mtimes.get(id).copied().unwrap_or(0.0),
                        summary_explicit: result.summary_explicit.get(id).copied().unwrap_or(false),
                    },
                )
            })
            .collect();
        self.graph = result.graph;
        self.entries = entries;
        self.parse_issues = parse_map;
        self.graph_issues = graph_map;
        self.contents.clear();
        self.content_order.clear();
        self.sorted_ids = None;
        self.revision = INITIAL_REVISION;
        Ok(())
    }

    /// The synchronous apply half of the incremental entry; write methods call
    /// it inside their own call frame.
    fn apply(
        &mut self,
        changed: &[String],
        deleted: &[String],
        shards: &[String],
        origin: Option<Origin>,
    ) -> Result<Option<StoreChange>, RefinoError> {
        let ids: Vec<String> = {
            let mut seen = HashSet::new();
            changed
                .iter()
                .chain(deleted.iter())
                .filter(|id| seen.insert((*id).clone()))
                .cloned()
                .collect()
        };
        let touched_shards: Vec<String> = {
            let mut seen = HashSet::new();
            shards
                .iter()
                .filter(|s| seen.insert((*s).clone()))
                .cloned()
                .collect()
        };
        if ids.is_empty() && touched_shards.is_empty() {
            return Ok(None);
        }

        // Direct dependents captured before mutation: their grounds must be
        // rechecked after the change (e.g. grounds that now dangle).
        let mut affected: HashSet<String> = ids.iter().cloned().collect();
        for id in &ids {
            if let Some(children) = self.graph.nodes.get(id).map(|n| &n.children) {
                affected.extend(children.iter().cloned());
            }
        }
        let mut reads = Vec::with_capacity(ids.len());
        for id in &ids {
            reads.push(read_node(&self.io, &self.refino_dir, id)?);
        }
        let stale_file_issues = self.stale_file_issue_keys(&touched_shards)?;

        // From here on the batch applies synchronously: readers never observe
        // a half-applied batch.
        struct Applied {
            node: RefinoNode,
            content: Option<NodeContent>,
            mtime_ms: f64,
            summary_explicit: bool,
            issues: Vec<StorageIssue>,
        }
        let mut applied: Vec<Applied> = Vec::new();
        let mut removed: Vec<String> = Vec::new();
        // Pre-mutation direct dependents of removed ids — they review the removal.
        let mut removed_dependents: BTreeMap<String, Vec<String>> = BTreeMap::new();
        // Parse issues of files that produced no node (e.g. broken YAML).
        let mut orphan_issues: Vec<StorageIssue> = Vec::new();
        for (i, id) in ids.iter().enumerate() {
            let read = &reads[i];
            let existing = self.entries.get(id);
            match &read.node {
                None => {
                    if let Some(existing) = existing {
                        removed.push(id.clone());
                        removed_dependents.insert(id.clone(), existing.node.children.clone());
                    }
                    // A file that yields no node can still carry parse issues;
                    // store them unless an identical batch is already cached
                    // (no-op echoes must not bump the revision).
                    if !read.issues.is_empty() && self.parse_issues_changed(id, &read.issues) {
                        orphan_issues.extend(read.issues.clone());
                    }
                }
                Some(fresh) => {
                    let changed_resident = match existing {
                        None => true,
                        Some(existing) => {
                            !same_resident_fields(&existing.node.node, fresh)
                                || existing.mtime_ms != read.mtime_ms.unwrap_or(0.0)
                        }
                    };
                    if changed_resident {
                        applied.push(Applied {
                            node: fresh.clone(),
                            content: read.content.clone(),
                            mtime_ms: read.mtime_ms.unwrap_or(0.0),
                            summary_explicit: read.summary_explicit.unwrap_or(false),
                            issues: read.issues.clone(),
                        });
                    }
                }
            }
        }
        if applied.is_empty()
            && removed.is_empty()
            && orphan_issues.is_empty()
            && stale_file_issues.is_empty()
        {
            return Ok(None);
        }

        self.revision += 1;
        self.sorted_ids = None;
        for read in &applied {
            self.put_entry(
                read.node.clone(),
                read.content.clone(),
                read.mtime_ms,
                read.summary_explicit,
                read.issues.clone(),
            );
        }
        for id in &removed {
            self.drop_entry(id);
        }
        for key in &stale_file_issues {
            self.parse_issues.remove(key);
        }
        self.store_parse_issues(&orphan_issues);
        let affected_list: Vec<String> = affected.into_iter().collect();
        self.recheck_graph_issues(&affected_list);

        // The change's affected set: changed nodes contribute their direct
        // dependents in the new graph; removed nodes their pre-mutation ones.
        let mut change_affected: HashSet<String> = HashSet::new();
        for read in &applied {
            if let Some(children) = self.graph.nodes.get(read.node.id()).map(|n| &n.children) {
                change_affected.extend(children.iter().cloned());
            }
        }
        for dependents in removed_dependents.values() {
            change_affected.extend(dependents.iter().cloned());
        }
        let mut affected_sorted: Vec<String> = change_affected.into_iter().collect();
        affected_sorted.sort();

        let event = StoreChange {
            revision: self.revision,
            changed: applied.iter().map(|r| r.node.id().to_string()).collect(),
            deleted: removed,
            affected: affected_sorted,
            origin,
            reload: None,
        };
        self.broadcast(&event);
        Ok(Some(event))
    }

    fn put_entry(
        &mut self,
        node: RefinoNode,
        content: Option<NodeContent>,
        mtime_ms: f64,
        summary_explicit: bool,
        parse_issues: Vec<StorageIssue>,
    ) {
        // Engine primitives keep the children back-references consistent; the
        // resident record replaces summary, confirmed and grounds wholesale.
        // An id re-created as the other type (external deletion + re-creation
        // between two reads) must replace the node wholesale: update_node keeps
        // the attached type fixed.
        let id = node.id().to_string();
        match self.graph.nodes.get(&id) {
            None => {
                let _ = add_node(&mut self.graph, node.clone());
            }
            Some(existing) if existing.node_type() != node.node_type() => {
                let _ = remove_node(&mut self.graph, &id);
                let _ = add_node(&mut self.graph, node.clone());
            }
            Some(_) => {
                let _ = update_node(&mut self.graph, node.clone());
            }
        }
        let attached = self.graph.nodes.get(&id).expect("applied above");
        self.entries.insert(
            id.clone(),
            StoreEntry {
                node: attached.clone(),
                revision: self.revision,
                mtime_ms,
                summary_explicit,
            },
        );
        self.drop_parse_issues(&id);
        self.graph_issues.remove(&id);
        self.store_parse_issues(&parse_issues);
        // The freshly read content warms the LRU for the next content() read.
        if let Some(content) = content {
            self.cache_content(id, content);
        }
    }

    fn drop_entry(&mut self, id: &str) {
        if !self.entries.contains_key(id) {
            return;
        }
        let _ = remove_node(&mut self.graph, id);
        self.entries.remove(id);
        self.contents.remove(id);
        self.content_order.retain(|x| x != id);
        self.drop_parse_issues(id);
        self.graph_issues.remove(id);
    }

    /// Incremental graph-issue recheck scoped to the affected ids and their
    /// former direct dependents: per-node grounds issues come from the
    /// engine's `check_grounds_change` (a cycle must pass through an affected
    /// node, and dangling grounds only appear on nodes grounding on changed
    /// ids). Premise checks happen at the file boundary (parse issues); parse
    /// issues are re-stored from the file reads, and issues elsewhere in the
    /// graph are unaffected by the change and stay cached.
    fn recheck_graph_issues(&mut self, affected: &[String]) {
        for id in affected {
            self.graph_issues.remove(id);
            let Some(entry) = self.entries.get(id) else {
                continue;
            };
            let Some(decision) = entry.node.as_decision() else {
                continue; // edges only come from decision grounds
            };
            let decision = decision.clone();
            let found = check_grounds_change(&self.graph, &decision, &decision.grounds);
            if !found.is_empty() {
                self.graph_issues.insert(
                    id.clone(),
                    found.into_iter().map(StoreIssue::Graph).collect(),
                );
            }
        }
    }

    /// Group parse issues by node id or file and merge them into the cache.
    fn store_parse_issues(&mut self, issues: &[StorageIssue]) {
        for issue in issues {
            store_issue(&mut self.parse_issues, StoreIssue::Storage(issue.clone()));
        }
    }

    /// Drop every parse-issue entry that can relate to the id, including file-keyed ones.
    fn drop_parse_issues(&mut self, id: &str) {
        for key in candidate_files(id).into_iter().chain([id.to_string()]) {
            self.parse_issues.remove(&key);
        }
    }

    /// Whether the cached parse issues under the id's keys differ from the
    /// given fresh batch (compared by message set). Guards the revision
    /// against no-op echoes of an unchanged, unparseable file.
    fn parse_issues_changed(&self, id: &str, fresh: &[StorageIssue]) -> bool {
        let keys: HashSet<String> = candidate_files(id)
            .into_iter()
            .chain([id.to_string()])
            .collect();
        let mut cached: HashSet<String> = HashSet::new();
        for list in self.parse_issues.values() {
            for issue in list {
                if issue.node_id().map(|n| keys.contains(n)).unwrap_or(false)
                    || issue.file().map(|f| keys.contains(f)).unwrap_or(false)
                {
                    cached.insert(issue.message().to_string());
                }
            }
        }
        if cached.len() != fresh.len() {
            return true;
        }
        fresh.iter().any(|issue| !cached.contains(issue.message()))
    }

    /// File-keyed parse-issue entries whose file no longer exists, within the
    /// given shards (issue keys are node ids or `.refino`-relative file
    /// paths; only file paths live under `nodes/<shard>/`). Must run before
    /// the synchronous apply section — readers never observe a half-applied
    /// batch.
    fn stale_file_issue_keys(&self, shards: &[String]) -> Result<Vec<String>, RefinoError> {
        let mut stale: Vec<String> = Vec::new();
        for shard in shards {
            let prefix = format!("{}/{}", crate::writer::NODES_DIR, shard);
            let files: Vec<String> = match self
                .io
                .read_dir(&self.refino_dir.join(crate::writer::NODES_DIR).join(shard))
            {
                Ok(entries) => entries.into_iter().map(|e| e.name).collect(),
                Err(error) if is_enoent(&error) => Vec::new(),
                Err(error) => return Err(RefinoError::new("IO_ERROR", error.to_string())),
            };
            for key in self.parse_issues.keys() {
                if key.starts_with(&prefix) && !files.contains(&key[prefix.len()..].to_string()) {
                    stale.push(key.clone());
                }
            }
        }
        Ok(stale)
    }

    fn cache_content(&mut self, id: String, content: NodeContent) {
        self.content_order.retain(|x| x != &id);
        self.content_order.push(id.clone());
        self.contents.insert(id, content);
        if self.content_order.len() > CONTENT_CACHE_MAX {
            let oldest = self.content_order.remove(0);
            self.contents.remove(&oldest);
        }
    }

    fn touch_content(&mut self, id: &str) {
        self.content_order.retain(|x| x != id);
        self.content_order.push(id.to_string());
    }

    fn broadcast(&mut self, change: &StoreChange) {
        for handler in &mut self.subscribers {
            handler(change);
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub nodes: u64,
    pub decisions: u64,
    pub premises: u64,
    pub roots: u64,
}

/// Both candidate file paths of an id, in canonical `.refino`-relative form.
fn candidate_files(id: &str) -> Vec<String> {
    vec![
        node_relative_file(NodeType::Decision, id),
        node_relative_file(NodeType::Premise, id),
    ]
}

/// Group one issue into a keyed cache under its node id or, failing that, its file.
fn store_issue(cache: &mut BTreeMap<String, Vec<StoreIssue>>, issue: StoreIssue) {
    let key = match issue.node_id() {
        Some(node_id) => node_id.to_string(),
        None => match issue.file() {
            Some(file) => file.to_string(),
            None => return,
        },
    };
    cache.entry(key).or_default().push(issue);
}

/// Change detection over the resident fields the store tracks. Paged content
/// (body, rationale) is intentionally excluded — it is not resident, and
/// content-only external edits surface through the file mtime instead.
fn same_resident_fields(previous: &RefinoNode, read: &RefinoNode) -> bool {
    match (previous, read) {
        (RefinoNode::Premise(a), RefinoNode::Premise(b)) => {
            a.summary == b.summary && a.confirmed == b.confirmed
        }
        (RefinoNode::Decision(a), RefinoNode::Decision(b)) => {
            a.summary == b.summary
                && same_grounds(&a.grounds, &b.grounds)
                && (a.exploring == Some(true)) == (b.exploring == Some(true))
        }
        _ => false,
    }
}

fn same_grounds(a: &[String], b: &[String]) -> bool {
    a == b
}
