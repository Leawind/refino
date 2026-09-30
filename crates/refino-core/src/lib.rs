//! Pure engine for Decision Lineage Graphs (DLG).
//!
//! Graph model, validation, queries, longest-path layering and id handling.
//! wasm-clean: no filesystem, clock or network dependencies; the random
//! source is injected (docs/design.md, "引擎纯净性").
