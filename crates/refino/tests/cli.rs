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

/// Run the CLI in-process with preset stdin text (for `-` content sources).
fn run_with_stdin(argv: &[&str], stdin: &str) -> (i32, String, String) {
    let args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let mut sink = CaptureSink {
        stdin: stdin.to_string(),
        ..Default::default()
    };
    let code = refino::run(&args, &mut sink);
    (code, sink.out, sink.err)
}

/// Write a scratch file next to the fixture root for `--body-file` tests.
fn scratch(root: &Path, name: &str, content: &str) -> String {
    let path = root.join(name);
    std::fs::write(&path, content).unwrap();
    path.to_string_lossy().to_string()
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
    assert!(
        out.contains("premises(id=1A2B3C4D, children=[E5F6G7H8])"),
        "{out}"
    );
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

    // Misplaced options are rejected so the caller never believes an
    // inapplicable change took effect.
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--rationale",
        "x",
    ]);
    assert_eq!(code, 1);
    assert!(
        err.contains("--rationale only applies to decisions"),
        "{err}"
    );

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
    let (code, _, err) = run(&["--root", r.as_str(), "update", "D4E5F6G7", "--now"]);
    assert_eq!(code, 1);
    assert!(err.contains("--now only applies to premises"), "{err}");

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
    // Root decisions default to exploring; settle both roots so the fixture
    // starts from a settled baseline.
    run(&["--root", r.as_str(), "update", "A1B2C3D4", "--no-exploring"]);
    run(&["--root", r.as_str(), "update", "E5F6G7H8", "--no-exploring"]);
    let (_, before, _) = run(&["--root", r.as_str(), "list"]);
    assert!(!before.contains("[探索]"), "{before}");

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

/// Fixture: two root decisions (one grounds-empty, one grounded only on a
/// premise), one downstream decision, two premises — exercising the canvas
/// root notion (`--roots`) and search matching.
fn search_fixture() -> Vec<(String, String)> {
    vec![
        premise_body("1A2B3C4D", "PostgreSQL 版本约束。"),
        premise_body("9Z8Y7X6W", "部署环境为内网。"),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "所有业务数据存储在 PostgreSQL。"),
        ),
        file(
            "nodes/C3/D4E5F6-decision.md",
            &decision_body("C3D4E5F6", &["1A2B3C4D"], "不使用 extension X。"),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body(
                "D4E5F6G7",
                &["A1B2C3D4"],
                "数据访问必须通过 Repository 层。",
            ),
        ),
    ]
}

