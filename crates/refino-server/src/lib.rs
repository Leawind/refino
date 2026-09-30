//! Local HTTP service over the storage Store (docs/design.md, "存储层
//! Store" + "Web 界面"). All endpoints return JSON; errors are
//! `{ error: string, issues?: [...] }` with a mapped status code. Grounds
//! validity and cycles are enforced inside the store's write methods, so the
//! stored files never become invalid through the API.

pub mod query;
pub mod watch;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use refino_core::{
    get_dependents, is_valid_id, IssueCode, NodeType, QueryGroup, RefinoError, RefinoNode,
};
use refino_fs::FsIo;
use refino_storage::{
    confirmed_to_ms, is_valid_confirmed, RefinoStore, StoreIssue, StorageIssueCode, WatcherCore,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Wire code for request-shape errors raised by the web layer itself.
pub const INVALID_REQUEST: &str = "INVALID_REQUEST";

/// Shared server state: the watched store plus the change feed's broadcast
/// channel.
pub struct AppState {
    pub store: Mutex<RefinoStore<FsIo>>,
    /// SSE change feed receivers (docs/design.md, "外部变更同步").
    pub changes: tokio::sync::broadcast::Sender<ChangeFeed>,
    /// Directory holding the built `@refino/ui` assets; `None` disables
    /// static hosting (placeholder only).
    pub static_root: Option<PathBuf>,
}

/// The SSE wire event: `{ revision, changed, deleted, origin?, reload? }` —
/// the store change minus the internal `affected`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChangeFeed {
    pub revision: u64,
    pub changed: Vec<String>,
    pub deleted: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<refino_storage::Origin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reload: Option<bool>,
}

pub fn change_feed(change: &refino_storage::StoreChange) -> ChangeFeed {
    ChangeFeed {
        revision: change.revision,
        changed: change.changed.clone(),
        deleted: change.deleted.clone(),
        origin: change.origin,
        reload: change.reload,
    }
}

/// Build the router over a ready-or-not store. Handlers await readiness
/// lazily through `store.ready()` before dispatching.
pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/graph", get(get_graph))
        .route("/api/validate", get(get_validate))
        .route("/api/nodes/{id}", get(get_node).put(put_node).delete(delete_node))
        .route("/api/nodes/premise", post(post_premise))
        .route("/api/nodes/decision", post(post_decision))
        .route("/api/reload", post(post_reload))
        .route("/api/query/neighbors", post(query_neighbors))
        .route("/api/query/grounds", post(query_grounds))
        .route("/api/query/range", post(query_range))
        .route("/api/query/expand", post(query_expand))
        .route("/api/search", get(get_search))
        .route("/api/stats", get(get_stats))
        .route("/api/events", get(get_events))
        .with_state(state.clone());

    let static_root = state.static_root.clone();
    let fallback_state = state;
    api.fallback(move |req| {
        let static_root = static_root.clone();
        async move { static_fallback(req, static_root).await }
    })
}

async fn static_fallback(
    req: axum::extract::Request,
    static_root: Option<PathBuf>,
) -> Response {
    use tower::ServiceExt as _;
    if req.method() == axum::http::Method::GET {
        if let Some(root) = static_root {
            let service = tower_http::services::ServeDir::new(&root);
            if let Ok(response) = service.oneshot(req).await {
                if response.status() != StatusCode::NOT_FOUND {
                    return response.into_response();
                }
            }
            // SPA fallback: unmatched GET requests get the app shell.
            if let Ok(index) = std::fs::read_to_string(root.join("index.html")) {
                return (StatusCode::OK, [("content-type", "text/html")], index).into_response();
            }
        }
    }
    (
        StatusCode::OK,
        [("content-type", "text/html")],
        "<!doctype html><html><body><h1>refino web</h1></body></html>",
    )
        .into_response()
}

// ---- error mapping ----

