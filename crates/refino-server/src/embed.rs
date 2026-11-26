//! Build-time embedded web UI.
//!
//! `build.rs` generates `EMBEDDED_UI` from the `@refino/ui` build output; a
//! build without that output (plain `cargo build`, CI without the web build)
//! produces an empty table and the server falls back to the placeholder page or
//! a disk directory. Serving is a pure function of the table so the lookup rules
//! are testable without a UI build.

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));

/// Whether this binary carries a built web UI.
pub fn has_ui() -> bool {
    !EMBEDDED_UI.is_empty()
}

/// Serve one URL path from the embedded table: an exact file, the SPA shell for
/// extensionless routes, or a 404.
pub(crate) fn serve(path: &str) -> Response {
    serve_table(EMBEDDED_UI, path)
}

fn serve_table(
    assets: &'static [(&'static str, &'static [u8], &'static str)],
    path: &str,
) -> Response {
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some((bytes, mime)) = find(assets, path) {
        return file_response(bytes, mime, cache_control(path));
    }
    // SPA fallback: a routable page (no file extension) serves the app shell,
    // which then resolves the route client-side.
    let last_segment = path.rsplit('/').next().unwrap_or(path);
    if !last_segment.contains('.')
        && let Some((bytes, mime)) = find(assets, "index.html")
    {
        return file_response(bytes, mime, "no-cache");
    }
    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn find(
    assets: &'static [(&'static str, &'static [u8], &'static str)],
    path: &str,
) -> Option<(&'static [u8], &'static str)> {
    assets
        .iter()
        .find(|(candidate, _, _)| *candidate == path)
        .map(|(_, bytes, mime)| (*bytes, *mime))
}

/// Hashed build outputs stay put for a year; everything else revalidates, so a
/// rebuilt UI is picked up by a plain reload.
fn cache_control(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

fn file_response(bytes: &'static [u8], mime: &'static str, cache: &'static str) -> Response {
    (
        [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache)],
        bytes,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    static TABLE: &[(&str, &[u8], &str)] = &[
        (
            "index.html",
            b"<div id=\"app\"></div>",
            "text/html; charset=utf-8",
        ),
        (
            "assets/index-abc.js",
            b"console.log(1)",
            "text/javascript; charset=utf-8",
        ),
    ];

    async fn body_of(response: Response) -> (StatusCode, String, String) {
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            content_type,
            String::from_utf8_lossy(&bytes).to_string(),
        )
    }

    #[tokio::test]
    async fn serves_the_index_at_the_root() {
        let (status, content_type, body) = body_of(serve_table(TABLE, "/")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "text/html; charset=utf-8");
        assert!(body.contains("id=\"app\""));
    }

    #[tokio::test]
    async fn serves_hashed_assets_as_immutable() {
        let response = serve_table(TABLE, "/assets/index-abc.js");
        let cache = response
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok())
            .unwrap();
        assert_eq!(cache, "public, max-age=31536000, immutable");
        let (status, content_type, body) = body_of(response).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type, "text/javascript; charset=utf-8");
        assert_eq!(body, "console.log(1)");
    }

    #[tokio::test]
    async fn falls_back_to_the_shell_for_extensionless_routes() {
        let (status, _, body) = body_of(serve_table(TABLE, "/nodes/ABCD1234")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("id=\"app\""));
    }

    #[tokio::test]
    async fn misses_unknown_files_with_extensions() {
        let (status, _, _) = body_of(serve_table(TABLE, "/assets/index-missing.js")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
