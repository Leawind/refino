//! The node-search matching contract shared by the CLI (`refino search`) and
//! the web API (`GET /api/search`); the TypeScript harness mirrors the same
//! semantics. A query matches an id prefix or a summary/body/rationale
//! substring, all case-insensitively.
//!
//! Ids, summaries and node types are resident; body and rationale are paged
//! content, so matching is split into a cheap resident pass and a content
//! fallback. Callers only read content when the resident pass misses, and
//! `RefinoStore::content` serves repeated reads from its LRU.

use crate::parser::NodeContent;

/// A search query normalized once per page.
#[derive(Debug, Clone)]
pub struct NodeSearchQuery {
    /// Ids are matched case-insensitively (Crockford base32).
    upper: String,
    /// Summaries, bodies and rationales are matched case-insensitively.
    lower: String,
}

impl NodeSearchQuery {
    pub fn new(query: &str) -> Self {
        let upper = query.trim().to_uppercase();
        let lower = upper.to_lowercase();
        NodeSearchQuery { upper, lower }
    }

    /// The cheap pass over resident fields: id prefix or summary substring.
    /// An empty query matches everything, so callers never page content for
    /// it.
    pub fn matches_resident(&self, id: &str, summary: &str) -> bool {
        self.upper.is_empty()
            || id.to_uppercase().starts_with(&self.upper)
            || summary.to_lowercase().contains(&self.lower)
    }

    /// The content fallback: body or rationale substring.
    pub fn matches_content(&self, content: &NodeContent) -> bool {
        self.lower.is_empty()
            || content.body.to_lowercase().contains(&self.lower)
            || content
                .rationale
                .as_ref()
                .is_some_and(|rationale| rationale.to_lowercase().contains(&self.lower))
    }
}

/// First index strictly after the cursor id in an ascending id list; unknown
/// cursors resume at the next id in order (the shared keyset pagination
/// contract).
pub fn start_index(ids: &[String], cursor: Option<&str>) -> usize {
    let Some(cursor) = cursor else { return 0 };
    match ids.binary_search_by(|id| id.as_str().cmp(cursor)) {
        Ok(at) => at + 1,
        Err(at) => at,
    }
}