/// Map errors to HTTP responses; issue-bearing rejections carry their issues.
pub fn error_response(error: &ApiError) -> Response {
    match error {
        ApiError::Refino(error) => {
            let status = if error.code == IssueCode::NODE_NOT_FOUND
                || error.code == StorageIssueCode::REFINO_DIR_NOT_FOUND
            {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(json!({ "error": error.message }))).into_response()
        }
        ApiError::Rejected(rejected) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": rejected.to_string(), "issues": rejected.issues })),
        )
            .into_response(),
        ApiError::Unavailable => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "API is unavailable without a .refino directory." })),
        )
            .into_response(),
    }
}

/// Errors a handler can produce.
pub enum ApiError {
    Refino(RefinoError),
    Rejected(refino_storage::WriteRejected),
    Unavailable,
}

impl From<RefinoError> for ApiError {
    fn from(error: RefinoError) -> Self {
        ApiError::Refino(error)
    }
}

impl From<refino_storage::StoreError> for ApiError {
    fn from(error: refino_storage::StoreError) -> Self {
        match error {
            refino_storage::StoreError::Rejected(rejected) => ApiError::Rejected(rejected),
            refino_storage::StoreError::Other(error) => ApiError::Refino(error),
        }
    }
}

type ApiResult = Result<Response, ApiError>;

/// Lock the store, ensure readiness, run the handler.
fn with_store<R>(
    state: &AppState,
    body: impl FnOnce(&mut RefinoStore<FsIo>) -> Result<R, ApiError>,
) -> ApiResult {
    let mut store = state.store.lock().expect("store lock");
    store.ready().map_err(ApiError::from)?;
    body(&mut store)
}

// ---- read endpoints ----

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// The node record as exposed over the API.
pub fn node_json(node: &RefinoNode, content: &refino_storage::NodeContent) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("id".into(), json!(node.id()));
    map.insert(
        "type".into(),
        json!(match node.node_type() {
            NodeType::Premise => "premise",
            NodeType::Decision => "decision",
        }),
    );
    map.insert("summary".into(), json!(node.summary()));
    map.insert("body".into(), json!(content.body));
    if let Some(decision) = node.as_decision() {
        map.insert("grounds".into(), json!(decision.grounds));
        if let Some(rationale) = &content.rationale {
            map.insert("rationale".into(), json!(rationale));
        }
        if decision.exploring == Some(true) {
            map.insert("exploring".into(), json!(true));
        }
    }
    if let Some(premise) = node.as_premise() {
        if let Some(confirmed) = premise.confirmed {
            map.insert("confirmed".into(), json!(confirmed));
        }
    }
    Value::Object(map)
}

async fn get_graph(State(state): State<Arc<AppState>>) -> Response {
    let result = with_store(&state, |store| {
        let mut nodes: Vec<_> = store.graph().nodes.values().cloned().collect();
        nodes.sort_by(|a, b| a.id().cmp(b.id()));
        let mut rows = Vec::new();
        for node in &nodes {
            let content = store.content(node.id())?.unwrap_or_default();
            let mut row = node_json(&node.node, &content);
            if let Some(object) = row.as_object_mut() {
                object.insert("dependents".into(), json!(node.children));
            }
            rows.push(row);
        }
        Ok(Json(json!({
            "revision": store.revision(),
            "issues": store.issues(),
            "nodes": rows,
        })))
    });
    finish(result)
}

async fn get_validate(State(state): State<Arc<AppState>>) -> Response {
    let result = with_store(&state, |store| {
        let issues = store.issues();
        Ok(Json(json!({
            "ok": issues.is_empty(),
            "issues": issues,
            "revision": store.revision(),
        })))
    });
    finish(result)
}

async fn get_node(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let result = with_store(&state, |store| {
        let Some(entry) = store.entry(&id).cloned() else {
            return Err(ApiError::from(RefinoError::new(
                IssueCode::NODE_NOT_FOUND,
                format!("Node \"{id}\" does not exist."),
            )));
        };
        let content = store.content(&id)?.unwrap_or_default();
        Ok(Json(json!({
            "revision": entry.revision,
            "node": node_json(&entry.node.node, &content),
            "issues": store.issues_for(&id),
        })))
    });
    finish(result)
}

