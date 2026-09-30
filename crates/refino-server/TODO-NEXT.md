# WIP handoff notes (context compaction artifact — delete when done)

refino-server does NOT compile yet. Remaining errors (cargo check -p refino-server):

1. lib.rs:301 `Ok(deleted)` — the closure's Ok type was first inferred as
   `(StatusCode, Response)` from the CONFLICT branch (lib.rs ~281, still
   `return Ok((...))` form). Rewrite that branch like put_node's conflict
   branch (typed `let conflict: Response = (...).into_response(); return
   Ok(conflict);`).
2. lib.rs:556 query_range — the `Ok(Json(serde_json::to_value(...)?))` block
   needs manual rewrite: bind to_value result, map_err into
   ApiError::Refino("INTERNAL", msg), return Ok(Json(value)). The perl
   replace did not match the exact text.
3. lib.rs:743 SSE stream — `futures::stream::iter(...).chain(unfold(...))`
   needs `.map(...)` boxing: return type must be `Sse<impl Stream<...>>`;
   simplest: collect into `impl Stream` via `futures::stream::unfold` only
   and prepend the snapshot inside the unfold state (first tick = snapshot).

After it compiles:
- wire the `web` command in crates/refino/src (lib.rs Command_::Web +
  start_web_server in refino-server: port bump loop from design.md,
  REFINO_WEB_PORT env, tokio runtime in main)
- delete crates/refino-server/TODO-NEXT.md
- port golden tests: packages/cli/test/web-query.test.ts (27 cases, 10-node
  fixture) + web-api.test.ts essentials into crates/refino-server/tests/
  using tower::ServiceExt::oneshot against router(Arc<AppState>)
- gates: cargo fmt/clippy/test + pnpm check, then commit
  "feat(refino-server): port the web service to axum"

Then proceed to plan steps 6-9 (wasm facade, wire types, ui switch,
distribution, TS cleanup) per docs/design.md and the approved plan.
