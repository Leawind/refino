//! Ports of packages/cli/test/web-query.test.ts: the canvas on-demand query
//! contract (docs/design.md, "画布按需查询") over the resident store, driven
//! in-process via tower oneshot (the counterpart of Hono's app.request).
//!
//! Fixture shape:
//!   P1 1A2B3C4D   P2 1A2B3C4E   P3 1A2B3C4F
//!   C1 A1B2C3D4 grounds [P1]
//!   C2 D4E5F6G7 grounds [C1, P2]
//!   C3 E5F6G7H8 grounds [C2]
//!   C4 H7J8K9M0 grounds [C1, P2]
//!   C5 N0P1Q2R3 grounds [P3]        (separate branch)
//!   C6 S4T5V6W7 grounds [P1, P2]    (strong sibling of C1 and C2)

use axum::body::Body;
use axum::http::{Request, StatusCode};
use refino_fs::FsIo;
use refino_server::{AppState, router};
use refino_storage::RefinoStore;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tower::ServiceExt as _;

static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

fn create_refino(files: &[(&str, String)]) -> PathBuf {
    let n = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("refino-web-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for (relative, content) in files {
        let path = root.join(".refino").join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    root
}

fn premise_body(_id: &str, summary: &str) -> String {
    format!("{summary}\n")
}

fn decision_body(_id: &str, grounds: &[&str], summary: &str) -> String {
    if grounds.is_empty() {
        format!("{summary}\n")
    } else {
        let list: Vec<String> = grounds.iter().map(|g| format!("\"{g}\"")).collect();
        format!("---\ngrounds: [{}]\n---\n\n{summary}\n", list.join(", "))
    }
}

fn app_state(refino_dir: PathBuf) -> Arc<AppState> {
    let store = RefinoStore::new(FsIo, refino_fs::OsRandom, refino_dir);
    let (changes, _) = tokio::sync::broadcast::channel(16);
    Arc::new(AppState {
        store: Arc::new(Mutex::new(store)),
        changes,
        static_root: None,
    })
}

async fn post(app: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn get(app: &axum::Router, path: &str) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// `id:depth` pairs of the first group's results.
fn depth_pairs(body: &Value) -> Vec<String> {
    body[0]["results"][0]["nodes"]
        .as_array()
        .expect("nodes array")
        .iter()
        .map(|n| {
            format!(
                "{}:{}",
                n["id"].as_str().unwrap_or(""),
                n["depth"].as_i64().unwrap_or(-1)
            )
        })
        .collect()
}

const P1: &str = "1A2B3C4D";
const P2: &str = "1A2B3C4E";
const P3: &str = "1A2B3C4F";
const C1: &str = "A1B2C3D4";
const C2: &str = "D4E5F6G7";
const C3: &str = "E5F6G7H8";
const C4: &str = "H7J8K9M0";
const C5: &str = "N0P1Q2R3";
const C6: &str = "S4T5V6W7";

fn fixture() -> (axum::Router, PathBuf) {
    let root = create_refino(&[
        ("nodes/1A/2B3C4D-premise.md", premise_body(P1, "前提一。")),
        ("nodes/1A/2B3C4E-premise.md", premise_body(P2, "前提二。")),
        ("nodes/1A/2B3C4F-premise.md", premise_body(P3, "前提三。")),
        (
            "nodes/A1/B2C3D4-decision.md",
            decision_body(C1, &[P1], "C1。"),
        ),
        (
            "nodes/D4/E5F6G7-decision.md",
            decision_body(C2, &[C1, P2], "C2。"),
        ),
        (
            "nodes/E5/F6G7H8-decision.md",
            decision_body(C3, &[C2], "C3。"),
        ),
        (
            "nodes/H7/J8K9M0-decision.md",
            decision_body(C4, &[C1, P2], "C4。"),
        ),
        (
            "nodes/N0/P1Q2R3-decision.md",
            decision_body(C5, &[P3], "C5。"),
        ),
        (
            "nodes/S4/T5V6W7-decision.md",
            decision_body(C6, &[P1, P2], "C6。"),
        ),
    ]);
    let app = router(app_state(root.join(".refino")));
    (app, root)
}

#[tokio::test]
async fn neighbors_returns_bounded_ancestors_and_descendants() {
    let (app, root) = fixture();
    let (status, body) = post(
        &app,
        "/api/query/neighbors",
        json!({ "ids": [C3], "ancestorDepth": 1, "descendantDepth": 1 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body[0]["results"][0]["truncated"], json!(false));
    // The anchor itself is part of its neighborhood at depth 0.
    assert_eq!(
        depth_pairs(&body),
        vec![format!("{C3}:0"), format!("{C2}:1")]
    );
}

#[tokio::test]
async fn neighbors_reaches_premises_at_ancestor_depth_2() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/neighbors",
        json!({ "ids": [C3], "ancestorDepth": 2, "descendantDepth": 0 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    // depth ties are ordered by id: 1A2B3C4E < A1B2C3D4.
    assert_eq!(
        depth_pairs(&body),
        vec![
            format!("{C3}:0"),
            format!("{C2}:1"),
            format!("{P2}:2"),
            format!("{C1}:2")
        ]
    );
}

#[tokio::test]
async fn neighbors_truncates_nearest_first_and_flags_it() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/neighbors",
        json!({ "ids": [C1], "ancestorDepth": 0, "descendantDepth": 2, "limit": 2 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(body[0]["results"][0]["truncated"], json!(true));
    let depths: Vec<i64> = body[0]["results"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["depth"].as_i64().unwrap())
        .collect();
    assert_eq!(depths, vec![0, 1]);
}

#[tokio::test]
async fn neighbors_answers_207_with_per_id_error() {
    let (app, root) = fixture();
    let (status, body) = post(
        &app,
        "/api/query/neighbors",
        json!({ "ids": [C1, "ZZZZZZZZ"], "ancestorDepth": 1, "descendantDepth": 1 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::MULTI_STATUS);
    assert!(body[0].get("results").is_some());
    assert!(body[1].get("error").is_some());
}

#[tokio::test]
async fn grounds_returns_direct_grounds_in_declared_order() {
    let (app, root) = fixture();
    let (status, body) = post(&app, "/api/query/grounds", json!({ "ids": [C2] })).await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = body[0]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    let (status, _) = post(&app, "/api/query/grounds", json!({ "ids": ["ZZZZZZZZ"] })).await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(ids, vec![C1, P2]);
    assert_eq!(status, StatusCode::MULTI_STATUS);
}

#[tokio::test]
async fn range_selects_decisions_between_ancestor_descendant_pair() {
    let (app, root) = fixture();
    let (status, body) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": C3, "clickedId": C1 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["mode"], json!("ancestor"));
    let pairs: Vec<String> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            format!(
                "{}:{}",
                n["id"].as_str().unwrap(),
                n["depth"].as_i64().unwrap()
            )
        })
        .collect();
    let (_, second) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": C1, "clickedId": C3 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(
        pairs,
        vec![format!("{C3}:0"), format!("{C2}:1"), format!("{C1}:2")]
    );
    assert!(
        body["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["id"] != json!(P1))
    );
    assert_eq!(second["mode"], json!("ancestor"));
    let second_pairs: Vec<String> = second["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            format!(
                "{}:{}",
                n["id"].as_str().unwrap(),
                n["depth"].as_i64().unwrap()
            )
        })
        .collect();
    assert_eq!(
        second_pairs,
        vec![format!("{C1}:0"), format!("{C2}:1"), format!("{C3}:2")]
    );
}

#[tokio::test]
async fn range_selects_both_branch_paths_to_common_ancestor() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": C3, "clickedId": C4 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(body["mode"], json!("branches"));
    let pairs: Vec<String> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            format!(
                "{}:{}",
                n["id"].as_str().unwrap(),
                n["depth"].as_i64().unwrap()
            )
        })
        .collect();
    assert_eq!(
        pairs,
        vec![
            format!("{C3}:0"),
            format!("{C2}:1"),
            format!("{C1}:2"),
            format!("{C4}:3")
        ]
    );
}

#[tokio::test]
async fn range_degrades_to_clicked_node_for_unrelated_endpoints() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": C3, "clickedId": C5 }),
    )
    .await;
    assert_eq!(body["mode"], json!("disconnected"));
    let ids: Vec<&str> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![C5]);
    assert!(body["nodes"][0]["depth"].is_null());

    // Budget exhaustion reports disconnected too.
    let (_, body) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": C3, "clickedId": C5, "budget": 1 }),
    )
    .await;
    assert_eq!(body["mode"], json!("disconnected"));

    // Unknown endpoints answer 404.
    let (status, _) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": C3, "clickedId": "ZZZZZZZZ" }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn expand_closes_full_upstream_and_one_descendant_generation() {
    let (app, root) = fixture();
    let (status, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C2], "descendantDepth": 1, "showSiblings": false }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body[0]["results"][0]["truncated"], json!(false));
    // C2's upstream to the roots (C1, P2, P1), its descendant C3, itself.
    assert_eq!(
        depth_pairs(&body),
        vec![
            format!("{C2}:0"),
            format!("{P2}:1"),
            format!("{C1}:1"),
            format!("{C3}:1"),
            format!("{P1}:2"),
        ]
    );
}

