//! Ports of packages/storage/test/parser.test.ts plus golden tests for the
//! RFC 3339 conversion.

mod common;

use refino_core::{IssueCode, NodeType};
use refino_storage::{
    SUMMARY_MAX_LENGTH, StorageIssueCode, confirmed_to_ms, confirmed_to_rfc3339, extract_summary,
    is_valid_confirmed, parse_node_source,
};

fn parse_decision(source: &str) -> refino_storage::ParseResult {
    parse_node_source(
        "A1B2C3D4",
        "nodes/A1/B2C3D4-decision.md",
        NodeType::Decision,
        source,
    )
}

fn parse_premise(source: &str) -> refino_storage::ParseResult {
    parse_node_source(
        "1A2B3C4D",
        "nodes/1A/2B3C4D-premise.md",
        NodeType::Premise,
        source,
    )
}

#[test]
fn normalizes_backslash_paths_on_issues() {
    let result = parse_node_source(
        "E5F6G7H8",
        "nodes\\E5\\F6G7H8-decision.md",
        NodeType::Decision,
        "---\nsummary: 42\n---\n\nBody.\n",
    );
    assert_eq!(result.issues.len(), 1);
    assert_eq!(result.issues[0].file, "nodes/E5/F6G7H8-decision.md");
}

#[test]
fn parses_a_decision_with_grounds_summary_and_body() {
    let source = [
        "---",
        "grounds: [1A2B3C4D, D4E5F6G7]",
        "rationale: 业务层不得直接依赖数据库。",
        "---",
        "",
        "实现必须通过 Repository 层。",
        "",
        "完整的推导与权衡过程。",
    ]
    .join("\n");
    let result = parse_node_source(
        "E5F6G7H8",
        "nodes/E5/F6G7H8-decision.md",
        NodeType::Decision,
        &source,
    );
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(node.id, "E5F6G7H8");
    assert_eq!(node.summary, "实现必须通过 Repository 层。");
    assert_eq!(
        node.grounds,
        vec!["1A2B3C4D".to_string(), "D4E5F6G7".to_string()]
    );
    let content = result.content.expect("content");
    assert_eq!(
        content.body,
        "实现必须通过 Repository 层。\n\n完整的推导与权衡过程。"
    );
    assert_eq!(
        content.rationale.as_deref(),
        Some("业务层不得直接依赖数据库。")
    );
}

#[test]
fn accepts_an_empty_frontmatter_block() {
    let result = parse_premise("---\n---\n\nBody.\n");
    assert!(result.issues.is_empty());
    assert_eq!(result.content.expect("content").body, "Body.");
    assert_eq!(result.node.as_ref().expect("node").summary(), "Body.");
}

#[test]
fn derives_type_from_the_caller_not_from_frontmatter() {
    let result = parse_node_source(
        "1A2B3C4D",
        "nodes/1A/2B3C4D-decision.md",
        NodeType::Decision,
        "Body.\n",
    );
    assert_eq!(result.node.expect("node").node_type(), NodeType::Decision);
}

#[test]
fn silently_ignores_unknown_frontmatter_fields() {
    let result = parse_premise("---\nsource: somewhere\ncustom: [1, 2]\n---\n\nBody.\n");
    assert!(result.issues.is_empty());
    assert_eq!(result.content.expect("content").body, "Body.");
}

#[test]
fn omits_grounds_for_a_root_decision_declared_without_the_field() {
    let result = parse_decision("Root decision.\n");
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert!(node.grounds.is_empty());
}

#[test]
fn deduplicates_grounds_while_preserving_order() {
    let result = parse_decision("---\ngrounds: [B2C3D4E5, C3D4E5F6, B2C3D4E5]\n---\n\nBody.\n");
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(
        node.grounds,
        vec!["B2C3D4E5".to_string(), "C3D4E5F6".to_string()]
    );
}

#[test]
fn accepts_an_explicit_empty_grounds_list() {
    let result = parse_decision("---\ngrounds: []\n---\n\nBody.\n");
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert!(node.grounds.is_empty());
}

#[test]
fn normalizes_crlf_and_leading_bom() {
    let source = "\u{FEFF}---\r\ngrounds: []\r\n---\r\n\r\nFirst\r\nparagraph continues.\r\n\r\nRationale.\r\n";
    let result = parse_decision(source);
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(node.summary, "First paragraph continues.");
    let content = result.content.expect("content");
    assert_eq!(content.body, "First\nparagraph continues.\n\nRationale.");
}

