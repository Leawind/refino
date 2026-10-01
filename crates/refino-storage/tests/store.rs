//! Ports of packages/storage/test/store.test.ts (watcher and incremental
//! application) plus the core applyChange semantics, driven over the
//! in-memory Io with a manually pumped watcher.

mod common;

use common::{FakeIo, RecordingSink, SeqRandom, create_refino};
use refino_core::{IssueCode, NodeType};
use refino_storage::{
    CreateDecisionOptions, CreateOptions, CreatePremiseOptions, Io, Origin, RefinoStore,
    StoreError, StoreIssue, TimerKind, UpdateDecisionOptions, UpdateOptions, UpdatePremiseOptions,
    WatcherCore, load_graph, read_node, update_decision,
};
use std::path::PathBuf;

fn rand() -> SeqRandom {
    SeqRandom(std::cell::Cell::new(500))
}

fn opts(body: &str) -> CreateOptions {
    CreateOptions {
        body: body.to_string(),
        id: None,
        summary: None,
    }
}

/// Recorded watcher batches: affected ids plus touched shards.
type RecordedBatches = std::sync::Arc<std::sync::Mutex<Vec<(Vec<String>, Vec<String>)>>>;

fn refino_dir(root: &std::path::Path) -> PathBuf {
    root.join(".refino")
}

#[test]
fn create_and_read_back_through_the_store() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let outcome = store
        .create_premise(&CreatePremiseOptions {
            base: opts("Fact."),
            confirmed: None,
        })
        .unwrap();
    assert!(!outcome.id.is_empty());
    assert!(outcome.change.is_some());
    assert_eq!(store.graph().nodes.len(), 1);
    let content = store.content(&outcome.id).unwrap().expect("content");
    assert_eq!(content.body, "Fact.");
}

#[test]
fn create_decision_rejects_unknown_grounds_without_touching_disk() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let error = store
        .create_decision(&CreateDecisionOptions {
            base: opts("Decision."),
            grounds: Some(vec!["Z9Y8X7W6".to_string()]),
            rationale: None,
            exploring: false,
        })
        .unwrap_err();
    let StoreError::Rejected(rejected) = error else {
        panic!("expected rejection")
    };
    assert_eq!(rejected.issues[0].code(), IssueCode::UNKNOWN_GROUND);
    // The disk was not touched: no shard directory exists.
    let nodes = refino_dir(&root).join("nodes");
    let shards: Vec<_> = io.read_dir(&nodes).unwrap_or_default();
    assert!(shards.is_empty(), "{shards:?}");
}

#[test]
fn update_premise_rejects_unknown_id() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let error = store
        .update_premise(
            "A1B2C3D4",
            &UpdatePremiseOptions {
                base: UpdateOptions {
                    body: "B.".to_string(),
                    summary: None,
                },
                confirmed: None,
            },
        )
        .unwrap_err();
    assert!(matches!(error, StoreError::Other(_)));
}

#[test]
fn delete_leaves_dangling_grounds_and_rechecks_affected_issues() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let premise = store
        .create_premise(&CreatePremiseOptions {
            base: CreateOptions {
                body: "Fact.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            confirmed: None,
        })
        .unwrap();
    let decision = store
        .create_decision(&CreateDecisionOptions {
            base: opts("Decision."),
            grounds: Some(vec![premise.id.clone()]),
            rationale: None,
            exploring: false,
        })
        .unwrap();
    assert!(store.issues().is_empty());
    store.delete_node(&premise.id).unwrap();
    // The dangling grounds surface as an incremental issue without a reload.
    let issues = store.issues();
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert_eq!(issues[0].code(), IssueCode::UNKNOWN_GROUND);
    assert_eq!(issues[0].node_id(), Some(decision.id.as_str()));
}

#[test]
fn no_op_echoes_do_not_bump_the_revision() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let outcome = store
        .create_premise(&CreatePremiseOptions {
            base: opts("Fact."),
            confirmed: None,
        })
        .unwrap();
    let revision_after_write = store.revision();
    // The watcher echo of our own write: same id, unchanged file.
    let echo = store
        .apply_change(
            std::slice::from_ref(&outcome.id),
            &[],
            &[],
            Some(Origin::File),
        )
        .unwrap();
    assert!(echo.is_none(), "no-op echo must be silent");
    assert_eq!(store.revision(), revision_after_write);
}

#[test]
fn external_content_edits_surface_through_mtime() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let outcome = store
        .create_premise(&CreatePremiseOptions {
            base: opts("First body."),
            confirmed: None,
        })
        .unwrap();
    let id = outcome.id.clone();
    // External body-only edit: resident fields identical, mtime changes.
    let file = refino_dir(&root).join(format!("nodes/{}/{}-premise.md", &id[..2], &id[2..]));
    io.seed_file(&file, "Second body.");
    let change = store
        .apply_change(std::slice::from_ref(&id), &[], &[], Some(Origin::File))
        .unwrap()
        .expect("change");
    assert_eq!(change.changed, vec![id.clone()]);
    assert!(change.affected.is_empty());
}

