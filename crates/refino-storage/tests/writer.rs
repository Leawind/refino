//! Ports of packages/storage/test/writer.test.ts over the in-memory Io.

mod common;

use common::{FakeIo, SeqRandom, create_refino, decision_body_rationale};
use refino_core::{IssueCode, NodeType, RefinoError, is_valid_id, validate_graph};
use refino_storage::Io;
use refino_storage::{
    CreateDecisionOptions, CreateOptions, CreatePremiseOptions, StoreError, UpdateDecisionOptions,
    UpdateOptions, UpdatePremiseOptions, atomic_write_file, create_decision, create_premise,
    delete_node, load_graph, read_node, update_decision, update_premise,
};
use std::path::PathBuf;

fn rand() -> SeqRandom {
    SeqRandom(std::cell::Cell::new(100))
}

fn opts(body: &str) -> CreateOptions {
    CreateOptions {
        body: body.to_string(),
        id: None,
        summary: None,
    }
}

fn shard_dir_of(root: &std::path::Path, id: &str) -> PathBuf {
    root.join(".refino").join("nodes").join(&id[..2])
}

fn node_file(root: &std::path::Path, id: &str, type_name: &str) -> PathBuf {
    shard_dir_of(root, id).join(format!("{}-{type_name}.md", &id[2..]))
}

#[test]
fn create_premise_writes_body_only_file_when_no_fields_given() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: opts("PostgreSQL 16.\n"),
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    assert!(is_valid_id(&id), "{id}");
    assert_eq!(
        io.read(&node_file(&root, &id, "premise")),
        "PostgreSQL 16.\n"
    );
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    let node = loaded.graph.nodes.get(&id).expect("node");
    assert_eq!(node.node_type(), NodeType::Premise);
    assert_eq!(node.summary(), "PostgreSQL 16.");
}

#[test]
fn create_premise_serializes_confirmed_as_rfc3339() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: opts("PostgreSQL 16.\n"),
            confirmed: Some(1_777_593_600_000), // 2026-05-01T00:00:00Z
        },
        &rand(),
    )
    .unwrap();
    let source = io.read(&node_file(&root, &id, "premise"));
    assert!(source.contains("confirmed:"), "{source}");
    assert!(source.contains("2026-05-01T00:00:00.000Z"), "{source}");
    assert!(source.ends_with("PostgreSQL 16.\n"), "{source}");
}

#[test]
fn create_decision_writes_grounds_and_rationale_and_loads_back() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let premise_id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: opts("Fact."),
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Use Repository layer."),
            grounds: Some(vec![premise_id.clone()]),
            rationale: Some("Keeps DB access testable.".to_string()),
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    let node = loaded.graph.nodes.get(&id).expect("node");
    assert_eq!(node.node_type(), NodeType::Decision);
    assert_eq!(
        node.as_decision().unwrap().grounds,
        vec![premise_id.clone()]
    );
    let read = read_node(&io, &refino, &id).unwrap();
    assert_eq!(
        read.content.unwrap().rationale.as_deref(),
        Some("Keeps DB access testable.")
    );
}

#[test]
fn create_decision_omits_frontmatter_without_fields() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Root decision."),
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    let source = io.read(&node_file(&root, &id, "decision"));
    assert!(!source.contains("---"), "{source}");
    assert_eq!(source, "Root decision.\n");
}

#[test]
fn exploring_writes_only_true_and_settling_removes_the_field() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Trial."),
            grounds: None,
            rationale: None,
            exploring: true,
        },
        &rand(),
    )
    .unwrap();
    assert!(
        io.read(&node_file(&root, &id, "decision"))
            .contains("exploring: true")
    );
    let marked = load_graph(&io, &refino).unwrap();
    assert_eq!(
        marked
            .graph
            .nodes
            .get(&id)
            .unwrap()
            .as_decision()
            .unwrap()
            .exploring,
        Some(true)
    );

    // PUT-like update without the mark settles the decision: the field
    // disappears from the file instead of degrading to `exploring: false`.
    update_decision(
        &io,
        &refino,
        &id,
        &UpdateDecisionOptions {
            base: UpdateOptions {
                body: "Settled.".to_string(),
                summary: None,
            },
            grounds: None,
            rationale: None,
            exploring: false,
        },
    )
    .unwrap();
    assert!(
        !io.read(&node_file(&root, &id, "decision"))
            .contains("exploring")
    );
    let settled = load_graph(&io, &refino).unwrap();
    assert_eq!(
        settled
            .graph
            .nodes
            .get(&id)
            .unwrap()
            .as_decision()
            .unwrap()
            .exploring,
        None
    );
}

