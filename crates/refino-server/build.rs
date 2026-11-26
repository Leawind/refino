//! Embed the built `@refino/ui` assets into the server binary.
//!
//! The web UI is a pnpm workspace package, so its build output is absent in a
//! plain `cargo build` (and in CI jobs that never run the web build). The asset
//! table is therefore generated only when the directory exists: without it the
//! binary starts and serves the placeholder page, exactly like a build without a
//! UI. `REFINO_UI_EMBED_DIR` points the embed at another build output.
//!
//! The generated table is `EMBEDDED_UI: &[(&str, &[u8], &str)]` — URL path,
//! bytes, content type — sorted by URL path so the output is deterministic.

use std::path::{Path, PathBuf};
use std::{env, fs};

/// Folder inside the pnpm workspace that holds the UI build output.
const WORKSPACE_UI_DIST: &str = "../../packages/ui/dist";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=REFINO_UI_EMBED_DIR");

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist = env::var_os("REFINO_UI_EMBED_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(|| {
            let candidate = manifest.join(WORKSPACE_UI_DIST);
            candidate.is_dir().then_some(candidate)
        });

    let mut assets: Vec<(String, PathBuf, &'static str)> = Vec::new();
    if let Some(dist) = &dist {
        collect(dist, dist, &mut assets);
        println!("cargo:rerun-if-changed={}", dist.display());
    }
    assets.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from("pub(crate) const EMBEDDED_UI: &[(&str, &[u8], &str)] = &[\n");
    for (url_path, file, mime) in assets {
        code.push_str(&format!(
            "    ({:?}, include_bytes!({:?}), {:?}),\n",
            url_path,
            file.to_string_lossy(),
            mime
        ));
    }
    code.push_str("];\n");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("ui_assets.rs");
    fs::write(out, code).expect("write ui_assets.rs");
}

/// Collect files under `dir` as (URL path, absolute file path, content type).
fn collect(root: &Path, dir: &Path, assets: &mut Vec<(String, PathBuf, &'static str)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect(root, &path, assets);
        } else if file_type.is_file() {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let url_path = relative.to_string_lossy().replace('\\', "/");
            let mime = content_type(&url_path);
            assets.push((url_path, path, mime));
        }
    }
}

/// Content type by extension; unknown extensions fall back to bytes.
fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}