#[test]
fn uses_first_paragraph_as_summary_collapsing_whitespace() {
    let result = parse_decision("Line one.\nLine two continues.\n\nRationale.\n");
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(node.summary, "Line one. Line two continues.");
}

#[test]
fn prefers_explicit_summary_over_first_paragraph() {
    let result = parse_decision(
        "---\nsummary: \"Short relevance summary.\"\n---\n\nFirst paragraph that is not the summary.\n",
    );
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(node.summary, "Short relevance summary.");
    assert_eq!(
        result.content.expect("content").body,
        "First paragraph that is not the summary."
    );
    assert!(result.summary_explicit);
}

#[test]
fn accepts_summary_on_premise_nodes() {
    let result =
        parse_premise("---\nsummary: \"PostgreSQL version fact.\"\n---\n\nLong fact body.\n");
    assert!(result.issues.is_empty());
    assert_eq!(
        result.node.as_ref().expect("node").summary(),
        "PostgreSQL version fact."
    );
}

#[test]
fn reports_issue_and_falls_back_for_non_string_summary() {
    let result = parse_decision("---\nsummary: 42\n---\n\nFallback paragraph.\n");
    assert_eq!(result.issues.len(), 1);
    assert_eq!(
        result.issues[0].code(),
        StorageIssueCode::INVALID_FRONTMATTER
    );
    assert_eq!(
        result.node.as_ref().expect("node").summary(),
        "Fallback paragraph."
    );
}

#[test]
fn truncates_long_summaries_with_ellipsis() {
    let long_paragraph = "x".repeat(SUMMARY_MAX_LENGTH + 10);
    let result = parse_decision(&format!("{long_paragraph}\n"));
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(
        node.summary,
        format!("{}...", "x".repeat(SUMMARY_MAX_LENGTH))
    );
    assert_eq!(node.summary.chars().count(), SUMMARY_MAX_LENGTH + 3);
}

#[test]
fn reports_invalid_frontmatter_for_broken_yaml() {
    let result = parse_decision("---\ngrounds: [unclosed\n---\n\nBody.\n");
    assert!(result.node.is_none());
    assert_eq!(
        result
            .issues
            .iter()
            .map(|i| i.code().to_string())
            .collect::<Vec<_>>(),
        vec![StorageIssueCode::INVALID_FRONTMATTER.to_string()]
    );
}

#[test]
fn reports_invalid_frontmatter_when_not_a_mapping() {
    let result = parse_decision("---\n- a\n- b\n---\n\nBody.\n");
    assert_eq!(
        result
            .issues
            .iter()
            .map(|i| i.code().to_string())
            .collect::<Vec<_>>(),
        vec![StorageIssueCode::INVALID_FRONTMATTER.to_string()]
    );
}

#[test]
fn silently_ignores_grounds_on_a_premise_file() {
    let result = parse_node_source(
        "2B3C4D5E",
        "nodes/1A/2B3C4D-premise.md",
        NodeType::Premise,
        "---\ngrounds: [A1B2C3D4]\n---\n\nBody.\n",
    );
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_premise())
        .expect("premise");
    assert_eq!(node.id, "2B3C4D5E");
    assert_eq!(node.summary, "Body.");
    assert_eq!(node.confirmed, None);
}

#[test]
fn marks_a_decision_exploring_when_the_field_is_true() {
    let result = parse_decision("---\nexploring: true\n---\n\nBody.\n");
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(node.exploring, Some(true));
}

#[test]
fn treats_explicit_false_exploring_like_absence() {
    let result = parse_decision("---\nexploring: false\n---\n\nBody.\n");
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_decision())
        .expect("decision");
    assert_eq!(node.exploring, None);
}

#[test]
fn reports_invalid_exploring_for_non_boolean_values() {
    for value in ["\"true\"", "1", "[true]"] {
        let result = parse_decision(&format!("---\nexploring: {value}\n---\n\nBody.\n"));
        assert_eq!(
            result
                .issues
                .iter()
                .map(|i| i.code().to_string())
                .collect::<Vec<_>>(),
            vec![StorageIssueCode::INVALID_EXPLORING.to_string()],
            "value: {value}"
        );
        let node = result
            .node
            .as_ref()
            .and_then(|n| n.as_decision())
            .expect("decision");
        assert_eq!(node.exploring, None);
    }
}