#[test]
fn search_matches_id_prefix_and_summary_substring() {
    let files = search_fixture();
    let root = create_refino(&files);
    let r = root_arg(&root);
    // id prefix, case-insensitive
    let (code, out, _) = run(&["--root", r.as_str(), "search", "a1b2"]);
    // summary substring
    let (code2, out2, _) = run(&["--root", r.as_str(), "search", "repository"]);
    // no match
    let (code3, out3, _) = run(&["--root", r.as_str(), "search", "nonexistent"]);
    // empty query matches everything
    let (code4, out4, _) = run(&["--root", r.as_str(), "search"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(out.contains("A1B2C3D4"), "{out}");
    assert!(!out.contains("C3D4E5F6"), "{out}");
    assert_eq!(code2, 0);
    assert!(out2.contains("D4E5F6G7"), "{out2}");
    assert_eq!(code3, 0);
    assert!(out3.contains("(no matches)"), "{out3}");
    assert_eq!(code4, 0);
    assert!(
        out4.contains("1A2B3C4D") && out4.contains("D4E5F6G7"),
        "{out4}"
    );
}

#[test]
fn search_honors_type_limit_and_cursor() {
    let files = search_fixture();
    let root = create_refino(&files);
    let r = root_arg(&root);
    let (_, out, _) = run(&["--root", r.as_str(), "search", "--type", "decision"]);
    let (code, limited, _) = run(&["--root", r.as_str(), "search", "--limit", "2"]);
    let (_, page2, _) = run(&[
        "--root",
        r.as_str(),
        "search",
        "--limit",
        "2",
        "--cursor",
        "A1B2C3D4",
    ]);
    remove_refino(&root);
    assert!(
        out.contains("A1B2C3D4") && !out.contains("1A2B3C4D"),
        "{out}"
    );
    assert_eq!(code, 0);
    // ids sort ascending: digits before letters, so page 1 ends at 9Z8Y7X6W.
    assert!(
        limited.contains("(more results; continue with --cursor 9Z8Y7X6W"),
        "{limited}"
    );
    // strictly after the cursor
    assert!(!page2.contains("A1B2C3D4"), "{page2}");
    assert!(page2.contains("C3D4E5F6"), "{page2}");
}

#[test]
fn list_roots_uses_canvas_scope_and_limit_caps() {
    let files = search_fixture();
    let root = create_refino(&files);
    let r = root_arg(&root);
    // C3D4E5F6 grounds on a premise only → still a canvas root.
    let (_, out, _) = run(&["--root", r.as_str(), "list", "--roots"]);
    let (code, capped, _) = run(&["--root", r.as_str(), "list", "--limit", "2"]);
    let (code2, _, err) = run(&["--root", r.as_str(), "list", "--roots", "--type", "premise"]);
    let (code3, _, err2) = run(&["--root", r.as_str(), "list", "--roots", "--unreferenced"]);
    let (code4, _, err3) = run(&["--root", r.as_str(), "list", "--limit", "0"]);
    remove_refino(&root);
    assert!(out.contains("A1B2C3D4"), "{out}");
    assert!(out.contains("C3D4E5F6"), "{out}");
    assert!(!out.contains("D4E5F6G7"), "{out}");
    assert!(!out.contains("1A2B3C4D"), "{out}");
    assert_eq!(code, 0);
    assert!(
        capped.contains("(truncated at 2; more nodes remain)"),
        "{capped}"
    );
    assert_eq!(code2, 1);
    assert!(err.contains("--roots only applies to decisions"), "{err}");
    assert_eq!(code3, 1);
    assert!(err2.contains("mutually exclusive"), "{err2}");
    assert_eq!(code4, 1);
    assert!(err3.contains("--limit must be at least 1"), "{err3}");
}

#[test]
fn edit_replaces_body_by_exact_match_and_reports_affected() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "前提。"),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body(
                "A1B2C3D4",
                &["1A2B3C4D"],
                "统一使用 PostgreSQL；日志也写入 PostgreSQL。",
            ),
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            &decision_body("D4E5F6G7", &["A1B2C3D4"], "通过 Repository 层访问。"),
        ),
    ]);
    let r = root_arg(&root);
    // ambiguity refuses without side effects
    let (code2, _, err2) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "PostgreSQL",
        "--new",
        "X",
    ]);
    // not found / empty / identical
    let (code3, _, err3) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "nope",
        "--new",
        "x",
    ]);
    let (code4, _, err4) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "",
        "--new",
        "x",
    ]);
    let (code5, _, err5) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "PostgreSQL",
        "--new",
        "PostgreSQL",
    ]);
    // replace-all hits both occurrences
    let (code6, out6, _) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "PostgreSQL",
        "--new",
        "DB",
        "--replace-all",
    ]);
    // a unique span replaces once and reports affected downstream
    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "日志也写入 DB",
        "--new",
        "日志也写入 MySQL",
    ]);
    let (_, shown, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    remove_refino(&root);
    assert_eq!(code2, 1);
    assert!(err2.contains("--old matches 2 times"), "{err2}");
    assert_eq!(code3, 1);
    assert!(err3.contains("--old not found"), "{err3}");
    assert_eq!(code4, 1);
    assert!(err4.contains("--old must not be empty"), "{err4}");
    assert_eq!(code5, 1);
    assert!(err5.contains("nothing to replace"), "{err5}");
    assert_eq!(code6, 0);
    assert!(out6.contains("replaced 2"), "{out6}");
    assert_eq!(code, 0);
    assert!(
        out.contains("edited A1B2C3D4 (.refino/nodes/A1/B2C3D4-decision.md) replaced 1"),
        "{out}"
    );
    assert!(out.contains("下游受影响，建议复核：D4E5F6G7"), "{out}");
    assert!(shown.contains("统一使用 DB；日志也写入 MySQL。"), "{shown}");
}

