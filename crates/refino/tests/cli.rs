//! Ports of packages/cli/test/cli.test.ts: command contracts over a real
//! temporary directory (the CLI binds to the native filesystem).

use refino::format::CaptureSink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

/// Pair helper so fixture arrays can mix static and built bodies.
fn file(path: &str, body: &str) -> (String, String) {
    (path.to_string(), body.to_string())
}

/// Create a `.refino/` fixture under a fresh temp root.
fn create_refino(files: &[(String, String)]) -> PathBuf {
    let n = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("refino-cli-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for (relative, content) in files {
        let path = root.join(".refino").join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    root
}

fn remove_refino(root: &Path) {
    let _ = std::fs::remove_dir_all(root);
}

/// A premise node file body at its canonical path.
fn premise_body(id: &str, summary: &str) -> (String, String) {
    (
        format!("nodes/{}/{}-premise.md", &id[..2], &id[2..]),
        format!("{summary}\n"),
    )
}

/// A decision node file body with grounds frontmatter.
fn decision_body(_id: &str, grounds: &[&str], summary: &str) -> String {
    if grounds.is_empty() {
        format!("{summary}\n")
    } else {
        let list: Vec<String> = grounds.iter().map(|g| format!("\"{g}\"")).collect();
        format!("---\ngrounds: [{}]\n---\n\n{summary}\n", list.join(", "))
    }
}

fn run(argv: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let mut sink = CaptureSink::default();
    let code = refino::run(&args, &mut sink);
    (code, sink.out, sink.err)
}

fn root_arg(root: &Path) -> String {
    root.to_string_lossy().to_string()
}

#[test]
fn validate_succeeds_on_a_valid_graph() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "当前 PostgreSQL 版本不支持 extension X。"),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "所有业务数据存储在 PostgreSQL。"),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body(
                "D4E5F6G7",
                &["A1B2C3D4"],
                "数据访问必须通过 Repository 层。",
            ),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body(
                "E5F6G7H8",
                &["1A2B3C4D", "D4E5F6G7"],
                "不使用 extension X，改用手写 SQL。",
            ),
        ),
    ]);
    let (code, out, _) = run(&["--root", root_arg(&root).as_str(), "validate"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.contains("valid: 3 decisions, 1 premises"), "{out}");
}

#[test]
fn validate_reports_cycles_with_exit_code_1() {
    let root = create_refino(&[
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &["B2C3D4E5"], "A."),
        ),
        file(
            "nodes/B2/C3D4E5-decision.md",
            &decision_body("B2C3D4E5", &["A1B2C3D4"], "B."),
        ),
    ]);
    let (code, out, _) = run(&["--root", root_arg(&root).as_str(), "validate"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(out.contains("[CYCLE]"), "{out}");
    assert!(out.contains("A1B2C3D4 -> B2C3D4E5 -> A1B2C3D4"), "{out}");
}

#[test]
fn fails_with_clear_error_when_refino_missing() {
    let root = create_refino(&[]);
    let (code, _, err) = run(&["--root", root_arg(&root).as_str(), "list"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.contains("No .refino directory found"), "{err}");
    assert!(err.contains("refino init"), "{err}");
}

#[test]
fn write_commands_refuse_to_adopt() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.contains("refino init"), "{err}");
}

#[test]
fn list_prints_table_and_supports_type() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "list"]);
    assert_eq!(code, 0);
    assert!(out.contains("E5F6G7H8"), "{out}");
    assert!(out.contains("1A2B3C4D"), "{out}");

    let (code, out, _) = run(&["--root", r.as_str(), "list", "--type", "premise"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.contains("1A2B3C4D"), "{out}");
    assert!(!out.contains("E5F6G7H8"), "{out}");
}

