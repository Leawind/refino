//! Node file parsing (in-memory fields from markdown text), the storage
//! format's read side.

use crate::clock;
use crate::codes::{StorageIssue, StorageIssueCode};
use refino_core::{DecisionNode, NodeType, PremiseNode, RefinoNode};
use yaml_rust2::{Yaml, YamlLoader};

/// Whether the value is a valid premise `confirmed` timestamp in its file form.
pub fn is_valid_confirmed(value: &str) -> bool {
    clock::is_valid_confirmed(value)
}

/// The file's RFC 3339 `confirmed` form as epoch milliseconds (validate first).
pub fn confirmed_to_ms(value: &str) -> Option<i64> {
    clock::confirmed_to_ms(value)
}

/// The epoch-millisecond `confirmed` form as the file's RFC 3339 form (UTC, Z offset).
pub fn confirmed_to_rfc3339(ms: i64) -> Result<String, refino_core::RefinoError> {
    clock::confirmed_to_rfc3339(ms)
}

/// Paged node content: everything that lives in the file but not in the
/// engine's resident memory model.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NodeContent {
    /// Full body text (trimmed).
    pub body: String,
    /// Why the decision was made; independent and optional, decisions only.
    pub rationale: Option<String>,
}

pub const SUMMARY_MAX_LENGTH: usize = 100;

pub struct ParseResult {
    /// The parsed node, or None when the frontmatter could not be parsed.
    pub node: Option<RefinoNode>,
    /// The node's paged content; None exactly when `node` is None.
    pub content: Option<NodeContent>,
    pub issues: Vec<StorageIssue>,
    /// Whether the summary came from an explicit "summary" frontmatter field.
    /// When false, `node.summary` was derived from the body; write paths use
    /// this to avoid materializing a derived summary into the file.
    pub summary_explicit: bool,
}

/// Parse one node file into a resident node record plus its paged content.
///
/// `id` is derived by the loader from the file path (path is identity).
/// `file` is the `.refino`-relative path in either separator style,
/// normalized to the canonical forward-slash form; it exists only to
/// attribute issues to the file — nodes carry no paths. A file without
/// frontmatter is a valid node with no fields. The summary comes from the
/// "summary" frontmatter field, falling back to the first paragraph of the
/// body via `extract_summary`.
pub fn parse_node_source(
    id: &str,
    file: &str,
    expected_type: NodeType,
    source: &str,
) -> ParseResult {
    let mut issues: Vec<StorageIssue> = Vec::new();
    let normalized = source
        .strip_prefix('\u{FEFF}')
        .unwrap_or(source)
        .replace("\r\n", "\n");
    let canonical_file = file.replace('\\', "/");

    let frontmatter = split_frontmatter(&normalized);
    let mut fields: Vec<(String, Yaml)> = Vec::new();
    if let Some((yaml, _)) = &frontmatter {
        match parse_frontmatter(&canonical_file, yaml, &mut issues) {
            Frontmatter::Broken => {
                return ParseResult {
                    node: None,
                    content: None,
                    issues,
                    summary_explicit: false,
                };
            }
            Frontmatter::Parsed(entries) => fields = entries,
        }
    }

    let body = match &frontmatter {
        Some((_, body_start)) => normalized[*body_start..].trim().to_string(),
        None => normalized.trim().to_string(),
    };

    // The summary is an independent attribute (docs/dlg.md). A "summary"
    // frontmatter field takes precedence; the first-paragraph fallback keeps
    // summary-less files readable.
    let summary_field = field(&fields, "summary");
    let summary: String;
    let mut summary_explicit = false;
    match summary_field {
        None | Some(Yaml::Null) | Some(Yaml::BadValue) => {
            summary = extract_summary(&body);
        }
        Some(Yaml::String(text)) if !text.trim().is_empty() => {
            summary = text.clone();
            summary_explicit = true;
        }
        Some(_) => {
            issues.push(
                StorageIssue::new(
                    StorageIssueCode::INVALID_FRONTMATTER,
                    "\"summary\" must be a non-empty string.",
                    canonical_file.clone(),
                )
                .with_node_id(id),
            );
            summary = extract_summary(&body);
        }
    }

    let mut content = NodeContent {
        body,
        rationale: None,
    };
    let node: RefinoNode = match expected_type {
        NodeType::Premise => parse_premise(id, &summary, &fields, &canonical_file, &mut issues),
        NodeType::Decision => parse_decision(
            id,
            &summary,
            &fields,
            &mut content,
            &canonical_file,
            &mut issues,
        ),
    };

    ParseResult {
        node: Some(node),
        content: Some(content),
        issues,
        summary_explicit,
    }
}

