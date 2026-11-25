//! Unit tests for the shared node-search contract (the matching semantics the
//! CLI, the web API and the TypeScript harness must agree on).

use refino_storage::{NodeContent, NodeSearchQuery, start_index};

fn content(body: &str, rationale: Option<&str>) -> NodeContent {
    NodeContent {
        body: body.to_string(),
        rationale: rationale.map(str::to_string),
    }
}

#[test]
fn resident_fields_match_id_prefixes_and_summary_substrings() {
    let query = NodeSearchQuery::new("a1b2");
    assert!(query.matches_resident("A1B2C3D4", "无关摘要"));
    assert!(!query.matches_resident("D4E5F6G7", "无关摘要"));

    let query = NodeSearchQuery::new("Repository");
    assert!(query.matches_resident("D4E5F6G7", "数据访问必须通过 Repository 层。"));
    assert!(!query.matches_resident("D4E5F6G7", "无关摘要"));

    // An empty query matches everything without paging content.
    let query = NodeSearchQuery::new("  ");
    assert!(query.matches_resident("D4E5F6G7", "任意摘要"));
    assert!(query.matches_content(&content("", None)));
}

#[test]
fn content_fallback_matches_body_and_rationale_substrings() {
    let query = NodeSearchQuery::new("KUBERNETES");
    assert!(query.matches_content(&content("集群运行 Kubernetes 1.30。", None)));
    assert!(!query.matches_content(&content("无关正文。", Some("无关理由。"))));

    let query = NodeSearchQuery::new("event sourcing");
    assert!(query.matches_content(&content(
        "无关正文。",
        Some("选择 Event Sourcing 以保留完整历史。")
    )));
    assert!(!query.matches_content(&content("只有正文。", None)));
}

#[test]
fn start_index_resumes_strictly_after_the_cursor() {
    let ids: Vec<String> = ["1A2B3C4D", "A1B2C3D4", "D4E5F6G7"]
        .iter()
        .map(|id| id.to_string())
        .collect();
    assert_eq!(start_index(&ids, None), 0);
    assert_eq!(start_index(&ids, Some("1A2B3C4D")), 1);
    // Unknown cursors resume at the next id in order.
    assert_eq!(start_index(&ids, Some("2B3C4D5E")), 1);
    assert_eq!(start_index(&ids, Some("ZZZZZZZZ")), 3);
}