#[test]
fn list_orders_upstream_before_downstream() {
    let root = create_refino(&[
        file(
            "nodes/AA/A1111BB-decision.md",
            &decision_body("AAA1111BB", &["ZZZ9999YX"], "下游决策。"),
        ),
        file(
            "nodes/ZZ/Z9999YX-decision.md",
            &decision_body("ZZZ9999YX", &[], "上游决策。"),
        ),
    ]);
    let (code, out, _) = run(&["--root", root_arg(&root).as_str(), "list"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    let rows: Vec<&str> = out
        .lines()
        .filter(|l| l.contains("AAA1111BB") || l.contains("ZZZ9999YX"))
        .collect();
    assert_eq!(rows.len(), 2, "{out}");
    assert!(rows[0].contains("ZZZ9999YX"), "{out}");
    assert!(rows[1].contains("AAA1111BB"), "{out}");
}

#[test]
fn show_prints_the_full_record() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body(
                "E5F6G7H8",
                &["1A2B3C4D", "D4E5F6G7"],
                "不使用 extension X，改用手写 SQL。",
            ),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "show", "E5F6G7H8"]);
    assert_eq!(code, 0);
    assert!(
        out.contains("decisions(id=E5F6G7H8, grounds=[1A2B3C4D, D4E5F6G7])"),
        "{out}"
    );
    assert!(out.contains("不使用 extension X，改用手写 SQL。"), "{out}");

    let (_, out, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    remove_refino(&root);
    assert!(out.contains("premises(id=1A2B3C4D)"), "{out}");
}

#[test]
fn show_labels_summary_rationale_and_confirmed() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    let (code, _, err) = run(&["--root", r.as_str(), "init"]);
    assert_eq!(code, 0, "{err}");
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
        "--summary",
        "A premise summary.",
        "--confirmed",
        "2026-05-01T00:00:00Z",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D",
        "--rationale",
        "Because of the fact.",
        "--summary",
        "A decision summary.",
    ]);

    let (_, out, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    assert!(out.contains("summary: A decision summary."), "{out}");
    assert!(out.contains("rationale: Because of the fact."), "{out}");
    assert!(!out.contains("confirmed:"), "{out}");

    let (_, out, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    remove_refino(&root);
    assert!(out.contains("summary: A premise summary."), "{out}");
    assert!(out.contains("confirmed: 2026-05-01T00:00:00.000Z"), "{out}");
    assert!(!out.contains("rationale:"), "{out}");
}

#[test]
fn list_unreferenced_lists_only_ungrounded_premises() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Unreferenced fact."),
        premise_body("2B3C4D5E", "Referenced fact."),
        file(
            "nodes/C1/234567-decision.md",
            &decision_body("C1234567", &["2B3C4D5E"], "Decision."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "list", "--unreferenced"]);
    assert_eq!(code, 0);
    assert!(out.contains("1A2B3C4D"), "{out}");
    assert!(!out.contains("2B3C4D5E"), "{out}");
    assert!(!out.contains("C1234567"), "{out}");

    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "list",
        "--type",
        "premise",
        "--unreferenced",
    ]);
    assert_eq!(code, 0);
    assert!(out.contains("1A2B3C4D"), "{out}");

    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "list",
        "--type",
        "decision",
        "--unreferenced",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(
        err.contains("--unreferenced only applies to premises"),
        "{err}"
    );
}

#[test]
fn update_changes_only_given_fields_and_replaces_grounds() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "2B3C4D5E",
        "--body",
        "Other fact.",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D",
        "--rationale",
        "Because.",
        "--summary",
        "A summary.",
    ]);

    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "update",
        "D4E5F6G7",
        "--body",
        "New decision.",
        "--grounds",
        "2B3C4D5E",
    ]);
    assert_eq!(code, 0);
    assert!(out.contains("updated D4E5F6G7"), "{out}");

    let (_, out, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    assert!(out.contains("grounds=[2B3C4D5E]"), "{out}");
    assert!(out.contains("summary: A summary."), "{out}");
    assert!(out.contains("rationale: Because."), "{out}");
    assert!(out.contains("New decision."), "{out}");

    // premise field update via --now
    let (code, _, _) = run(&["--root", r.as_str(), "update", "1A2B3C4D", "--now"]);
    assert_eq!(code, 0);
    let (_, out, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    remove_refino(&root);
    // Confirmed is stored as epoch milliseconds and rendered as RFC 3339.
    let confirmed_line = out
        .lines()
        .find(|l| l.contains("confirmed:"))
        .expect("confirmed line");
    let date = confirmed_line.trim_start_matches("confirmed: ");
    assert!(
        date.len() >= 10 && date.as_bytes()[4] == b'-',
        "{confirmed_line}"
    );
}

#[test]
fn update_keeps_body_derived_summary_derived() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--body",
        "Changed fact.",
    ]);
    assert_eq!(code, 0);
    let source = std::fs::read_to_string(
        root.join(".refino")
            .join("nodes")
            .join("1A")
            .join("2B3C4D-premise.md"),
    )
    .unwrap();
    remove_refino(&root);
    assert!(!source.contains("summary:"), "{source}");
}