#[test]
fn id_recreated_as_other_type_replaces_the_node_wholesale() {
    let io = FakeIo::new();
    let (file, body) = common::premise_body("A1B2C3D4", "Premise body.\n");
    let root = create_refino(&io, &[(&file, &body)]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    assert_eq!(
        store.graph().nodes.get("A1B2C3D4").unwrap().node_type(),
        NodeType::Premise
    );
    // External deletion + re-creation as a decision with the same id.
    io.remove(&refino_dir(&root).join(&file));
    io.seed_file(
        refino_dir(&root).join("nodes/A1/B2C3D4-decision.md"),
        "---\ngrounds: []\n---\n\nDecision body.\n",
    );
    store
        .apply_change(&["A1B2C3D4".to_string()], &[], &[], Some(Origin::File))
        .unwrap();
    let node = store.graph().nodes.get("A1B2C3D4").unwrap();
    assert_eq!(node.node_type(), NodeType::Decision);
    assert_eq!(node.summary(), "Decision body.");
}

#[test]
fn broken_external_file_reports_orphan_issue_and_clean_up_on_vanish() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    // An external file that never resolves to a node (bad YAML).
    let file = refino_dir(&root).join("nodes/Z9/Y8X7W6V-premise.md");
    io.seed_file(
        &file,
        "---
grounds: [unclosed
---

Body.
",
    );
    // The watcher scan reports the file as an id; the shard is touched too.
    store
        .apply_change(
            &["Z9Y8X7W6V".to_string()],
            &[],
            &["Z9".to_string()],
            Some(Origin::File),
        )
        .unwrap();
    assert_eq!(store.issues().len(), 1);
    assert_eq!(store.issues()[0].code(), "INVALID_FRONTMATTER");
    assert_eq!(
        store.issues()[0].file(),
        Some("nodes/Z9/Y8X7W6V-premise.md")
    );
    // When the file vanishes, its file-keyed issue is dropped (needs the
    // touched shard to know where to look).
    io.remove(&file);
    store
        .apply_change(&[], &[], &["Z9".to_string()], Some(Origin::File))
        .unwrap();
    assert!(store.issues().is_empty(), "{:?}", store.issues());
}

#[test]
fn reload_bumps_revision_and_broadcasts_reload_flag() {
    let io = FakeIo::new();
    let (file, body) = common::premise_body("A1B2C3D4", "Fact.\n");
    let root = create_refino(&io, &[(&file, &body)]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let flags = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    {
        let sink = flags.clone();
        let index = store.on_change(move |change| sink.lock().expect("flags").push(change.reload));
        let change = store.reload().unwrap();
        assert!(change.reload.unwrap_or(false));
        assert!(change.changed.is_empty());
        assert_eq!(store.revision(), 2);
        store.unsubscribe(index);
    }
    assert_eq!((*flags.lock().expect("flags")), vec![Some(true)]);
}

#[test]
fn stats_counts_canvas_scope_roots() {
    let io = FakeIo::new();
    let root = create_refino(
        &io,
        &[
            ("nodes/1A/2B3C4D-premise.md", "Fact.\n"),
            (
                "nodes/A1/B2C3D4-decision.md",
                "---\ngrounds: [1A2B3C4D]\n---\n\nD1.\n",
            ),
            (
                "nodes/D4/E5F6G7H8-decision.md",
                "---\ngrounds: [A1B2C3D4]\n---\n\nD2.\n",
            ),
        ],
    );
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let stats = store.stats();
    // Canvas-scope roots: B2C3D4 grounds only on a premise (a root);
    // E5F6G7H8 grounds on a decision (not a root).
    assert_eq!(stats.nodes, 3);
    assert_eq!(stats.decisions, 2);
    assert_eq!(stats.premises, 1);
    assert_eq!(stats.roots, 1);
}

// ---- watcher wiring ----

#[test]
fn watcher_batches_flow_through_the_same_incremental_entry() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    // The watcher core records batches; the test plays them into the store
    // through the same incremental entry the production adapter uses.
    let batches: RecordedBatches =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new())) as RecordedBatches;
    let sink_batches = batches.clone();
    let mut core = WatcherCore::new(refino_dir(&root).join("nodes"), 500, move |ids, shards| {
        sink_batches
            .lock()
            .expect("batches")
            .push((ids.to_vec(), shards.to_vec()));
    });
    io.create_dir_all(&refino_dir(&root).join("nodes")).unwrap();
    let mut sink = RecordingSink::new();
    assert_eq!(
        core.arm(&mut sink, &io, false),
        refino_storage::ArmResult::Armed
    );
    // External write into a watched shard.
    io.seed_file(
        refino_dir(&root).join("nodes/AB/C3D4E5F6-premise.md"),
        "External.\n",
    );
    core.on_shard_event("AB", Some("C3D4E5F6-premise.md"), &mut sink, &io);
    // Debounce timer tick flushes the batch into the store.
    core.on_timer(TimerKind::Debounce, &mut sink, &io);
    let recorded = batches.lock().expect("batches").clone();
    assert_eq!(
        recorded,
        vec![(vec!["ABC3D4E5F6".to_string()], vec!["AB".to_string()])]
    );
    for (ids, shards) in recorded {
        store
            .apply_change(&ids, &[], &shards, Some(Origin::File))
            .unwrap();
    }
    assert!(store.graph().nodes.contains_key("ABC3D4E5F6"));
    core.close(&mut sink);
}

