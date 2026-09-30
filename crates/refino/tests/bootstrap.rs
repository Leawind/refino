//! Ports of packages/cli/test/bootstrap.test.ts (guide text) and dev.test.ts
//! (fixture generation) essentials.

mod util;

use util::{create_refino, run};

#[test]
fn guide_prints_the_agent_facing_guide() {
    let (code, out, err) = run(&["guide"]);
    assert_eq!(code, 0, "{err}");
    assert!(out.starts_with("# refino 使用指南"), "{out}");
    // The self-documentation chain: the guide is reachable from --help.
    assert!(out.contains("Decision Lineage Graph"), "{out}");
    assert!(out.contains("refino init"), "{out}");
    assert!(out.contains("[探索]"), "{out}");
}

#[test]
fn help_points_to_the_guide() {
    let args: Vec<String> = ["--help"].iter().map(|s| s.to_string()).collect();
    let mut sink = refino::format::CaptureSink::default();
    let code = refino::run(&args, &mut sink);
    assert_eq!(code, 0);
    assert!(sink.out.contains("refino guide"), "{}", sink.out);
}

#[test]
fn version_reports_the_package_version() {
    let args: Vec<String> = ["--version"].iter().map(|s| s.to_string()).collect();
    let mut sink = refino::format::CaptureSink::default();
    let code = refino::run(&args, &mut sink);
    assert_eq!(code, 0);
    assert!(sink.out.contains(env!("CARGO_PKG_VERSION")), "{}", sink.out);
}

// The dev scenarios live in one test: REFINO_DEV is process-global and the
// test harness runs tests in parallel.
#[test]
fn dev_scenarios() {
    unsafe {
        std::env::set_var("REFINO_DEV", "");
    }

    // Without REFINO_DEV=true the command does not exist at all.
    let root = create_refino(&[]);
    let (code, _, err) = run(&["--root", &util::root_arg(&root), "dev"]);
    assert_eq!(code, 1);
    assert!(err.contains("unknown command 'dev'"), "{err}");
    remove_root(&root);

    unsafe {
        std::env::set_var("REFINO_DEV", "true");
    }

    // Same seed and options reproduce the graph.
    let root_a = create_refino(&[]);
    let root_b = create_refino(&[]);
    let (code, out, err) = run(&[
        "--root",
        &util::root_arg(&root_a),
        "dev",
        "generate",
        "--nodes",
        "12",
        "--seed",
        "7",
    ]);
    assert_eq!(code, 0, "{err}");
    assert!(out.contains("(seed 7)"), "{out}");
    let count_a = count_node_files(&root_a);
    run(&[
        "--root",
        &util::root_arg(&root_b),
        "dev",
        "generate",
        "--nodes",
        "12",
        "--seed",
        "7",
    ]);
    let count_b = count_node_files(&root_b);
    remove_root(&root_a);
    remove_root(&root_b);
    assert_eq!(count_a, count_b);
    assert_eq!(count_a, 12);

    // --roots beyond the implied decision count is rejected.
    let root = create_refino(&[]);
    let (code, _, err) = run(&[
        "--root",
        &util::root_arg(&root),
        "dev",
        "generate",
        "--nodes",
        "2",
        "--premise-ratio",
        "1",
        "--roots",
        "5",
    ]);
    assert_eq!(code, 1);
    assert!(err.contains("exceeds the"), "{err}");
    remove_root(&root);

    // Generating into a non-empty .refino needs --force.
    let root = create_refino(&[util::file("nodes/1A/2B3C4D-premise.md", "Fact.\n")]);
    let (code, _, err) = run(&[
        "--root",
        &util::root_arg(&root),
        "dev",
        "generate",
        "--nodes",
        "4",
    ]);
    assert_eq!(code, 1);
    assert!(err.contains("is not empty; use --force"), "{err}");
    // --force adds nodes anyway.
    let (code, out, _) = run(&[
        "--root",
        &util::root_arg(&root),
        "dev",
        "generate",
        "--nodes",
        "4",
        "--force",
    ]);
    remove_root(&root);
    unsafe {
        std::env::remove_var("REFINO_DEV");
    }
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("(seed"), "{out}");
}

fn count_node_files(root: &std::path::Path) -> usize {
    let nodes = root.join(".refino").join("nodes");
    let mut count = 0;
    let shards = match std::fs::read_dir(&nodes) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    for shard in shards.flatten() {
        if let Ok(files) = std::fs::read_dir(shard.path()) {
            count += files
                .flatten()
                .filter(|f| f.path().extension().is_some_and(|e| e == "md"))
                .count();
        }
    }
    count
}

fn remove_root(root: &std::path::Path) {
    let _ = std::fs::remove_dir_all(root);
}