#[test]
fn update_rejects_missing_nodes_and_empty_edits() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);

    let (code, _, err) = run(&["--root", r.as_str(), "update", "D4E5F6G7", "--body", "x"]);
    assert_eq!(code, 1);
    assert!(err.contains("not found"), "{err}");

    let (code, _, err) = run(&["--root", r.as_str(), "update", "1A2B3C4D"]);
    assert_eq!(code, 1);
    assert!(err.contains("at least one field"), "{err}");

    // Misplaced options are silently ignored (docs/design.md, "存储格式容错").
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--rationale",
        "x",
    ]);
    assert_eq!(code, 0);

    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--confirmed",
        "2026-05-01",
    ]);
    assert_eq!(code, 1);
    assert!(err.contains("RFC 3339"), "{err}");

    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D",
    ]);
    let (code, _, _) = run(&["--root", r.as_str(), "update", "D4E5F6G7", "--now"]);
    assert_eq!(code, 0);

    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "update",
        "D4E5F6G7",
        "--grounds",
        "1A2B3C4D,2B3C4D5E",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.contains("[UNKNOWN_GROUND]"), "{err}");
}

#[test]
fn new_exploring_persists_and_show_labels_it() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "A1B2C3D4",
        "--body",
        "试行决策。",
        "--exploring",
    ]);
    assert_eq!(code, 0);
    let source = std::fs::read_to_string(
        root.join(".refino")
            .join("nodes")
            .join("A1")
            .join("B2C3D4-decision.md"),
    )
    .unwrap();
    assert!(source.contains("exploring: true"), "{source}");
    let (_, out, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    remove_refino(&root);
    assert!(out.contains("exploring: true"), "{out}");
    assert!(!out.contains("(derived)"), "{out}");
}

#[test]
fn update_tri_states_the_mark_and_derives_effect() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "A1B2C3D4",
        "--body",
        "上游决策。",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "下游细化。",
        "--grounds",
        "A1B2C3D4",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "E5F6G7H8",
        "--body",
        "无关决策。",
    ]);

    // Marking the upstream explores the downstream too (derived, no stored mark).
    let (code, _, _) = run(&["--root", r.as_str(), "update", "A1B2C3D4", "--exploring"]);
    assert_eq!(code, 0);
    let (_, list, _) = run(&["--root", r.as_str(), "list"]);
    assert!(list.contains("[探索] 上游决策。"), "{list}");
    assert!(list.contains("[探索] 下游细化。"), "{list}");
    assert!(!list.contains("[探索] 无关决策。"), "{list}");
    let (_, show, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    assert!(show.contains("exploring: true (derived)"), "{show}");

    // Omitting the flag keeps the mark.
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "update",
        "A1B2C3D4",
        "--body",
        "上游决策改。",
    ]);
    assert_eq!(code, 0);
    let (_, show, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    assert!(show.contains("exploring: true"), "{show}");
    assert!(!show.contains("(derived)"), "{show}");

    // --no-exploring settles: the field disappears from the file.
    let (code, _, _) = run(&["--root", r.as_str(), "update", "A1B2C3D4", "--no-exploring"]);
    assert_eq!(code, 0);
    let source = std::fs::read_to_string(
        root.join(".refino")
            .join("nodes")
            .join("A1")
            .join("B2C3D4-decision.md"),
    )
    .unwrap();
    let (_, list, _) = run(&["--root", r.as_str(), "list"]);
    remove_refino(&root);
    assert!(!source.contains("exploring"), "{source}");
    assert!(!list.contains("[探索]"), "{list}");
}