#[test]
fn edit_keeps_derived_summary_in_sync() {
    let root = create_refino(&[file(
        "nodes/A1/B2C3D4-decision.md",
        &decision_body("A1B2C3D4", &[], "旧正文首段。"),
    )]);
    let r = root_arg(&root);
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "A1B2C3D4",
        "--old",
        "旧正文首段。",
        "--new",
        "新正文首段。",
    ]);
    let (_, list, _) = run(&["--root", r.as_str(), "list"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    // no explicit summary in frontmatter: the fallback re-derives from the body
    assert!(list.contains("新正文首段。"), "{list}");
    assert!(!list.contains("旧正文首段。"), "{list}");
}

#[test]
fn content_channels_accept_files_and_stdin() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);
    let body_path = scratch(&root, "body.md", "来自文件的正文。\n\n第二段。");
    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "A1B2C3D4",
        "--body-file",
        body_path.as_str(),
        "--grounds",
        "",
    ]);
    let (_, shown, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    // stdin channel
    let (code2, _, _) = run_with_stdin(
        &[
            "--root",
            r.as_str(),
            "new",
            "premise",
            "--id",
            "9Z8Y7X6W",
            "--body-file",
            "-",
        ],
        "来自 stdin 的事实。",
    );
    let (_, shown2, _) = run(&["--root", r.as_str(), "show", "9Z8Y7X6W"]);
    // update via file
    let body2 = scratch(&root, "body2.md", "替换后的正文。");
    let (code3, _, _) = run(&[
        "--root",
        r.as_str(),
        "update",
        "A1B2C3D4",
        "--body-file",
        body2.as_str(),
    ]);
    let (_, shown3, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    // rationale via stdin
    let (code4, _, _) = run_with_stdin(
        &[
            "--root",
            r.as_str(),
            "update",
            "A1B2C3D4",
            "--rationale-file",
            "-",
        ],
        "因为事实如此。",
    );
    let (_, shown4, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    remove_refino(&root);
    assert_eq!(code, 0);
    assert!(
        shown.contains("来自文件的正文。") && shown.contains("第二段。"),
        "{shown}"
    );
    assert_eq!(code2, 0);
    assert!(shown2.contains("来自 stdin 的事实。"), "{shown2}");
    assert_eq!(code3, 0);
    assert!(shown3.contains("替换后的正文。"), "{shown3}");
    assert_eq!(code4, 0);
    assert!(shown4.contains("rationale: 因为事实如此。"), "{shown4}");
}

#[test]
fn content_channels_reject_conflicts_and_missing_files() {
    let root = create_refino(&[premise_body("1A2B3C4D", "前提。")]);
    let r = root_arg(&root);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--body",
        "x",
        "--body-file",
        "-",
    ]);
    let (code2, _, err2) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--body-file",
        "no-such-file.md",
    ]);
    let (code3, _, err3) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--rationale",
        "x",
        "--rationale-file",
        "-",
    ]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(
        err.contains("--body and --body-file are mutually exclusive"),
        "{err}"
    );
    assert_eq!(code2, 1);
    assert!(err2.contains("cannot read --body-file"), "{err2}");
    assert_eq!(code3, 1);
    assert!(
        err3.contains("--rationale and --rationale-file are mutually exclusive"),
        "{err3}"
    );
}

#[test]
fn update_rejects_options_that_do_not_apply_to_the_node_type() {
    let root = create_refino(&[
        premise_body("1A2B3C4D", "前提。"),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &decision_body("A1B2C3D4", &[], "决策。"),
        ),
    ]);
    let r = root_arg(&root);
    let before = run(&["--root", r.as_str(), "show", "1A2B3C4D"]).1;
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--rationale",
        "why",
    ]);
    let (code2, _, err2) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--grounds",
        "A1B2C3D4",
    ]);
    let (code3, _, err3) = run(&["--root", r.as_str(), "update", "A1B2C3D4", "--now"]);
    let (code4, _, err4) = run(&[
        "--root",
        r.as_str(),
        "update",
        "A1B2C3D4",
        "--confirmed",
        "2026-01-01T00:00:00Z",
    ]);
    let (code5, _, err5) = run(&["--root", r.as_str(), "update", "1A2B3C4D", "--no-exploring"]);
    let after = run(&["--root", r.as_str(), "show", "1A2B3C4D"]).1;
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(
        err.contains("--rationale only applies to decisions"),
        "{err}"
    );
    assert_eq!(code2, 1);
    assert!(
        err2.contains("--grounds only applies to decisions"),
        "{err2}"
    );
    assert_eq!(code3, 1);
    assert!(err3.contains("--now only applies to premises"), "{err3}");
    assert_eq!(code4, 1);
    assert!(
        err4.contains("--confirmed only applies to premises"),
        "{err4}"
    );
    assert_eq!(code5, 1);
    assert!(
        err5.contains("--no-exploring only applies to decisions"),
        "{err5}"
    );
    assert_eq!(before, after, "rejected updates must not touch the file");
}