async fn delete_node(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let result = with_store(&state, |store| {
        if store.entry(&id).is_none() {
            return Err(ApiError::Refino(RefinoError::new(
                IssueCode::NODE_NOT_FOUND,
                format!("Node \"{id}\" does not exist."),
            )));
        }
        let affected = get_dependents(&store.graph().clone(), &id, Default::default())?;
        if !affected.is_empty() {
            let dependents: Vec<Value> = affected
                .iter()
                .map(|entry| json!({ "id": entry.node.id(), "depth": entry.depth }))
                .collect();
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({
                    "error": format!(
                        "Node \"{id}\" is still referenced by {} downstream decision(s).",
                        affected.len()
                    ),
                    "dependents": dependents,
                }))
                .into_response(),
            ));
        }
        let outcome = store.delete_node(&id)?;
        if let Some(change) = outcome.change {
            broadcast(&state, &change);
        }
        let deleted: Response = Json(json!({ "id": id })).into_response();
        Ok(deleted)
    });
    finish(result)
}

async fn post_reload(State(state): State<Arc<AppState>>) -> Response {
    let result = with_store(&state, |store| {
        let change = store.reload()?;
        broadcast(&state, &change);
        Ok(Json(serde_json::to_value(change_feed(&change)).unwrap_or_default()))
    });
    finish(result)
}

fn broadcast(state: &AppState, change: &refino_storage::StoreChange) {
    let _ = state.changes.send(change_feed(change));
}

fn finish(result: ApiResult) -> Response {
    match result {
        Ok(response) => response,
        Err(error) => error_response(&error),
    }
}

// ---- write endpoints ----

async fn post_premise(State(state): State<Arc<AppState>>, body: Result<Json<Value>, JsonRejection>) -> Response {
    match body {
        Err(_) => error_response(&ApiError::Refino(RefinoError::new(
            INVALID_REQUEST,
            "Request body must be valid JSON.",
        ))),
        Ok(Json(payload)) => {
            let result = with_store(&state, |store| create_node(store, &state, &payload, NodeType::Premise, None));
            finish(result)
        }
    }
}

async fn post_decision(State(state): State<Arc<AppState>>, body: Result<Json<Value>, JsonRejection>) -> Response {
    match body {
        Err(_) => error_response(&ApiError::Refino(RefinoError::new(
            INVALID_REQUEST,
            "Request body must be valid JSON.",
        ))),
        Ok(Json(payload)) => {
            let result = with_store(&state, |store| create_node(store, &state, &payload, NodeType::Decision, None));
            finish(result)
        }
    }
}

fn create_node(
    store: &mut RefinoStore<FsIo>,
    state: &AppState,
    payload: &Value,
    node_type: NodeType,
    explicit_id: Option<String>,
) -> ApiResult {
    let body = required_string(payload, "body")?;
    let summary = optional_string(payload, "summary")?;
    let confirmed = read_confirmed(payload)?;
    let outcome = match node_type {
        NodeType::Premise => store.create_premise(&refino_storage::CreatePremiseOptions {
            base: refino_storage::CreateOptions { body, id: explicit_id, summary },
            confirmed,
        })?,
        NodeType::Decision => store.create_decision(&refino_storage::CreateDecisionOptions {
            base: refino_storage::CreateOptions { body, id: explicit_id, summary },
            grounds: resolve_grounds(payload)?,
            rationale: optional_string(payload, "rationale")?,
            exploring: read_exploring(payload)?.unwrap_or(false),
        })?,
    };
    if let Some(change) = outcome.change {
        broadcast(state, &change);
    }
    let revision = store.entry(&outcome.id).map(|e| e.revision);
    Ok((StatusCode::CREATED, Json(json!({ "id": outcome.id, "revision": revision }))).into_response())
}