#[test]
fn no_exploring_alone_counts_as_touched() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "A1B2C3D4",
        "--body",
        "试行。",
        "--exploring",
    ]);
    let (code, _, err) = run(&["--root", r.as_str(), "update", "A1B2C3D4", "--no-exploring"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(err.is_empty(), "{err}");
}

#[test]
fn delete_refuses_while_grounded_and_deletes_leaves() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "Middle decision.",
        "--grounds",
        "1A2B3C4D",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "E5F6G7H8",
        "--body",
        "Leaf decision.",
        "--grounds",
        "D4E5F6G7",
    ]);

    let (code, out, _) = run(&["--root", r.as_str(), "delete", "D4E5F6G7"]);
    assert_eq!(code, 1);
    assert!(out.contains("grounded on by E5F6G7H8"), "{out}");
    assert!(out.contains("--force"), "{out}");
    let (code, _, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    assert_eq!(code, 0);

    let (code, out, _) = run(&["--root", r.as_str(), "delete", "E5F6G7H8"]);
    assert_eq!(code, 0);
    assert!(out.contains("deleted E5F6G7H8"), "{out}");
    let (code, _, _) = run(&["--root", r.as_str(), "show", "E5F6G7H8"]);
    remove_refino(&root);
    assert_eq!(code, 1);
}

#[test]
fn delete_supports_partial_success_over_batch() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    let (code, out, _) = run(&["--root", r.as_str(), "delete", "1A2B3C4D", "D4E5F6G7"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(out.contains("deleted 1A2B3C4D"), "{out}");
    assert!(out.contains("error: node \"D4E5F6G7\" not found"), "{out}");
}

#[test]
fn force_deletes_through_dependents_and_warns() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D",
    ]);

    let (code, out, err) = run(&["--root", r.as_str(), "delete", "1A2B3C4D", "--force"]);
    assert_eq!(code, 0);
    assert!(out.contains("deleted 1A2B3C4D"), "{out}");
    assert!(err.contains("grounded on by D4E5F6G7"), "{err}");

    let (code, out, _) = run(&["--root", r.as_str(), "validate"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(out.contains("[UNKNOWN_GROUND]"), "{out}");
}

#[test]
fn grounds_print_resolved_grounds_in_declared_order() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "grounds", "E5F6G7H8"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(
        out.find("1A2B3C4D").unwrap() < out.find("D4E5F6G7").unwrap(),
        "{out}"
    );
}

#[test]
fn ancestors_and_dependents_traverse_transitively() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "ancestors", "E5F6G7H8"]);
    assert_eq!(code, 0);
    let rows: Vec<&str> = out
        .lines()
        .filter(|l| {
            l.starts_with("1A2B3C4D ") || l.starts_with("D4E5F6G7 ") || l.starts_with("A1B2C3D4 ")
        })
        .collect();
    assert_eq!(rows.len(), 3, "{out}");
    assert!(rows[0].starts_with("1A2B3C4D  premise   1  "), "{out}");
    assert!(rows[1].starts_with("D4E5F6G7  decision  1  "), "{out}");
    assert!(rows[2].starts_with("A1B2C3D4  decision  2  "), "{out}");

    let (code, out, _) = run(&["--root", r.as_str(), "dependents", "A1B2C3D4"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.contains("D4E5F6G7"), "{out}");
    assert!(out.contains("E5F6G7H8"), "{out}");
}

#[test]
fn batch_queries_report_per_id_sections() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "dependents", "A1B2C3D4", "D4E5F6G7"]);
    assert_eq!(code, 0);
    assert!(out.contains("A1B2C3D4:"), "{out}");
    assert!(out.contains("D4E5F6G7:"), "{out}");
    assert!(
        out.lines()
            .any(|l| l.starts_with("E5F6G7H8  decision  2  ")),
        "{out}"
    );
    assert!(
        out.lines()
            .any(|l| l.starts_with("E5F6G7H8  decision  1  ")),
        "{out}"
    );

    let (code, out, _) = run(&["--root", r.as_str(), "dependents", "A1B2C3D4", "E5F6G7H8"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.contains("A1B2C3D4:"), "{out}");
    assert!(out.contains("E5F6G7H8:\n(empty)\n"), "{out}");
}