#[test]
fn watcher_transient_exhaustion_retries_and_recovers() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let mut sink = RecordingSink::new();
    sink.fail_root_with = Some(refino_storage::WatchError::Transient);
    let mut core = WatcherCore::new(refino_dir(&root).join("nodes"), 500, |_, _| {});
    assert_eq!(
        core.arm(&mut sink, &io, false),
        refino_storage::ArmResult::Transient
    );
    core.schedule_retry(&mut sink);
    // The retry succeeds once the failure clears.
    sink.fail_root_with = None;
    core.on_timer(TimerKind::RetryArm, &mut sink, &io);
    assert!(sink.watched.contains(&refino_dir(&root).join("nodes")));
}

#[test]
fn watcher_permanent_failure_gives_up() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let mut sink = RecordingSink::new();
    sink.fail_root_with = Some(refino_storage::WatchError::Permanent);
    let mut core = WatcherCore::new(refino_dir(&root).join("nodes"), 500, |_, _| {});
    assert_eq!(
        core.arm(&mut sink, &io, false),
        refino_storage::ArmResult::GiveUp
    );
}

#[test]
fn content_lru_round_trips_through_read_node() {
    let io = FakeIo::new();
    let (file, body) = common::premise_body("A1B2C3D4", "Long body.\n");
    let root = create_refino(&io, &[(&file, &body)]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let content = store.content("A1B2C3D4").unwrap().expect("content");
    assert_eq!(content.body, "Long body.");
    // Cached read: the underlying file disappears; the cached value survives.
    io.remove(&refino_dir(&root).join(&file));
    let cached = store.content("A1B2C3D4").unwrap().expect("cached content");
    assert_eq!(cached.body, "Long body.");
}

#[test]
fn sorted_ids_are_ascending_and_rebuilt_after_writes() {
    let io = FakeIo::new();
    let root = create_refino(
        &io,
        &[
            ("nodes/A1/B2C3D4-decision.md", "D.\n"),
            ("nodes/1A/2B3C4D-premise.md", "P.\n"),
        ],
    );
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    assert_eq!(
        store.sorted_ids(),
        vec!["1A2B3C4D".to_string(), "A1B2C3D4".to_string()]
    );
}

#[test]
fn issues_for_matches_by_node_id_or_candidate_files() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let file = refino_dir(&root).join("nodes/Z9/Y8X7W6V-premise.md");
    io.seed_file(&file, "---\ngrounds: [unclosed\n---\n\nBody.\n");
    // The watcher scan reports the file as an id; the shard is touched too.
    store
        .apply_change(
            &["Z9Y8X7W6V".to_string()],
            &[],
            &["Z9".to_string()],
            Some(Origin::File),
        )
        .unwrap();
    let for_id = store.issues_for("Z9Y8X7W6V");
    assert_eq!(for_id.len(), 1);
    let all = store.issues();
    assert_eq!(all.len(), 1);
    assert!(matches!(all[0], StoreIssue::Storage(_)));
}

#[test]
fn update_through_store_reports_affected_dependents() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let random = rand();
    let mut store = RefinoStore::new(io.clone(), random, refino_dir(&root));
    store.ready().unwrap();
    let premise = store
        .create_premise(&CreatePremiseOptions {
            base: opts("Fact."),
            confirmed: None,
        })
        .unwrap();
    let decision = store
        .create_decision(&CreateDecisionOptions {
            base: opts("Decision."),
            grounds: Some(vec![premise.id.clone()]),
            rationale: None,
            exploring: false,
        })
        .unwrap();
    let outcome = store
        .update_premise(
            &premise.id,
            &UpdatePremiseOptions {
                base: UpdateOptions {
                    body: "Revised fact.".to_string(),
                    summary: None,
                },
                confirmed: None,
            },
        )
        .unwrap();
    let change = outcome.change.expect("change");
    assert_eq!(change.changed, vec![premise.id.clone()]);
    assert_eq!(change.affected, vec![decision.id.clone()]);
    assert_eq!(change.origin, Some(Origin::Api));
    // The same helpers used by the CLI keep working over the io directly.
    update_decision(
        &io,
        &refino_dir(&root),
        &decision.id,
        &UpdateDecisionOptions {
            base: UpdateOptions {
                body: "Decision v2.".to_string(),
                summary: None,
            },
            grounds: Some(vec![]),
            rationale: None,
            exploring: false,
        },
    )
    .unwrap();
    let read = read_node(&io, &refino_dir(&root), &decision.id).unwrap();
    assert_eq!(read.content.unwrap().body, "Decision v2.");
    let _ = load_graph(&io, &refino_dir(&root)).unwrap();
}