#[test]
fn json_output_covers_validate_list_search_and_show() {
    let files = search_fixture();
    let root = create_refino(&files);
    let r = root_arg(&root);

    let (code, out, _) = run(&["--root", r.as_str(), "validate", "--json"]);
    let (_, list, _) = run(&["--root", r.as_str(), "list", "--json"]);
    let (_, list_roots, _) = run(&["--root", r.as_str(), "list", "--roots", "--json"]);
    let (_, search, _) = run(&["--root", r.as_str(), "search", "repository", "--json"]);
    let (_, search_page, _) = run(&["--root", r.as_str(), "search", "--limit", "2", "--json"]);
    let (_, show, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7", "--json"]);
    let (code_missing, show_missing, _) =
        run(&["--root", r.as_str(), "show", "D4E5F6G7", "NOPE12", "--json"]);
    remove_refino(&root);

    assert_eq!(code, 0);
    assert!(
        out.contains("\"valid\":true")
            && out.contains("\"decisions\":3")
            && out.contains("\"premises\":2")
            && out.contains("\"issues\":[]"),
        "{out}"
    );
    // list rows carry the resident fields plus the effective status
    assert!(list.contains("\"grounds\":[\"A1B2C3D4\"]"), "{list}");
    assert!(list.contains("\"exploring_effective\":false"), "{list}");
    // roots: the two canvas-scope decisions, not the downstream one
    assert!(
        list_roots.contains("A1B2C3D4") && list_roots.contains("C3D4E5F6"),
        "{list_roots}"
    );
    assert!(!list_roots.contains("D4E5F6G7"), "{list_roots}");
    // search page mirrors the harness contract
    assert!(search.contains("\"query\":\"repository\""), "{search}");
    assert!(
        search.contains("\"id\":\"D4E5F6G7\"") && search.contains("\"type\":\"decision\""),
        "{search}"
    );
    assert!(!search.contains("next_cursor"), "{search}");
    assert!(
        search_page.contains("\"next_cursor\":\"9Z8Y7X6W\""),
        "{search_page}"
    );
    // show: full record with paged content; missing ids stay per-id errors
    assert!(
        show.contains("\"grounds\":[\"A1B2C3D4\"]") && show.contains("\"body\""),
        "{show}"
    );
    assert!(show.contains("\"exploring_effective\":false"), "{show}");
    assert_eq!(code_missing, 1);
    assert!(
        show_missing.contains("\"error\"") && show_missing.contains("NOPE12"),
        "{show_missing}"
    );
}

#[test]
fn json_validate_reports_issues_and_exit_1() {
    let root = create_refino(&[file(
        "nodes/A1/B2C3D4-decision.md",
        &decision_body("A1B2C3D4", &["NOPE12"], "悬空依据。"),
    )]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "validate", "--json"]);
    remove_refino(&root);
    assert_eq!(code, 1);
    assert!(out.contains("\"valid\":false"), "{out}");
    assert!(out.contains("UNKNOWN_GROUND"), "{out}");
}

#[test]
fn graph_queries_emit_json_with_partial_success() {
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
    let (code, grounds, _) = run(&["--root", r.as_str(), "grounds", "E5F6G7H8", "--json"]);
    let (_, ancestors, _) = run(&["--root", r.as_str(), "ancestors", "E5F6G7H8", "--json"]);
    let (code_missing, dependents, _) = run(&[
        "--root",
        r.as_str(),
        "dependents",
        "A1B2C3D4",
        "NOPE12",
        "--json",
    ]);
    remove_refino(&root);

    assert_eq!(code, 0);
    // grounds: declared order, identity rows without depth annotation
    assert!(grounds.contains("\"id\":\"E5F6G7H8\""), "{grounds}");
    assert!(
        grounds.contains(
            "\"nodes\":[{\"id\":\"1A2B3C4D\",\"type\":\"premise\",\"summary\":\"Fact.\"}"
        ),
        "{grounds}"
    );
    assert!(
        grounds.find("\"1A2B3C4D\"").unwrap() < grounds.find("\"D4E5F6G7\"").unwrap(),
        "{grounds}"
    );
    assert!(
        !grounds.contains("depth") && !grounds.contains("overlap"),
        "{grounds}"
    );
    // ancestors: relative depths ride along
    assert!(ancestors.contains("\"depth\":1"), "{ancestors}");
    assert!(ancestors.contains("\"depth\":2"), "{ancestors}");
    // missing ids stay per-id errors, existing ids keep their results
    assert_eq!(code_missing, 1);
    assert!(dependents.contains("NOPE12"), "{dependents}");
    assert!(dependents.contains("\"error\""), "{dependents}");
    assert!(dependents.contains("D4E5F6G7"), "{dependents}");
}