#[test]
fn never_writes_explicit_false_exploring() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Root."),
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    assert!(
        !io.read(&node_file(&root, &id, "decision"))
            .contains("exploring")
    );
}

#[test]
fn generated_ids_never_collide() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("First."),
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    let second = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Second."),
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    assert_ne!(second, id);
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(loaded.graph.nodes.len(), 2);
}

#[test]
fn creates_node_under_explicit_id() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: CreateOptions {
                body: "Explicit id.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    assert_eq!(id, "A1B2C3D4");
    assert_eq!(
        io.read(&node_file(&root, "A1B2C3D4", "decision")),
        "Explicit id.\n"
    );
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(
        loaded.graph.nodes.get("A1B2C3D4").unwrap().summary(),
        "Explicit id."
    );
}

#[test]
fn accepts_minimum_3_char_id() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: CreateOptions {
                body: "Short id.".to_string(),
                id: Some("AB1".to_string()),
                summary: None,
            },
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    assert_eq!(id, "AB1");
    assert_eq!(io.read(&node_file(&root, "AB1", "premise")), "Short id.\n");
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(
        loaded.graph.nodes.get("AB1").unwrap().summary(),
        "Short id."
    );
}

#[test]
fn rejects_bad_explicit_ids_as_invalid_id() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    for bad_id in ["short", "A-B", "a1b2c3d4", "ABCDEFGHIJKLMNOPQ"] {
        let error = create_premise(
            &io,
            &refino,
            &CreatePremiseOptions {
                base: CreateOptions {
                    body: "Body.".to_string(),
                    id: Some(bad_id.to_string()),
                    summary: None,
                },
                confirmed: None,
            },
            &rand(),
        )
        .unwrap_err();
        assert!(matches!(error, RefinoError { .. }));
        assert_eq!(error.code, IssueCode::INVALID_ID, "{bad_id}");
    }
    let _ = root;
}

#[test]
fn rejects_existing_explicit_id_as_duplicate() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: CreateOptions {
                body: "First.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    let error = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: CreateOptions {
                body: "Second.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            confirmed: None,
        },
        &rand(),
    )
    .unwrap_err();
    assert_eq!(error.code, IssueCode::DUPLICATE_ID);
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(loaded.graph.nodes.len(), 1);
}

#[test]
fn rejects_explicit_id_existing_as_other_type() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: CreateOptions {
                body: "Premise.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    let error = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: CreateOptions {
                body: "Decision.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap_err();
    assert_eq!(error.code, IssueCode::DUPLICATE_ID);
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(loaded.graph.nodes.len(), 1);
    assert_eq!(
        loaded.graph.nodes.get("A1B2C3D4").unwrap().node_type(),
        NodeType::Premise
    );
}

#[test]
fn explicit_ids_do_not_disturb_generated_collision_check() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: CreateOptions {
                body: "Explicit.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    let generated = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Generated."),
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    assert_ne!(generated, "A1B2C3D4");
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(loaded.graph.nodes.len(), 2);
}

#[test]
fn serializes_explicit_summary_into_frontmatter() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: CreateOptions {
                body: "Full decision body.".repeat(20),
                id: None,
                summary: Some("Short relevance summary.".to_string()),
            },
            grounds: None,
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    assert!(
        io.read(&node_file(&root, &id, "decision"))
            .contains("summary: Short relevance summary.")
    );
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(
        loaded.graph.nodes.get(&id).unwrap().summary(),
        "Short relevance summary."
    );
}