#[test]
fn show_prints_several_full_records() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "当前 PostgreSQL 版本不支持 extension X。"),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body(
                "E5F6G7H8",
                &["1A2B3C4D", "D4E5F6G7"],
                "不使用 extension X，改用手写 SQL。",
            ),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "show", "E5F6G7H8", "1A2B3C4D"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.find("decisions(id=E5F6G7H8").unwrap() < out.find("premises(id=1A2B3C4D").unwrap());
    assert!(out.contains("不使用 extension X，改用手写 SQL。"));
    assert!(out.contains("当前 PostgreSQL 版本不支持 extension X。"));
}

#[test]
fn queries_refuse_on_invalid_graph() {
    let root = create_refino(&[
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &["B2C3D4E5"], "A."),
        ),
        file(
            "nodes/B2/C3D4E5-decision.md",
            &decision_body("B2C3D4E5", &["A1B2C3D4"], "B."),
        ),
    ]);
    let (code, out, _) = run(&["--root", root_arg(&root).as_str(), "ancestors", "A1B2C3D4"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(out.contains("[CYCLE]"), "{out}");
}

#[test]
fn unknown_ids_report_inline_and_exit_1() {
    let root = create_refino(&[premise_body("1A2B3C4D", "Fact.")]);
    let r = root_arg(&root);
    let (code, out, err) = run(&["--root", r.as_str(), "show", "9M8N7P6Q"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.is_empty(), "{err}");
    assert!(out.contains("error: Node \"9M8N7P6Q\" not found"), "{out}");
}

#[test]
fn batch_queries_still_return_results_for_existing_ids() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "dependents", "A1B2C3D4", "9M8N7P6Q"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(out.contains("A1B2C3D4:"), "{out}");
    assert!(out.contains("D4E5F6G7"), "{out}");
    assert!(out.contains("E5F6G7H8"), "{out}");
    assert!(out.contains("error: Node \"9M8N7P6Q\" not found"), "{out}");
}

#[test]
fn unknown_command_exits_1() {
    let root = create_refino(&[premise_body("1A2B3C4D", "Fact.")]);
    let r = root_arg(&root);
    let (code, _, err) = run(&["--root", r.as_str(), "frobnicate"]);
    let (code2, _, err2) = run(&["--root", r.as_str(), "deps", "A1B2C3D4"]);
    let (code3, _, err3) = run(&["--root", r.as_str(), "impact", "A1B2C3D4"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.contains("unknown command"), "{err}");
    assert_eq!(code2, 1);
    assert!(err2.contains("unknown command"), "{err2}");
    assert_eq!(code3, 1);
    assert!(err3.contains("unknown command"), "{err3}");
}

#[test]
fn new_premise_prints_id_and_path() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, out, _) = run(&[
        "--root",
        &r,
        "new",
        "premise",
        "--body",
        "PostgreSQL 16 is in use.",
        "--confirmed",
        "2026-05-01T00:00:00Z",
    ]);
    assert_eq!(code, 0);
    // Crockford base32: no I, L, O, U.
    let id: String = out
        .split("created ")
        .nth(1)
        .unwrap()
        .chars()
        .take(8)
        .collect();
    assert!(
        out.contains(&format!(
            ".refino/nodes/{}/{}-premise.md",
            &id[..2],
            &id[2..]
        )),
        "{out}"
    );
    let (_, list, _) = run(&["--root", r.as_str(), "list", "--type", "premise"]);
    remove_refino(&root);
    assert!(list.contains(&id), "{list}");
}

#[test]
fn new_premise_without_body_creates_empty_node() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, _, _) = run(&["--root", r.as_str(), "new", "premise", "--id", "1A2B3C4D"]);
    assert_eq!(code, 0);
    let source = std::fs::read_to_string(
        root.join(".refino")
            .join("nodes")
            .join("1A")
            .join("2B3C4D-premise.md"),
    )
    .unwrap();
    remove_refino(&root);
    assert_eq!(source.trim(), "");
}

#[test]
fn new_decision_creates_with_grounds_and_validates() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--body",
        "Use Repository layer.",
        "--grounds",
        "1A2B3C4D",
        "--rationale",
        "Keeps DB access testable.",
    ]);
    assert_eq!(code, 0);
    assert!(out.contains(".refino/nodes/"), "{out}");
    let (code, out, _) = run(&["--root", r.as_str(), "validate"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.contains("valid:"), "{out}");
}