#[test]
fn max_depth_bounds_traversal_queries() {
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
            &decision_body("E5F6G7H8", &["D4E5F6G7"], "D3."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, direct, _) = run(&[
        "--root",
        r.as_str(),
        "dependents",
        "A1B2C3D4",
        "--max-depth",
        "1",
    ]);
    let (_, none, _) = run(&[
        "--root",
        r.as_str(),
        "dependents",
        "A1B2C3D4",
        "--max-depth",
        "0",
    ]);
    let (_, up_direct, _) = run(&[
        "--root",
        r.as_str(),
        "ancestors",
        "E5F6G7H8",
        "--max-depth",
        "1",
    ]);
    let (_, json, _) = run(&[
        "--root",
        r.as_str(),
        "dependents",
        "A1B2C3D4",
        "--max-depth",
        "1",
        "--json",
    ]);
    remove_refino(&root);

    assert_eq!(code, 0);
    assert!(direct.contains("D4E5F6G7"), "{direct}");
    assert!(!direct.contains("E5F6G7H8"), "{direct}");
    assert!(none.contains("(empty)"), "{none}");
    assert!(up_direct.contains("D4E5F6G7"), "{up_direct}");
    assert!(!up_direct.contains("A1B2C3D4"), "{up_direct}");
    assert!(json.contains("\"depth\":1"), "{json}");
    assert!(!json.contains("\"depth\":2"), "{json}");
}

#[test]
fn siblings_rank_by_shared_grounds_and_cap_per_id() {
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
        file(
            "nodes/F6/G7H8J-decision.md",
            &decision_body("F6G7H8J", &["1A2B3C4D", "A1B2C3D4", "D4E5F6G7"], "D4."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "siblings", "F6G7H8J"]);
    let (_, capped, _) = run(&["--root", r.as_str(), "siblings", "F6G7H8J", "--limit", "1"]);
    let (_, premise, _) = run(&["--root", r.as_str(), "siblings", "1A2B3C4D"]);
    let (code_missing, batch, _) = run(&["--root", r.as_str(), "siblings", "F6G7H8J", "NOPE12"]);
    let (code_zero, _, err_zero) =
        run(&["--root", r.as_str(), "siblings", "F6G7H8J", "--limit", "0"]);
    remove_refino(&root);

    assert_eq!(code, 0);
    // overlap-descending: the sibling sharing two grounds comes first
    assert!(out.contains("E5F6G7H8  decision  2"), "{out}");
    assert!(out.contains("D4E5F6G7  decision  1"), "{out}");
    assert_eq!(capped.lines().count(), 1, "{capped}");
    assert!(
        capped.contains("E5F6G7H8") && !capped.contains("D4E5F6G7"),
        "{capped}"
    );
    // premises have no grounds and thus no siblings
    assert!(premise.contains("(empty)"), "{premise}");
    assert_eq!(code_missing, 1);
    assert!(batch.contains("F6G7H8J:"), "{batch}");
    assert!(
        batch.contains("error: Node \"NOPE12\" not found"),
        "{batch}"
    );
    assert_eq!(code_zero, 1);
    assert!(
        err_zero.contains("--limit must be at least 1"),
        "{err_zero}"
    );
}

#[test]
fn siblings_json_ranks_by_overlap() {
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
        file(
            "nodes/F6/G7H8J-decision.md",
            &decision_body("F6G7H8J", &["1A2B3C4D", "A1B2C3D4", "D4E5F6G7"], "D4."),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "siblings", "F6G7H8J", "--json"]);
    remove_refino(&root);

    assert_eq!(code, 0);
    assert!(out.contains("\"overlap\":2"), "{out}");
    assert!(out.contains("\"overlap\":1"), "{out}");
    assert!(
        out.find("\"id\":\"E5F6G7H8\"").unwrap() < out.find("\"id\":\"D4E5F6G7\"").unwrap(),
        "{out}"
    );
    assert!(!out.contains("depth"), "{out}");
}