#[tokio::test]
async fn expand_joins_strong_siblings_and_closes_their_upstream() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C1], "descendantDepth": 1 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    // Downstream C2/C4, C6 joins as C1's sibling via shared ground P1 at
    // distance 2, and C2/C4's side ground P2 closes in.
    assert_eq!(body[0]["results"][0]["truncated"], json!(false));
    assert_eq!(
        depth_pairs(&body),
        vec![
            format!("{C1}:0"),
            format!("{P1}:1"),
            format!("{C2}:1"),
            format!("{C4}:1"),
            format!("{P2}:2"),
            format!("{C6}:2"),
        ]
    );
}

#[tokio::test]
async fn expand_omits_siblings_when_show_siblings_false() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C1], "descendantDepth": 0, "showSiblings": false }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    let ids: Vec<&str> = body[0]["results"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![C1, P1]);
}

#[tokio::test]
async fn expand_keeps_at_most_sibling_limit_siblings() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C2], "descendantDepth": 0, "siblingLimit": 1 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    // C4 (overlap 2 with C2) beats C6 (overlap 1); C4 joins at distance 2.
    assert_eq!(
        depth_pairs(&body),
        vec![
            format!("{C2}:0"),
            format!("{P2}:1"),
            format!("{C1}:1"),
            format!("{P1}:2"),
            format!("{C4}:2"),
        ]
    );
}