async fn put_node(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return error_response(&ApiError::Refino(RefinoError::new(
            INVALID_REQUEST,
            "Request body must be valid JSON.",
        )));
    };
    let result = with_store(&state, |store| {
        if store.entry(&id).is_none() {
            return create_with_id(store, &state, &id, &payload);
        }
        let entry = store.entry(&id).cloned().expect("checked");
        let body_text = required_string(&payload, "body")?;
        let summary = optional_string(&payload, "summary")?;
        let client_revision = read_revision(&payload)?;
        if let Some(client) = client_revision {
            if client != entry.revision {
                let conflict: Response = (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "error": format!(
                            "Node \"{id}\" changed externally since it was opened; reload before saving."
                        ),
                        "revision": entry.revision,
                    })),
                )
                    .into_response();
                return Ok(conflict);
            }
        }
        if let Some(type_field) = optional_string(&payload, "type")? {
            let current = match entry.node.node_type() {
                NodeType::Premise => "premise",
                NodeType::Decision => "decision",
            };
            if type_field != current {
                return Err(ApiError::Refino(RefinoError::new(
                    INVALID_REQUEST,
                    format!(
                        "\"type\" does not match the existing node \"{id}\"; node types cannot change."
                    ),
                )));
            }
        }
        let change = match &entry.node.node {
            RefinoNode::Premise(premise) => {
                store.update_premise(
                    &id,
                    &refino_storage::UpdatePremiseOptions {
                        base: refino_storage::UpdateOptions { body: body_text, summary },
                        confirmed: read_confirmed(&payload)?.or(premise.confirmed),
                    },
                )?
            }
            RefinoNode::Decision(decision) => {
                let grounds = resolve_grounds(&payload)?;
                store.update_decision(
                    &id,
                    &refino_storage::UpdateDecisionOptions {
                        base: refino_storage::UpdateOptions { body: body_text, summary },
                        grounds: if payload.get("grounds").is_some() {
                            grounds
                        } else {
                            Some(decision.grounds.clone())
                        },
                        rationale: optional_string(&payload, "rationale")?.or(content_rationale(store, &id)),
                        exploring: read_exploring(&payload)?.unwrap_or(false),
                    },
                )?
            }
        };
        if let Some(change) = change.change {
            broadcast(&state, &change);
        }
        let revision = store.entry(&id).map(|e| e.revision);
        Ok(Json(json!({ "id": id, "revision": revision })).into_response())
    });
    finish(result)
}

fn content_rationale(store: &RefinoStore<FsIo>, id: &str) -> Option<String> {
    store.entry(id).and_then(|_| None) // rationale lives in paged content
}

fn create_with_id(
    store: &mut RefinoStore<FsIo>,
    state: &AppState,
    id: &str,
    payload: &Value,
) -> ApiResult {
    if !is_valid_id(id) {
        return Err(ApiError::Refino(RefinoError::new(
            IssueCode::INVALID_ID,
            format!("Node \"{id}\" is not a valid node id."),
        )));
    }
    let type_field = optional_string(payload, "type")?
        .ok_or_refino(INVALID_REQUEST, format!("\"type\" must be \"premise\" or \"decision\" to create node \"{id}\"."))?;
    let node_type = match type_field.as_str() {
        "premise" => NodeType::Premise,
        "decision" => NodeType::Decision,
        _ => {
            return Err(ApiError::Refino(RefinoError::new(
                INVALID_REQUEST,
                format!("\"type\" must be \"premise\" or \"decision\" to create node \"{id}\"."),
            )));
        }
    };
    create_node(store, state, payload, node_type, Some(id.to_string()))
}

trait OrRefino {
    fn ok_or_refino(self, code: &str, message: String) -> Result<String, ApiError>;
}

impl OrRefino for Option<String> {
    fn ok_or_refino(self, code: &str, message: String) -> Result<String, ApiError> {
        self.ok_or_else(|| ApiError::Refino(RefinoError::new(code, message)))
    }
}

// ---- query + search endpoints ----

async fn query_neighbors(
    State(state): State<Arc<AppState>>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    with_payload(state, body, |store, payload| {
        let ids = read_ids(payload)?;
        let params = query::NeighborsParams {
            ancestor_depth: non_negative_int(payload, "ancestorDepth")?,
            descendant_depth: non_negative_int(payload, "descendantDepth")?,
            limit: optional_non_negative_int(payload, "limit")?,
        };
        let groups = query::neighbors(&store.graph().clone(), &ids, &params);
        batch_response(&groups)
    })
}