#[test]
fn edit_channels_accept_files_and_stdin() {
    let root = create_refino(&[premise_body("1A2B3C4D", "第一段。\n第二段。\n第三段。")]);
    let r = root_arg(&root);
    let old_path = scratch(&root, "old.txt", "第一段。");
    let new_path = scratch(&root, "new.txt", "首段。");
    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "1A2B3C4D",
        "--old-file",
        old_path.as_str(),
        "--new-file",
        new_path.as_str(),
    ]);
    assert_eq!(code, 0, "{out}");
    let (_, shown, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    assert!(shown.contains("首段。\n第二段。"), "{shown}");

    let (code2, out2, _) = run_with_stdin(
        &[
            "--root",
            r.as_str(),
            "edit",
            "1A2B3C4D",
            "--old-file",
            "-",
            "--new",
            "终段。",
        ],
        "首段。",
    );
    assert_eq!(code2, 0, "{out2}");
    let (_, shown2, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    assert!(shown2.contains("终段。\n第二段。"), "{shown2}");

    let (code3, out3, _) = run_with_stdin(
        &[
            "--root",
            r.as_str(),
            "edit",
            "1A2B3C4D",
            "--old",
            "终段。",
            "--new-file",
            "-",
        ],
        "末段。",
    );
    assert_eq!(code3, 0, "{out3}");
    let (_, shown3, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    assert!(shown3.contains("末段。"), "{shown3}");
    remove_refino(&root);
}

#[test]
fn edit_channels_reject_conflicts_and_missing_args() {
    let root = create_refino(&[premise_body("1A2B3C4D", "前提。")]);
    let r = root_arg(&root);
    let (code, _, err) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "1A2B3C4D",
        "--old",
        "x",
        "--old-file",
        "-",
    ]);
    let (code2, _, err2) = run(&[
        "--root",
        r.as_str(),
        "edit",
        "1A2B3C4D",
        "--old-file",
        "no-such-old.md",
        "--new",
        "y",
    ]);
    let (code3, _, err3) = run(&["--root", r.as_str(), "edit", "1A2B3C4D", "--new", "y"]);
    let (code4, _, err4) = run(&["--root", r.as_str(), "edit", "1A2B3C4D", "--old", "前提。"]);
    remove_refino(&root);

    assert_eq!(code, 1);
    assert!(
        err.contains("--old and --old-file are mutually exclusive"),
        "{err}"
    );
    assert_eq!(code2, 1);
    assert!(err2.contains("cannot read --old-file"), "{err2}");
    assert_eq!(code3, 1);
    assert!(err3.contains("--old or --old-file"), "{err3}");
    assert_eq!(code4, 1);
    assert!(err4.contains("--new or --new-file"), "{err4}");
}

