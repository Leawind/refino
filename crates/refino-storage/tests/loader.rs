//! Ports of packages/storage/test/loader.test.ts and locate.test.ts.

mod common;

use common::{FakeIo, create_refino, premise_body};
use refino_core::IssueCode;
use refino_storage::Io;
use refino_storage::{StorageIssueCode, find_refino_dir, load_graph, read_node};
use std::path::{Path, PathBuf};

fn refino_of(root: &Path) -> PathBuf {
    root.join(".refino")
}

#[test]
fn derives_id_from_shard_and_file_name() {
    let io = FakeIo::new();
    let (file, body) = premise_body("A1B2C3D4", "Fact.\n");
    let root = create_refino(&io, &[(&file, &body)]);
    let loaded = load_graph(&io, &refino_of(&root)).unwrap();
    assert!(loaded.issues.is_empty());
    assert!(loaded.graph.nodes.contains_key("A1B2C3D4"));
    assert_eq!(
        loaded.graph.nodes.get("A1B2C3D4").unwrap().node_type(),
        refino_core::NodeType::Premise
    );
}

#[test]
fn reports_cross_type_duplicate_ids() {
    let io = FakeIo::new();
    let root = create_refino(
        &io,
        &[
            ("nodes/A1/B2C3D4-premise.md", "Premise.\n"),
            ("nodes/A1/B2C3D4-decision.md", "Decision.\n"),
        ],
    );
    let loaded = load_graph(&io, &refino_of(&root)).unwrap();
    // decision sorts before premise, so the decision wins and the premise is
    // reported as duplicate.
    assert_eq!(loaded.issues.len(), 1);
    assert_eq!(loaded.issues[0].code(), IssueCode::DUPLICATE_ID);
    assert!(loaded.graph.nodes.contains_key("A1B2C3D4"));
    assert_eq!(
        loaded.graph.nodes.get("A1B2C3D4").unwrap().node_type(),
        refino_core::NodeType::Decision
    );
}

#[test]
fn single_node_read_agrees_with_full_load_on_duplicates() {
    let io = FakeIo::new();
    let root = create_refino(
        &io,
        &[
            ("nodes/A1/B2C3D4-premise.md", "Premise.\n"),
            ("nodes/A1/B2C3D4-decision.md", "Decision.\n"),
        ],
    );
    let read = read_node(&io, &refino_of(&root), "A1B2C3D4").unwrap();
    assert_eq!(
        read.node.unwrap().node_type(),
        refino_core::NodeType::Decision
    );
    assert_eq!(read.issues[0].code(), IssueCode::DUPLICATE_ID);
}

#[test]
fn ignores_directories_that_are_not_valid_shards() {
    let io = FakeIo::new();
    let root = create_refino(
        &io,
        &[
            ("nodes/zz/B2C3D4-premise.md", "Ignored lowercase.\n"),
            ("nodes/AB/C3D4E5F6-premise.md", "Kept.\n"),
        ],
    );
    let loaded = load_graph(&io, &refino_of(&root)).unwrap();
    assert!(loaded.issues.is_empty());
    assert_eq!(loaded.graph.nodes.len(), 1);
    assert!(loaded.graph.nodes.contains_key("ABC3D4E5F6"));
}

#[test]
fn errors_when_refino_dir_missing() {
    let io = FakeIo::new();
    let error = load_graph(&io, Path::new("/nowhere/.refino")).unwrap_err();
    assert_eq!(error.code, StorageIssueCode::REFINO_DIR_NOT_FOUND);
}

#[test]
fn missing_nodes_dir_is_an_empty_graph() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    let loaded = load_graph(&io, &refino_of(&root)).unwrap();
    assert!(loaded.issues.is_empty());
    assert!(loaded.graph.nodes.is_empty());
}

#[test]
fn stray_markdown_at_nodes_top_is_invalid_node_path() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[("nodes/stray.md", "Body.\n")]);
    let loaded = load_graph(&io, &refino_of(&root)).unwrap();
    assert_eq!(loaded.issues.len(), 1);
    assert_eq!(loaded.issues[0].code(), StorageIssueCode::INVALID_NODE_PATH);
    assert!(loaded.graph.nodes.is_empty());
}

#[test]
fn id_failing_engine_rule_is_reported() {
    let io = FakeIo::new();
    // "zz" shard would fail the shard rule; use a valid shard whose id2 makes
    // the full id too long (>16 chars) -> INVALID_ID.
    let root = create_refino(&io, &[("nodes/AB/cdefghijklmnopq-premise.md", "Body.\n")]);
    let loaded = load_graph(&io, &refino_of(&root)).unwrap();
    // lowercase shard "cd..."? The shard must be [A-Z0-9_]{2}; "AB" is valid
    // but id2 "cdefghijklmnopq" is lowercase -> the full id fails the rule.
    assert_eq!(loaded.issues.len(), 1);
    assert_eq!(loaded.issues[0].code(), IssueCode::INVALID_ID);
}

// ---- locate ----

#[test]
fn locate_finds_nearest_ancestor_refino() {
    let io = FakeIo::new();
    let root = create_refino(&io, &[]);
    io.create_dir_all(&root.join("deep").join("nested"))
        .unwrap();
    assert_eq!(
        find_refino_dir(&io, &root.join("deep").join("nested")),
        Some(root.join(".refino"))
    );
    assert_eq!(find_refino_dir(&io, &root), Some(root.join(".refino")));
}

#[test]
fn locate_returns_none_without_refino() {
    let io = FakeIo::new();
    io.create_dir_all(Path::new("/bare")).unwrap();
    assert_eq!(find_refino_dir(&io, Path::new("/bare")), None);
}

#[test]
fn locate_walks_to_the_filesystem_root_without_looping() {
    let io = FakeIo::new();
    assert_eq!(find_refino_dir(&io, Path::new("/deep/tree")), None);
}

#[test]
fn deterministic_random_gives_distinct_ids() {
    // The SeqRandom helper must produce distinct fill results per call, or
    // id-collision loops in create_node would spin forever.
    use common::SeqRandom;
    use refino_core::generate_id;
    let random = SeqRandom(std::cell::Cell::new(0));
    let seen: std::collections::HashSet<String> = (0..50).map(|_| generate_id(&random)).collect();
    assert_eq!(seen.len(), 50);
}