#[test]
fn update_premise_replaces_body_and_fields_in_place() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: CreateOptions {
                body: "Old body.".to_string(),
                id: None,
                summary: Some("Old summary.".to_string()),
            },
            confirmed: Some(1_777_689_600_000),
        },
        &rand(),
    )
    .unwrap();
    update_premise(
        &io,
        &refino,
        &id,
        &UpdatePremiseOptions {
            base: UpdateOptions {
                body: "New body.".to_string(),
                summary: Some("New summary.".to_string()),
            },
            confirmed: None,
        },
    )
    .unwrap();
    let source = io.read(&node_file(&root, &id, "premise"));
    assert!(source.contains("New body."), "{source}");
    assert!(source.contains("summary: New summary."), "{source}");
    assert!(!source.contains("confirmed"), "{source}");
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    let node = loaded.graph.nodes.get(&id).unwrap();
    assert_eq!(node.node_type(), NodeType::Premise);
    assert_eq!(node.summary(), "New summary.");
    assert_eq!(node.as_premise().unwrap().confirmed, None);
}

#[test]
fn update_decision_replaces_grounds_and_rationale() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let ground = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: opts("Fact."),
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Decision."),
            grounds: Some(vec![ground]),
            rationale: Some("Old rationale.".to_string()),
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    update_decision(
        &io,
        &refino,
        &id,
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
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    let node = loaded.graph.nodes.get(&id).unwrap();
    assert_eq!(node.node_type(), NodeType::Decision);
    assert_eq!(node.summary(), "Decision v2.");
    assert!(node.as_decision().unwrap().grounds.is_empty());
    let read = read_node(&io, &refino, &id).unwrap();
    let content = read.content.unwrap();
    assert_eq!(content.rationale, None);
    assert_eq!(content.body, "Decision v2.");
}

#[test]
fn update_and_delete_reject_missing_nodes_as_node_not_found() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let error = update_premise(
        &io,
        &refino,
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
    assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
    let error = update_decision(
        &io,
        &refino,
        "A1B2C3D4",
        &UpdateDecisionOptions {
            base: UpdateOptions {
                body: "B.".to_string(),
                summary: None,
            },
            grounds: None,
            rationale: None,
            exploring: false,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
    let error = delete_node(&io, &refino, "A1B2C3D4").unwrap_err();
    assert_eq!(error.code, IssueCode::NODE_NOT_FOUND);
    let _ = root;
}

#[test]
fn delete_rejects_invalid_ids() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    for bad_id in ["short", "a1b2c3d4"] {
        let error = delete_node(&io, &refino, bad_id).unwrap_err();
        assert_eq!(error.code, IssueCode::INVALID_ID, "{bad_id}");
    }
}

#[test]
fn delete_leaves_dangling_grounds_to_validation() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let ground_id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: CreateOptions {
                body: "Fact.".to_string(),
                id: Some("A1B2C3D4".to_string()),
                summary: None,
            },
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    let id = create_decision(
        &io,
        &refino,
        &CreateDecisionOptions {
            base: opts("Decision."),
            grounds: Some(vec![ground_id.clone()]),
            rationale: None,
            exploring: false,
        },
        &rand(),
    )
    .unwrap();
    delete_node(&io, &refino, &ground_id).unwrap();
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(!loaded.graph.nodes.contains_key(&ground_id));
    assert!(loaded.graph.nodes.contains_key(&id));
    let issues: Vec<refino_storage::StoreIssue> = loaded
        .issues
        .clone()
        .into_iter()
        .map(refino_storage::StoreIssue::Storage)
        .chain(
            validate_graph(&loaded.graph)
                .into_iter()
                .map(refino_storage::StoreIssue::Graph),
        )
        .collect();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].code(), IssueCode::UNKNOWN_GROUND);
    assert_eq!(issues[0].node_id(), Some(id.as_str()));
}