#[test]
fn new_decision_rejects_unknown_grounds_before_creating() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D,2B3C4D5E",
    ]);
    assert_eq!(code, 1);
    assert!(err.contains("[UNKNOWN_GROUND]"), "{err}");
    assert!(err.contains("2B3C4D5E"), "{err}");
    let (code, out, _) = run(&["--root", r.as_str(), "validate"]);
    remove_refino(&root);
    assert_eq!(code, 0); // nothing was written
    assert!(out.contains("valid:"), "{out}");
}

#[test]
fn new_decision_rejects_repeated_ground_ids() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "1A2B3C4D",
        "--body",
        "Fact.",
    ]);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--body",
        "Decision.",
        "--grounds",
        "1A2B3C4D,1A2B3C4D",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.contains("[INVALID_GROUNDS]"), "{err}");
}

#[test]
fn new_premise_now_stamps_utc_and_validates() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--body",
        "Fact.",
        "--now",
    ]);
    assert_eq!(code, 0);
    let (code, out, _) = run(&["--root", r.as_str(), "validate"]);
    assert_eq!(code, 0);
    assert!(out.contains("valid:"), "{out}");
    let (_, list, _) = run(&["--root", r.as_str(), "list", "--type", "premise"]);
    let id: String = list.lines().next().unwrap().chars().take(8).collect();
    let (_, show, _) = run(&["--root", r.as_str(), "show", &id]);
    remove_refino(&root);
    let confirmed_line = show
        .lines()
        .find(|l| l.contains("confirmed:"))
        .expect("confirmed");
    let date = confirmed_line.trim_start_matches("confirmed: ");
    assert!(
        date.len() >= 10 && date.as_bytes()[4] == b'-',
        "{confirmed_line}"
    );
}

#[test]
fn new_premise_rejects_now_with_confirmed() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--body",
        "Fact.",
        "--now",
        "--confirmed",
        "2026-05-01T00:00:00Z",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(err.contains("mutually exclusive"), "{err}");
}

#[test]
fn new_decision_rejects_malformed_ground_ids() {
    let root = create_refino(&[premise_body("1A2B3C4D", "Fact.")]);
    let r = root_arg(&root);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--body",
        "Decision.",
        "--grounds",
        "ilou2345",
    ]);
    assert_eq!(code, 1);
    assert!(err.contains("invalid ground id \"ilou2345\""), "{err}");
    let (_, list, _) = run(&["--root", r.as_str(), "list"]);
    remove_refino(&root);
    assert!(list.contains("1A2B3C4D"), "{list}");
}

#[test]
fn ancestors_include_depth_column_and_list_has_none() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "Fact."),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "D1."),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "D2."),
        ),
        file(
            "nodes/E5/F6G7H8-decision.md",
            &decision_body("E5F6G7H8", &["1A2B3C4D", "D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "ancestors", "E5F6G7H8"]);
    assert_eq!(code, 0);
    let lines: Vec<&str> = out.trim_end().lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert!(lines[0].starts_with("1A2B3C4D  premise   1  "), "{out}");
    assert!(lines[1].starts_with("D4E5F6G7  decision  1  "), "{out}");
    assert!(lines[2].starts_with("A1B2C3D4  decision  2  "), "{out}");

    let (_, list, _) = run(&["--root", r.as_str(), "list"]);
    remove_refino(&root);
    assert!(
        list.lines().any(|l| l.starts_with("1A2B3C4D  premise   ")),
        "{list}"
    );
}

#[test]
fn new_premise_with_explicit_id_prints_canonical_path() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "premise",
        "--id",
        "A1B2C3D4",
        "--body",
        "Fact.",
    ]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(
        out.contains("created A1B2C3D4 (.refino/nodes/A1/B2C3D4-premise.md)"),
        "{out}"
    );
}

#[test]
fn new_rejects_invalid_id() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "a1b2c3d4",
        "--body",
        "Decision.",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(
        err.contains("Node id must be 3-16 characters of A-Z, 0-9 or _"),
        "{err}"
    );
}

#[test]
fn new_summary_stores_explicit_summary() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--body",
        "Very long decision body.",
        "--summary",
        "Short summary.",
    ]);
    assert_eq!(code, 0);
    let (_, list, _) = run(&["--root", r.as_str(), "list"]);
    remove_refino(&root);
    assert!(list.contains("Short summary."), "{list}");
}