enum Frontmatter {
    Broken,
    Parsed(Vec<(String, Yaml)>),
}

/// Split the frontmatter block and the body start offset, mirroring
/// `/^---\n([\s\S]*?)\n---(?:\n|$)/` plus the empty-block variant
/// `/^---\n---(?:\n|$)/`: the closing fence is the first `\n---` that is
/// followed by a newline or the end of the source.
fn split_frontmatter(source: &str) -> Option<(String, usize)> {
    let rest = source.strip_prefix("---\n")?;
    // Empty block: `---\n---` followed by newline or end.
    if rest.starts_with("---") && (rest[3..].starts_with('\n') || rest[3..].is_empty()) {
        let body_start = source.len() - rest[3..].strip_prefix('\n').unwrap_or(&rest[3..]).len();
        return Some((String::new(), body_start));
    }
    let mut search_from = 0;
    while let Some(at) = rest[search_from..].find("\n---") {
        let fence = search_from + at + 1; // offset of "---" in `rest`
        let after = &rest[fence + 3..];
        if after.starts_with('\n') || after.is_empty() {
            let yaml = rest[..at + search_from].to_string();
            let body_start = source.len() - after.strip_prefix('\n').unwrap_or(after).len();
            return Some((yaml, body_start));
        }
        search_from = fence + 1;
    }
    None
}

fn field<'a>(fields: &'a [(String, Yaml)], key: &str) -> Option<&'a Yaml> {
    fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// Premise fields: `confirmed` as epoch milliseconds, converted from the
/// file's RFC 3339 form. A declared `grounds` or `exploring` is a misplaced
/// attribute (edges and trial marks belong to decisions only) and is
/// silently ignored, like any unknown frontmatter field — no issue is
/// reported.
fn parse_premise(
    id: &str,
    summary: &str,
    fields: &[(String, Yaml)],
    file: &str,
    issues: &mut Vec<StorageIssue>,
) -> RefinoNode {
    let mut node = PremiseNode {
        id: id.to_string(),
        summary: summary.to_string(),
        confirmed: None,
    };
    if let Some(confirmed) = field(fields, "confirmed") {
        match confirmed {
            Yaml::Null | Yaml::BadValue => {}
            Yaml::String(text) if is_valid_confirmed(text) => {
                node.confirmed = confirmed_to_ms(text);
            }
            _ => issues.push(
                StorageIssue::new(
                    StorageIssueCode::INVALID_CONFIRMED,
                    "\"confirmed\" must be an RFC 3339 timestamp with an explicit UTC offset.",
                    file,
                )
                .with_node_id(id),
            ),
        }
    }
    RefinoNode::Premise(node)
}

/// Decision fields: `grounds` (absent -> []), `exploring` (only true marks);
/// `rationale` lands in the paged content.
fn parse_decision(
    id: &str,
    summary: &str,
    fields: &[(String, Yaml)],
    content: &mut NodeContent,
    file: &str,
    issues: &mut Vec<StorageIssue>,
) -> RefinoNode {
    let grounds = parse_grounds(file, id, field(fields, "grounds"), issues).unwrap_or_default();
    let mut node = DecisionNode {
        id: id.to_string(),
        summary: summary.to_string(),
        grounds,
        exploring: None,
    };
    if let Some(exploring) = field(fields, "exploring") {
        match exploring {
            Yaml::Boolean(true) => node.exploring = Some(true),
            Yaml::Boolean(false) | Yaml::Null | Yaml::BadValue => {
                // Canonical form: only `true` is meaningful; an explicit false
                // parses to "no mark", identical to absence.
            }
            _ => issues.push(
                StorageIssue::new(
                    StorageIssueCode::INVALID_EXPLORING,
                    "\"exploring\" must be a boolean.",
                    file,
                )
                .with_node_id(id),
            ),
        }
    }
    if let Some(rationale) = field(fields, "rationale") {
        match rationale {
            Yaml::Null | Yaml::BadValue => {}
            Yaml::String(text) => content.rationale = Some(text.clone()),
            _ => issues.push(
                StorageIssue::new(
                    StorageIssueCode::INVALID_FRONTMATTER,
                    "\"rationale\" must be a string.",
                    file,
                )
                .with_node_id(id),
            ),
        }
    }
    RefinoNode::Decision(node)
}