#[tokio::test]
async fn expand_walks_full_descendant_closure_when_depth_omitted() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C1], "showSiblings": false }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    // C3 sits two generations below C1 — beyond the default depth bound.
    assert_eq!(body[0]["results"][0]["truncated"], json!(false));
    assert_eq!(
        depth_pairs(&body),
        vec![
            format!("{C1}:0"),
            format!("{P1}:1"),
            format!("{C2}:1"),
            format!("{C4}:1"),
            format!("{P2}:2"),
            format!("{C3}:2"),
        ]
    );
}

#[tokio::test]
async fn expand_truncates_nearest_first_and_flags_it() {
    let (app, root) = fixture();
    let (_, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C1], "descendantDepth": 1, "limit": 3 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(body[0]["results"][0]["truncated"], json!(true));
    let depths: Vec<i64> = body[0]["results"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["depth"].as_i64().unwrap())
        .collect();
    assert_eq!(depths, vec![0, 1, 1]);
}

#[tokio::test]
async fn expand_answers_207_with_per_id_error() {
    let (app, root) = fixture();
    let (status, body) = post(
        &app,
        "/api/query/expand",
        json!({ "ids": [C1, "ZZZZZZZZ"], "descendantDepth": 1 }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::MULTI_STATUS);
    assert!(body[0].get("results").is_some());
    assert!(body[1].get("error").is_some());
}

#[tokio::test]
async fn range_branches_excludes_off_path_sibling_branches() {
    // F grounds [A, B]; A grounds L, B grounds M (a sibling branch); K
    // grounds L. B and M are off the F->L and K->L paths and must not
    // appear in a branches selection between F and K.
    let root = create_refino(&[
        (
            "nodes/AA/000001-decision.md",
            decision_body("AA000001", &["AA000002", "AA000003"], "F。"),
        ),
        (
            "nodes/AA/000002-decision.md",
            decision_body("AA000002", &["AA000004"], "A。"),
        ),
        (
            "nodes/AA/000003-decision.md",
            decision_body("AA000003", &["AA000005"], "B。"),
        ),
        (
            "nodes/AA/000004-decision.md",
            decision_body("AA000004", &[], "L。"),
        ),
        (
            "nodes/AA/000005-decision.md",
            decision_body("AA000005", &[], "M。"),
        ),
        (
            "nodes/AA/000006-decision.md",
            decision_body("AA000006", &["AA000004"], "K。"),
        ),
    ]);
    let app = router(app_state(root.join(".refino")));
    let (_, body) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": "AA000001", "clickedId": "AA000006" }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(body["mode"], json!("branches"));
    let pairs: Vec<String> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            format!(
                "{}:{}",
                n["id"].as_str().unwrap(),
                n["depth"].as_i64().unwrap()
            )
        })
        .collect();
    assert_eq!(
        pairs,
        vec![
            "AA000001:0".to_string(),
            "AA000002:1".to_string(),
            "AA000004:2".to_string(),
            "AA000006:3".to_string(),
        ]
    );
}