async fn query_grounds(
    State(state): State<Arc<AppState>>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    with_payload(state, body, |store, payload| {
        let ids = read_ids(payload)?;
        let groups = query::grounds(&store.graph().clone(), &ids);
        batch_response(&groups)
    })
}

async fn query_range(
    State(state): State<Arc<AppState>>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    with_payload(state, body, |store, payload| {
        let focus_id = id_field(payload, "focusId")?;
        let clicked_id = id_field(payload, "clickedId")?;
        for id in [&focus_id, &clicked_id] {
            if store.entry(id).is_none() {
                return Err(ApiError::Refino(RefinoError::new(
                    IssueCode::NODE_NOT_FOUND,
                    format!("Node \"{id}\" does not exist."),
                )));
            }
        }
        let budget = match payload.get("budget") {
            None | Some(Value::Null) => query::DEFAULT_RANGE_BUDGET,
            _ => non_negative_int(payload, "budget")?,
        };
        Ok(Json(serde_json::to_value(query::range(
            &store.graph().clone(),
            &focus_id,
            &clicked_id,
            budget,
        )?)?))
    })
}

async fn query_expand(
    State(state): State<Arc<AppState>>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    with_payload(state, body, |store, payload| {
        let ids = read_ids(payload)?;
        let params = query::ExpandParams {
            descendant_depth: optional_non_negative_int(payload, "descendantDepth")?,
            show_siblings: payload.get("showSiblings") != Some(&Value::Bool(false)),
            sibling_limit: optional_non_negative_int(payload, "siblingLimit")?,
            limit: optional_non_negative_int(payload, "limit")?,
        };
        let groups = query::expand(&store.graph().clone(), &ids, &params);
        batch_response(&groups)
    })
}

/// Batch responses answer 200 when every id resolved, 207 when any group
/// carries a per-id error.
fn batch_response<T: serde::Serialize>(groups: &[QueryGroup<T>]) -> ApiResult {
    let any_error = groups
        .iter()
        .any(|g| matches!(g, QueryGroup::Error { .. }));
    let status = if any_error { StatusCode::MULTI_STATUS } else { StatusCode::OK };
    Ok((status, Json(serde_json::to_value(groups)?)).into_response())
}

const SEARCH_DEFAULT_LIMIT: usize = 50;
const SEARCH_MAX_LIMIT: usize = 500;

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct SearchQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    roots: Option<String>,
    #[serde(default)]
    unreferenced: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

async fn get_search(
    State(state): State<Arc<AppState>>,
    Query(params): Query<SearchQuery>,
) -> Response {
    let result = with_store(&state, |store| {
        let q = params.q.as_deref().unwrap_or("").trim().to_string();
        let type_filter = match params.r#type.as_deref() {
            None | Some("") => None,
            Some("premise") => Some(NodeType::Premise),
            Some("decision") => Some(NodeType::Decision),
            Some(other) => {
                return Err(ApiError::Refino(RefinoError::new(
                    INVALID_REQUEST,
                    "\"type\" must be \"premise\" or \"decision\".",
                )));
            }
        };
        let flag = |value: &Option<String>| matches!(value.as_deref(), Some("1") | Some("true"));
        let roots_only = flag(&params.roots);
        let unreferenced_only = flag(&params.unreferenced);
        let limit = params
            .limit
            .as_deref()
            .and_then(|raw| raw.parse::<usize>().ok())
            .map(|n| n.clamp(1, SEARCH_MAX_LIMIT))
            .unwrap_or(SEARCH_DEFAULT_LIMIT);
        let cursor = params.cursor.as_deref().filter(|c| !c.is_empty());

        let all = store.sorted_ids();
        let q_upper = q.to_uppercase();
        let q_lower = q.to_lowercase();
        let mut matched: Vec<String> = Vec::new();
        for id in all.iter().skip(start_index(&all, cursor)) {
            if matched.len() > limit {
                break;
            }
            let Some(entry) = store.entry(id) else { continue };
            let decision = entry.node.as_decision();
            if let Some(want) = type_filter {
                if entry.node.node_type() != want {
                    continue;
                }
            }
            if roots_only
                && (entry.node.node_type() != NodeType::Decision
                    || decision
                        .map(|d| {
                            d.grounds.iter().any(|g| {
                                store.entry(g).map(|e| e.node.node_type()) == Some(NodeType::Decision)
                            })
                        })
                        .unwrap_or(false))
            {
                continue;
            }
            if unreferenced_only
                && (entry.node.node_type() != NodeType::Premise || !entry.node.children.is_empty())
            {
                continue;
            }
            if !q_upper.is_empty()
                && !id.to_uppercase().starts_with(&q_upper)
                && !entry.node.summary().to_lowercase().contains(&q_lower)
            {
                continue;
            }
            matched.push(id.clone());
        }
        let has_more = matched.len() > limit;
        let page: Vec<Value> = matched
            .iter()
            .take(limit)
            .map(|id| {
                let node = &store.entry(id).expect("iterated").node;
                json!({
                    "id": node.id(),
                    "type": match node.node_type() {
                        NodeType::Premise => "premise",
                        NodeType::Decision => "decision",
                    },
                    "summary": node.summary(),
                })
            })
            .collect();
        let next_cursor = if has_more { page.last().and_then(|n| n.get("id")).cloned() } else { None };
        Ok(Json(json!({ "nodes": page, "nextCursor": next_cursor })))
    });
    finish(result)
}