#[test]
fn create_and_update_leave_no_temp_files() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let refino = root.join(".refino");
    let id = create_premise(
        &io,
        &refino,
        &CreatePremiseOptions {
            base: opts("First."),
            confirmed: None,
        },
        &rand(),
    )
    .unwrap();
    update_premise(
        &io,
        &refino,
        &id,
        &UpdatePremiseOptions {
            base: UpdateOptions {
                body: "Second.".to_string(),
                summary: None,
            },
            confirmed: None,
        },
    )
    .unwrap();
    let shard = shard_dir_of(&root, &id);
    let stray: Vec<_> = io
        .read_dir(&shard)
        .unwrap()
        .into_iter()
        .filter(|e| !e.name.ends_with(".md"))
        .collect();
    assert!(stray.is_empty(), "{stray:?}");
    assert_eq!(io.read(&node_file(&root, &id, "premise")), "Second.\n");
}

#[test]
fn atomic_write_removes_temp_when_rename_fails() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let dir = root.join(".refino").join("nodes").join("A1");
    io.create_dir_all(&dir).unwrap();
    // A directory occupying the target path makes the rename fail.
    io.insert_dir(&dir.join("B2C3D4-premise.md"));
    io.fail_rename_times(9); // exceeds all retries
    let error = atomic_write_file(&io, &dir.join("B2C3D4-premise.md"), "Body.\n");
    assert!(error.is_err());
    let names: Vec<String> = io
        .read_dir(&dir)
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, vec!["B2C3D4-premise.md".to_string()]);
}

#[test]
fn atomic_write_retries_transient_rename_failures() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let dir = root.join(".refino").join("nodes").join("A1");
    io.create_dir_all(&dir).unwrap();
    // Two transient failures then success: the Windows backoff loop.
    io.fail_rename_times(2);
    atomic_write_file(&io, &dir.join("B2C3D4-premise.md"), "Body.\n").unwrap();
    assert_eq!(io.rename_calls(), 3);
    assert_eq!(io.sleeps(), 10 + 20); // 10ms * attempt, twice
    assert_eq!(io.read(&dir.join("B2C3D4-premise.md")), "Body.\n");
}

#[test]
fn atomic_write_replaces_and_leaves_no_temp() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let shard = root.join(".refino").join("nodes").join("A1");
    let file = shard.join("B2C3D4-premise.md");
    io.create_dir_all(&shard).unwrap();
    atomic_write_file(&io, &file, "Old.\n").unwrap();
    atomic_write_file(&io, &file, "New.\n").unwrap();
    assert_eq!(io.read(&file), "New.\n");
    let stray: Vec<_> = io
        .read_dir(&shard)
        .unwrap()
        .into_iter()
        .filter(|e| !e.name.ends_with(".md"))
        .collect();
    assert!(stray.is_empty());
}

#[test]
fn loader_ignores_stray_temp_files_from_interrupted_writes() {
    let io = FakeIo::new();
    let refino_relative = "nodes/A1/B2C3D4-premise.md";
    let root = create_refino(&io, &[(refino_relative, "Kept.\n")]);
    let refino = root.join(".refino");
    // What a crashed process would leave behind (written, never renamed).
    io.seed_file(
        refino.join("nodes/A1/B2C3D4-premise.md.4242-0.tmp"),
        "half-written",
    );
    let loaded = load_graph(&io, &refino).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(loaded.graph.nodes.len(), 1);
    assert_eq!(
        loaded.graph.nodes.get("A1B2C3D4").unwrap().summary(),
        "Kept."
    );
}

#[test]
fn decision_body_rationale_helper_produces_parseable_fixture() {
    let text = decision_body_rationale("A1B2C3D4", &["1A2B3C4D"], "Body.", "Because.");
    let parsed = refino_storage::parse_node_source(
        "A1B2C3D4",
        "nodes/A1/B2C3D4-decision.md",
        NodeType::Decision,
        &text,
    );
    assert!(parsed.issues.is_empty(), "{:?}", parsed.issues);
    assert_eq!(
        parsed.content.unwrap().rationale.as_deref(),
        Some("Because.")
    );
}

#[test]
fn store_error_display_carries_the_message() {
    let error = RefinoError::new(IssueCode::INVALID_ID, "boom");
    let store_error = StoreError::Other(error);
    assert_eq!(store_error.to_string(), "boom");
}