fn parse_frontmatter(file: &str, yaml: &str, issues: &mut Vec<StorageIssue>) -> Frontmatter {
    let mut documents = match YamlLoader::load_from_str(yaml) {
        Ok(docs) => docs,
        Err(error) => {
            issues.push(StorageIssue::new(
                StorageIssueCode::INVALID_FRONTMATTER,
                format!("Frontmatter is not valid YAML: {error}"),
                file,
            ));
            return Frontmatter::Broken;
        }
    };
    let Some(doc) = documents.first_mut() else {
        return Frontmatter::Parsed(Vec::new()); // empty frontmatter block
    };
    match doc {
        Yaml::Null | Yaml::BadValue => Frontmatter::Parsed(Vec::new()), // empty frontmatter block
        Yaml::Hash(pairs) => {
            let entries: Vec<(String, Yaml)> = pairs
                .iter()
                .map(|(k, v)| (yaml_key_to_string(k), v.clone()))
                .collect();
            Frontmatter::Parsed(entries)
        }
        _ => {
            issues.push(StorageIssue::new(
                StorageIssueCode::INVALID_FRONTMATTER,
                "Frontmatter must be a YAML mapping.",
                file,
            ));
            Frontmatter::Broken
        }
    }
}

fn yaml_key_to_string(key: &Yaml) -> String {
    match key {
        Yaml::String(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(s) => s.clone(),
        Yaml::Boolean(b) => b.to_string(),
        _ => String::new(),
    }
}

fn parse_grounds(
    file: &str,
    node_id: &str,
    value: Option<&Yaml>,
    issues: &mut Vec<StorageIssue>,
) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new()); // absent (or explicit null) -> []
    };
    let Yaml::Array(items) = value else {
        issues.push(
            StorageIssue::new(
                refino_core::IssueCode::INVALID_GROUNDS,
                format!(
                    "\"grounds\" must be a list of node ids, got {}.",
                    crate::yaml::yaml_to_json_string(value)
                ),
                file,
            )
            .with_node_id(node_id),
        );
        return None;
    };
    let mut grounds: Vec<String> = Vec::new();
    for entry in items {
        let valid =
            matches!(entry, Yaml::String(text) if !text.trim().is_empty() && text.trim() == text);
        if !valid {
            issues.push(
                StorageIssue::new(
                    refino_core::IssueCode::INVALID_GROUNDS,
                    format!(
                        "\"grounds\" entries must be non-empty strings, got {}.",
                        crate::yaml::yaml_to_json_string(entry)
                    ),
                    file,
                )
                .with_node_id(node_id),
            );
            return None;
        }
        if let Yaml::String(text) = entry
            && !grounds.contains(text)
        {
            grounds.push(text.clone());
        }
    }
    Some(grounds)
}

/// Fallback summary rule: first paragraph of the body, whitespace-collapsed to
/// a single line, truncated with an ellipsis when longer than
/// `SUMMARY_MAX_LENGTH`. The truncation applies to the fallback only; explicit
/// "summary" fields and node bodies are never length-limited.
pub fn extract_summary(body: &str) -> String {
    let first_block = first_paragraph(body);
    let collapsed = collapse_whitespace(first_block);
    let collapsed = collapsed.trim();
    let char_count = collapsed.chars().count();
    if char_count > SUMMARY_MAX_LENGTH {
        let truncated: String = collapsed.chars().take(SUMMARY_MAX_LENGTH).collect();
        format!("{truncated}...")
    } else {
        collapsed.to_string()
    }
}

/// The text before the first blank line, matching JS
/// `body.split(/\n[ \t]*\n/, 1)[0] ?? ""` (a blank line may carry spaces or
/// tabs).
fn first_paragraph(body: &str) -> &str {
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\n' {
                return &body[..i];
            }
        }
        i += 1;
    }
    body
}

/// JS `replace(/\s+/g, " ")` over unicode whitespace.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            in_space = true;
        } else {
            if in_space && !out.is_empty() {
                out.push(' ');
            }
            in_space = false;
            out.push(c);
        }
    }
    out
}