#[test]
fn silently_ignores_exploring_on_a_premise_file() {
    let result = parse_node_source(
        "2B3C4D5E",
        "nodes/1A/2B3C4D-premise.md",
        NodeType::Premise,
        "---\nexploring: true\n---\n\nBody.\n",
    );
    assert!(result.issues.is_empty());
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_premise())
        .expect("premise");
    assert_eq!(node.id, "2B3C4D5E");
    assert_eq!(node.summary, "Body.");
}

#[test]
fn converts_valid_confirmed_to_epoch_milliseconds() {
    let result = parse_premise("---\nconfirmed: 2026-05-01T12:00:00+08:00\n---\n\nBody.\n");
    assert!(result.issues.is_empty(), "{:?}", result.issues);
    let node = result
        .node
        .as_ref()
        .and_then(|n| n.as_premise())
        .expect("premise");
    // 2026-05-01T04:00:00Z
    assert_eq!(node.confirmed, Some(1_777_608_000_000));
}

#[test]
fn reports_invalid_confirmed_for_missing_offset_and_bad_values() {
    for confirmed in ["2026-05-01T12:00:00", "2026-05-01", "yesterday"] {
        let result = parse_premise(&format!("---\nconfirmed: {confirmed}\n---\n\nBody.\n"));
        assert_eq!(
            result
                .issues
                .iter()
                .map(|i| i.code().to_string())
                .collect::<Vec<_>>(),
            vec![StorageIssueCode::INVALID_CONFIRMED.to_string()],
            "confirmed: {confirmed}"
        );
        let node = result
            .node
            .as_ref()
            .and_then(|n| n.as_premise())
            .expect("premise");
        assert_eq!(node.confirmed, None);
    }
}

#[test]
fn rejects_grounds_not_a_list() {
    let result = parse_decision("---\ngrounds: B2C3D4E5\n---\n\nBody.\n");
    assert_eq!(
        result
            .issues
            .iter()
            .map(|i| i.code().to_string())
            .collect::<Vec<_>>(),
        vec![IssueCode::INVALID_GROUNDS.to_string()]
    );
    assert!(
        result.issues[0]
            .message()
            .contains("\"grounds\" must be a list of node ids, got \"B2C3D4E5\".")
    );
}

#[test]
fn rejects_grounds_entry_not_a_string() {
    // A non-list grounds value is rejected; an unknown field is ignored.
    let result = parse_decision("---\ngrounds: [3]\n---\n\nBody.\n");
    assert_eq!(
        result
            .issues
            .iter()
            .map(|i| i.code().to_string())
            .collect::<Vec<_>>(),
        vec![IssueCode::INVALID_GROUNDS.to_string()]
    );
    assert!(
        result.issues[0]
            .message()
            .contains("\"grounds\" entries must be non-empty strings, got 3.")
    );
}

#[test]
fn extract_summary_does_not_truncate_within_the_limit() {
    assert_eq!(extract_summary("short"), "short");
}

// ---- RFC 3339 conversion (the Date.parse / toISOString pair) ----

#[test]
fn confirmed_round_trip_matches_date_semantics() {
    // 2026-05-01T00:00:00Z == 1777689600000
    assert_eq!(
        confirmed_to_ms("2026-05-01T00:00:00Z"),
        Some(1_777_593_600_000)
    );
    assert_eq!(
        confirmed_to_ms("2026-05-01T00:00:00.500Z"),
        Some(1_777_593_600_500)
    );
    assert_eq!(
        confirmed_to_ms("2026-05-01T00:00:00+08:00"),
        Some(1_777_564_800_000)
    );
    assert_eq!(confirmed_to_ms("2026-02-29T00:00:00Z"), None); // 2026 is not a leap year
    assert_eq!(
        confirmed_to_ms("2024-02-29T00:00:00Z"),
        Some(1_709_164_800_000)
    );
    assert!(is_valid_confirmed("2026-05-01T12:00:00-05:30"));
    assert!(!is_valid_confirmed("2026-05-01 12:00:00Z"));
}

#[test]
fn to_rfc3339_uses_the_iso_utc_shape() {
    assert_eq!(
        confirmed_to_rfc3339(1_777_593_600_000).unwrap(),
        "2026-05-01T00:00:00.000Z"
    );
    assert_eq!(confirmed_to_rfc3339(0).unwrap(), "1970-01-01T00:00:00.000Z");
    // One day before the epoch exercises negative day handling.
    assert_eq!(
        confirmed_to_rfc3339(-86_400_000).unwrap(),
        "1969-12-31T00:00:00.000Z"
    );
}