#[test]
fn show_reports_direct_dependents_as_children() {
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
    let (_, decision, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4"]);
    let (_, leaf, _) = run(&["--root", r.as_str(), "show", "E5F6G7H8"]);
    let (_, premise, _) = run(&["--root", r.as_str(), "show", "1A2B3C4D"]);
    let (_, json, _) = run(&["--root", r.as_str(), "show", "A1B2C3D4", "--json"]);
    let (_, leaf_json, _) = run(&["--root", r.as_str(), "show", "E5F6G7H8", "--json"]);
    remove_refino(&root);

    assert!(
        decision.contains("decisions(id=A1B2C3D4, grounds=[], children=[D4E5F6G7])"),
        "{decision}"
    );
    // leaves keep the bare heading
    assert!(
        leaf.contains("decisions(id=E5F6G7H8, grounds=[1A2B3C4D, D4E5F6G7])"),
        "{leaf}"
    );
    // premises carry children too
    assert!(
        premise.contains("premises(id=1A2B3C4D, children=[E5F6G7H8])"),
        "{premise}"
    );
    assert!(json.contains("\"children\":[\"D4E5F6G7\"]"), "{json}");
    assert!(leaf_json.contains("\"children\":[]"), "{leaf_json}");
}

#[test]
fn search_matches_body_and_rationale_case_insensitively() {
    let root = create_refino(&[
        file(
            "nodes/1A/2B3C4D-premise.md",
            "---\nsummary: 部署环境\n---\n\n集群位于内网，运行 Kubernetes 1.30。\n",
        ),
        file(
            "nodes/D4/E5F6G7-decision.md",
            "---\nsummary: 事件存储选型\ngrounds: [1A2B3C4D]\nrationale: 选择 Event Sourcing 以保留完整历史。\n---\n\n正文提到 Kafka 作为传输层。\n",
        ),
    ]);
    let r = root_arg(&root);
    // Body-only term of a premise whose explicit summary does not contain it.
    let (code, body_hit, _) = run(&["--root", r.as_str(), "search", "KUBERNETES"]);
    // Rationale-only term.
    let (_, rationale_hit, _) = run(&["--root", r.as_str(), "search", "event sourcing"]);
    // Body-only term of the decision.
    let (_, decision_body_hit, _) = run(&["--root", r.as_str(), "search", "kafka"]);
    // Summary matching still works.
    let (_, summary_hit, _) = run(&["--root", r.as_str(), "search", "事件存储"]);
    let (_, miss, _) = run(&["--root", r.as_str(), "search", "nonexistent"]);
    let (_, json, _) = run(&["--root", r.as_str(), "search", "kafka", "--json"]);
    remove_refino(&root);

    assert_eq!(code, 0);
    assert!(body_hit.contains("1A2B3C4D"), "{body_hit}");
    assert!(rationale_hit.contains("D4E5F6G7"), "{rationale_hit}");
    assert!(
        decision_body_hit.contains("D4E5F6G7"),
        "{decision_body_hit}"
    );
    assert!(summary_hit.contains("D4E5F6G7"), "{summary_hit}");
    assert!(miss.contains("(no matches)"), "{miss}");
    // The page shape is unchanged: query echo, id/type/summary rows.
    assert!(json.contains("\"query\":\"kafka\""), "{json}");
    assert!(
        json.contains("\"id\":\"D4E5F6G7\"") && json.contains("\"type\":\"decision\""),
        "{json}"
    );
    assert!(!json.contains("next_cursor"), "{json}");
}

#[test]
fn update_reviewed_records_and_clears_the_decision_timestamp() {
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

    let (code, _, _) = run(&[
        "--root",
        r.as_str(),
        "update",
        "D4E5F6G7",
        "--reviewed",
        "2026-05-01T12:00:00+08:00",
    ]);
    let (_, shown, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    // 2026-05-01T04:00:00Z in the canonical UTC form.
    assert_eq!(code, 0);
    assert!(
        shown.contains("reviewed: 2026-05-01T04:00:00.000Z"),
        "{shown}"
    );
    // The show JSON carries the epoch-millisecond value, like `confirmed`.
    let (_, shown_json, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7", "--json"]);
    assert!(
        shown_json.contains("\"reviewed\":1777608000000"),
        "{shown_json}"
    );

    // An empty argument clears the timestamp, removing the frontmatter field.
    let (code_clear, _, _) = run(&["--root", r.as_str(), "update", "D4E5F6G7", "--reviewed", ""]);
    let (_, cleared, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    let source = std::fs::read_to_string(
        root.join(".refino")
            .join("nodes")
            .join("D4")
            .join("E5F6G7-decision.md"),
    )
    .unwrap();
    assert_eq!(code_clear, 0);
    assert!(!cleared.contains("reviewed:"), "{cleared}");
    assert!(!source.contains("reviewed"), "{source}");

    // Malformed timestamps are rejected before touching the file.
    let (code_bad, _, err_bad) = run(&[
        "--root",
        r.as_str(),
        "update",
        "D4E5F6G7",
        "--reviewed",
        "2026-05-01",
    ]);
    assert_eq!(code_bad, 1);
    assert!(err_bad.contains("RFC 3339"), "{err_bad}");

    // The option belongs to decisions only.
    let (code_misplaced, _, err_misplaced) = run(&[
        "--root",
        r.as_str(),
        "update",
        "1A2B3C4D",
        "--reviewed",
        "2026-05-01T00:00:00Z",
    ]);
    remove_refino(&root);
    assert_eq!(code_misplaced, 1);
    assert!(
        err_misplaced.contains("--reviewed only applies to decisions"),
        "{err_misplaced}"
    );
}

#[test]
fn new_root_decision_defaults_to_exploring_with_a_hint() {
    let root = create_refino(&[]);
    let r = root_arg(&root);
    run(&["--root", r.as_str(), "init"]);

    // A root decision (no grounds) with no explicit mark is a trial commitment.
    let (code, out, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "A1B2C3D4",
        "--body",
        "根决策。",
    ]);
    let root_source = std::fs::read_to_string(
        root.join(".refino")
            .join("nodes")
            .join("A1")
            .join("B2C3D4-decision.md"),
    )
    .unwrap();
    assert_eq!(code, 0);
    assert!(out.contains("提示：根决策默认标记为探索中"), "{out}");
    assert!(root_source.contains("exploring: true"), "{root_source}");

    // An explicit mark suppresses the default hint.
    let (_, explicit, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "E5F6G7H8",
        "--body",
        "显式试行。",
        "--exploring",
    ]);
    assert!(!explicit.contains("提示："), "{explicit}");

    // A grounded decision starts settled and gets no hint.
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
    let (_, grounded, _) = run(&[
        "--root",
        r.as_str(),
        "new",
        "decision",
        "--id",
        "D4E5F6G7",
        "--body",
        "细化决策。",
        "--grounds",
        "1A2B3C4D",
    ]);
    let grounded_file = root
        .join(".refino")
        .join("nodes")
        .join("D4")
        .join("E5F6G7-decision.md");
    let grounded_source = std::fs::read_to_string(&grounded_file).unwrap();
    assert!(!grounded.contains("提示："), "{grounded}");
    assert!(!grounded_source.contains("exploring"), "{grounded_source}");

    // Update never adds the root default and never settles by making grounds empty.
    let (code_empty, _, _) = run(&["--root", r.as_str(), "update", "D4E5F6G7", "--grounds", ""]);
    let after_grounds = std::fs::read_to_string(&grounded_file).unwrap();
    assert_eq!(code_empty, 0);
    assert!(!after_grounds.contains("exploring"), "{after_grounds}");

    // An existing mark survives an empty-grounds update.
    run(&["--root", r.as_str(), "update", "D4E5F6G7", "--exploring"]);
    run(&["--root", r.as_str(), "update", "D4E5F6G7", "--grounds", ""]);
    let (_, shown, _) = run(&["--root", r.as_str(), "show", "D4E5F6G7"]);
    remove_refino(&root);
    assert!(shown.contains("exploring: true"), "{shown}");
}

#[test]
fn stale_lists_overdue_and_never_reviewed_nodes() {
    const DAY_MS: i64 = 86_400_000;
    // The fixtures are dated relative to the real clock the CLI reads; the
    // age arithmetic itself is covered deterministically by the engine unit test.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let old_decision = refino_storage::confirmed_to_rfc3339(now - 200 * DAY_MS).unwrap();
    let old_premise = refino_storage::confirmed_to_rfc3339(now - 100 * DAY_MS).unwrap();
    let future = refino_storage::confirmed_to_rfc3339(now + 5 * DAY_MS).unwrap();
    let root = create_refino(&[
        file(
            "nodes/1A/2B3C4D-premise.md",
            &format!("---\nconfirmed: {old_premise}\n---\n\n旧前提。\n"),
        ),
        file("nodes/2B/3C4D5E-premise.md", "尚未确认的前提。\n"),
        file(
            "nodes/A1/B2C3D4-decision.md",
            &format!("---\nreviewed: {old_decision}\n---\n\n旧决策。\n"),
        ),
        file("nodes/D4/E5F6G7-decision.md", "尚未复核的决策。\n"),
        file(
            "nodes/H7/J8K9M0-decision.md",
            &format!("---\nreviewed: {future}\n---\n\n未来复核的决策。\n"),
        ),
    ]);
    let r = root_arg(&root);
    let (code, out, _) = run(&["--root", r.as_str(), "stale"]);
    let (_, all_fresh, _) = run(&["--root", r.as_str(), "stale", "--days", "100000"]);
    let (_, json, _) = run(&["--root", r.as_str(), "stale", "--json"]);
    remove_refino(&root);

    assert_eq!(code, 0);
    let (overdue, never) = out.split_once("从未复核：").expect("two groups");
    // The 200-day decision is older than the 100-day premise: age-descending.
    let decision_at = overdue.find("A1B2C3D4").expect("old decision");
    let premise_at = overdue.find("1A2B3C4D").expect("old premise");
    assert!(decision_at < premise_at, "{overdue}");
    // An unreviewed decision and an unconfirmed premise are never-reviewed.
    assert!(never.contains("D4E5F6G7"), "{never}");
    assert!(never.contains("2B3C4D5E"), "{never}");
    assert!(never.contains("从未"), "{never}");
    // A timestamp in the future counts as reviewed today, in neither group.
    assert!(!out.contains("H7J8K9M0"), "{out}");
    // The threshold is a strict age bound.
    assert!(all_fresh.contains("（无）"), "{all_fresh}");
    assert!(all_fresh.contains("D4E5F6G7"), "{all_fresh}");
    // Structured shape: two arrays with the threshold echoed.
    assert!(json.contains("\"days\":90"), "{json}");
    assert!(json.contains("\"overdue\":["), "{json}");
    assert!(json.contains("\"never_reviewed\":["), "{json}");
    assert!(json.contains("\"type\":\"decision\""), "{json}");
    assert!(json.contains("\"age_days\":"), "{json}");
}