#[tokio::test]
async fn range_branches_takes_one_shortest_path_in_a_diamond() {
    // X grounds [Y, Z]; Y and Z both ground W (two equal X->W routes); W2
    // grounds W; S grounds W2. A branches selection between X and S walks
    // one route (id-ascending: Y), never both.
    let root = create_refino(&[
        (
            "nodes/BB/000001-decision.md",
            decision_body("BB000001", &["BB000002", "BB000003"], "X。"),
        ),
        (
            "nodes/BB/000002-decision.md",
            decision_body("BB000002", &["BB000004"], "Y。"),
        ),
        (
            "nodes/BB/000003-decision.md",
            decision_body("BB000003", &["BB000004"], "Z。"),
        ),
        (
            "nodes/BB/000004-decision.md",
            decision_body("BB000004", &[], "W。"),
        ),
        (
            "nodes/BB/000005-decision.md",
            decision_body("BB000005", &["BB000004"], "W2。"),
        ),
        (
            "nodes/BB/000006-decision.md",
            decision_body("BB000006", &["BB000005"], "S。"),
        ),
    ]);
    let app = router(app_state(root.join(".refino")));
    let (_, body) = post(
        &app,
        "/api/query/range",
        json!({ "focusId": "BB000001", "clickedId": "BB000006" }),
    )
    .await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(body["mode"], json!("branches"));
    let pairs: Vec<String> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            format!(
                "{}:{}",
                n["id"].as_str().unwrap(),
                n["depth"].as_i64().unwrap()
            )
        })
        .collect();
    assert_eq!(
        pairs,
        vec![
            "BB000001:0".to_string(),
            "BB000002:1".to_string(),
            "BB000004:2".to_string(),
            "BB000005:3".to_string(),
            "BB000006:4".to_string(),
        ]
    );
    assert!(
        body["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["id"] != json!("BB000003"))
    );
}

#[tokio::test]
async fn search_paginates_with_keyset_cursor() {
    let (app, root) = fixture();
    let (status, page1) = get(&app, "/api/search?limit=4").await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<&str> = page1["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![P1, P2, P3, C1]);
    assert_eq!(page1["nextCursor"], json!(C1));

    let (_, page2) = get(&app, &format!("/api/search?limit=4&cursor={C1}")).await;
    let ids: Vec<&str> = page2["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![C2, C3, C4, C5]);
    assert_eq!(page2["nextCursor"], json!(C5));

    let (_, page3) = get(&app, &format!("/api/search?limit=4&cursor={C5}")).await;
    let ids: Vec<&str> = page3["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![C6]);
    assert!(page3["nextCursor"].is_null());
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn search_filters_by_type_and_matches_prefix_and_summary() {
    let (app, root) = fixture();
    let (_, body) = get(&app, "/api/search?type=premise").await;
    let ids: Vec<&str> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![P1, P2, P3]);

    let (_, body) = get(&app, "/api/search?q=1a2b").await;
    let ids: Vec<&str> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![P1, P2, P3]);

    let (_, body) = get(&app, "/api/search?q=%E5%89%8D%E6%8F%90%E4%B8%89").await;
    let ids: Vec<&str> = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![P3]);

    let (status, _) = get(&app, "/api/search?type=nonsense").await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn get_node_returns_full_record_with_revision() {
    let (app, root) = fixture();
    let (status, body) = get(&app, &format!("/api/nodes/{C2}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], json!(1));
    assert_eq!(body["node"]["body"], json!("C2。"));
    assert_eq!(body["node"]["grounds"], json!([C1, P2]));
    assert_eq!(body["issues"], json!([]));

    let (status, _) = get(&app, "/api/nodes/ZZZZZZZZ").await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_graph_serves_whole_graph_with_bodies() {
    let (app, root) = fixture();
    let (status, body) = get(&app, "/api/graph").await;
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["revision"], json!(1));
    assert_eq!(body["issues"], json!([]));
    let c1 = body["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == json!(C1))
        .expect("C1 present");
    assert_eq!(c1["body"], json!("C1。"));
}