/// First index position at or after the cursor; keyset pages resume strictly
/// after it.
fn start_index(all: &[String], cursor: Option<&str>) -> usize {
    let Some(cursor) = cursor else { return 0 };
    match all.binary_search_by(|id| id.as_str().cmp(cursor)) {
        Ok(at) => at + 1,
        Err(at) => at,
    }
}

async fn get_stats(State(state): State<Arc<AppState>>) -> Response {
    let result = with_store(&state, |store| {
        let stats = store.stats();
        Ok(Json(json!({
            "revision": store.revision(),
            "nodes": stats.nodes,
            "decisions": stats.decisions,
            "premises": stats.premises,
            "roots": stats.roots,
        })))
    });
    finish(result)
}

/// SSE change feed: an initial snapshot event, then one event per applied
/// change batch (docs/design.md, "外部变更同步").
async fn get_events(State(state): State<Arc<AppState>>) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures::stream::Stream;
    let mut rx = state.changes.subscribe();
    let revision = state.store.lock().map(|s| s.revision()).unwrap_or(0);
    let snapshot = ChangeFeed {
        revision,
        changed: vec![],
        deleted: vec![],
        origin: None,
        reload: Some(true),
    };
    let stream = futures::stream::iter(vec![Ok::<Event, std::convert::Infallible>(
        Event::default().data(serde_json::to_string(&snapshot).unwrap_or_default()),
    )])
    .chain(futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(change) => {
                    let event = Event::default()
                        .data(serde_json::to_string(&change).unwrap_or_default());
                    return Some((Ok(event), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    }));
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

// ---- payload accessors ----

fn with_payload(
    state: Arc<AppState>,
    body: Result<Json<Value>, JsonRejection>,
    handler: impl FnOnce(&mut RefinoStore<FsIo>, &Value) -> ApiResult,
) -> Response {
    match body {
        Err(_) => error_response(&ApiError::Refino(RefinoError::new(
            INVALID_REQUEST,
            "Request body must be valid JSON.",
        ))),
        Ok(Json(payload)) => {
            let result = with_store(&state, |store| handler(store, &payload));
            finish(result)
        }
    }
}

fn read_ids(payload: &Value) -> Result<Vec<String>, ApiError> {
    let Some(ids) = payload.get("ids").and_then(|v| v.as_array()) else {
        return Err(ApiError::Refino(RefinoError::new(
            INVALID_REQUEST,
            "\"ids\" must be an array of node ids.",
        )));
    };
    let mut seen = BTreeMap::new();
    for id in ids {
        let Some(text) = id.as_str() else {
            return Err(ApiError::Refino(RefinoError::new(
                INVALID_REQUEST,
                "\"ids\" must be an array of node ids.",
            )));
        };
        seen.insert(text.to_string(), ());
    }
    Ok(seen.into_keys().collect())
}

fn id_field(payload: &Value, key: &str) -> Result<String, ApiError> {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError::Refino(RefinoError::new(
                INVALID_REQUEST,
                format!("\"{key}\" is required and must be a string."),
            ))
        })
}

fn non_negative_int(payload: &Value, key: &str) -> Result<usize, ApiError> {
    payload
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .ok_or_else(|| {
            ApiError::Refino(RefinoError::new(
                INVALID_REQUEST,
                format!("\"{key}\" must be a non-negative integer."),
            ))
        })
}

fn optional_non_negative_int(payload: &Value, key: &str) -> Result<Option<usize>, ApiError> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => non_negative_int(payload, key).map(Some),
    }
}

fn required_string(payload: &Value, key: &str) -> Result<String, ApiError> {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError::Refino(RefinoError::new(
                INVALID_REQUEST,
                format!("\"{key}\" is required and must be a string."),
            ))
        })
}

fn optional_string(payload: &Value, key: &str) -> Result<Option<String>, ApiError> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(_) => Err(RefinoError::new(
            INVALID_REQUEST,
            format!("\"{key}\" must be a string."),
        )
        .into()),
    }
}

/// The payload's `confirmed` timestamp as epoch milliseconds, format-checked
/// at this boundary.
fn read_confirmed(payload: &Value) -> Result<Option<i64>, ApiError> {
    let Some(confirmed) = optional_string(payload, "confirmed")? else {
        return Ok(None);
    };
    if !is_valid_confirmed(&confirmed) {
        return Err(ApiError::Refino(RefinoError::new(
            StorageIssueCode::INVALID_CONFIRMED,
            format!(
                "\"confirmed\" must be an RFC 3339 timestamp with an explicit UTC offset (Z or ±HH:MM), got \"{confirmed}\"."
            ),
        )));
    }
    Ok(confirmed_to_ms(&confirmed))
}

/// The payload's `exploring` boolean, shape-checked at this boundary.
fn read_exploring(payload: &Value) -> Result<Option<bool>, ApiError> {
    match payload.get("exploring") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(RefinoError::new(
            INVALID_REQUEST,
            "\"exploring\" must be a boolean.",
        )
        .into()),
    }
}

/// Parse `grounds` from a payload: shape-checked, deduplicated; omitted means
/// full replacement with none.
fn resolve_grounds(payload: &Value) -> Result<Option<Vec<String>>, ApiError> {
    let Some(grounds) = payload.get("grounds") else {
        return Ok(Some(Vec::new()));
    };
    let Some(list) = grounds.as_array() else {
        return Err(ApiError::Refino(RefinoError::new(
            IssueCode::INVALID_GROUNDS,
            "grounds must be an array of node ids.",
        )));
    };
    let mut seen = BTreeMap::new();
    for ground in list {
        let Some(text) = ground.as_str() else {
            return Err(ApiError::Refino(RefinoError::new(
                IssueCode::INVALID_GROUNDS,
                "grounds must be an array of node ids.",
            )));
        };
        if !is_valid_id(text) {
            return Err(ApiError::Refino(RefinoError::new(
                IssueCode::INVALID_GROUNDS,
                "grounds must be an array of node ids.",
            )));
        }
        seen.insert(text.to_string(), ());
    }
    Ok(Some(seen.into_keys().collect()))
}

/// The client's known node revision for the optimistic concurrency check.
fn read_revision(payload: &Value) -> Result<Option<u64>, ApiError> {
    match payload.get("revision") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match value.as_u64() {
            Some(revision) => Ok(Some(revision)),
            None => Err(RefinoError::new(
                INVALID_REQUEST,
                "\"revision\" must be a non-negative integer.",
            ))?,
        },
    }
}

/// The SSE wire event JSON for tests.
pub fn change_feed_json(change: &refino_storage::StoreChange) -> Value {
    serde_json::to_value(change_feed(change)).unwrap_or_default()
}
