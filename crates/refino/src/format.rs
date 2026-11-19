//! Output rendering: node tables, issue lists and full records, plus the
//! injected sink trait so tests can capture output in-process.

/// Output sinks injected into `run` so tests can capture output in-process.
pub trait CliSink {
    fn out(&mut self, text: &str);
    fn err(&mut self, text: &str);
    /// Full stdin text, consumed by `-` content sources (`--body-file -`).
    /// Real streams read stdin; tests preset the text.
    fn input(&mut self) -> std::io::Result<String>;
}

/// Real process streams.
pub struct ProcessSink;

impl CliSink for ProcessSink {
    fn out(&mut self, text: &str) {
        use std::io::Write;
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        let _ = lock.write_all(text.as_bytes());
        let _ = lock.flush();
    }

    fn err(&mut self, text: &str) {
        use std::io::Write;
        let stderr = std::io::stderr();
        let mut lock = stderr.lock();
        let _ = lock.write_all(text.as_bytes());
        let _ = lock.flush();
    }

    fn input(&mut self) -> std::io::Result<String> {
        use std::io::Read;
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        Ok(text)
    }
}

/// In-process capture (the `capture()` helper of the TS tests).
#[derive(Default)]
pub struct CaptureSink {
    pub out: String,
    pub err: String,
    /// Text that `input()` serves instead of the real stdin.
    pub stdin: String,
}

impl CliSink for CaptureSink {
    fn out(&mut self, text: &str) {
        self.out.push_str(text);
    }

    fn err(&mut self, text: &str) {
        self.err.push_str(text);
    }

    fn input(&mut self) -> std::io::Result<String> {
        Ok(self.stdin.clone())
    }
}

/// JS `String.prototype.padEnd` over UTF-16 code units; the padded columns
/// (id, type, depth) are ASCII in practice, so chars equal units there.
fn pad_end(text: &str, width: usize) -> String {
    let len = text.chars().count();
    if len >= width {
        text.to_string()
    } else {
        format!("{text}{}", " ".repeat(width - len))
    }
}

pub fn truncate(text: &str, max_length: usize) -> String {
    if text.chars().count() <= max_length {
        text.to_string()
    } else {
        let keep = max_length.saturating_sub(1);
        format!("{}...", text.chars().take(keep).collect::<String>())
    }
}

/// One row of a node table: `id  type  [depth]  [overlap]  summary`, columns
/// aligned across the batch. The depth column appears only when at least one
/// row carries a depth (traversal queries); the overlap column only when at
/// least one row carries an overlap (the siblings query). A row marked
/// `exploring` (the derived effective status, never the stored mark alone)
/// prefixes the summary with `[探索]`.
pub fn render_node_table(rows: &[TableRow]) -> String {
    let with_depth = rows.iter().any(|r| r.depth.is_some());
    let with_overlap = rows.iter().any(|r| r.overlap.is_some());
    let id_width = rows
        .iter()
        .map(|r| r.id.chars().count())
        .max()
        .unwrap_or(2)
        .max(2);
    let type_width = rows
        .iter()
        .map(|r| r.node_type.chars().count())
        .max()
        .unwrap_or(2)
        .max(2);
    let depth_width = rows
        .iter()
        .map(|r| match r.depth {
            Some(d) => d.to_string().chars().count(),
            None => 0,
        })
        .max()
        .unwrap_or(2)
        .max(2);
    let overlap_width = rows
        .iter()
        .map(|r| match r.overlap {
            Some(o) => o.to_string().chars().count(),
            None => 0,
        })
        .max()
        .unwrap_or(2)
        .max(2);
    rows.iter()
        .map(|r| {
            let head = format!(
                "{}  {}  ",
                pad_end(&r.id, id_width),
                pad_end(&r.node_type, type_width)
            );
            let depth_col = if with_depth {
                let text = r.depth.map(|d| d.to_string()).unwrap_or_default();
                format!("{}  ", pad_end(&text, depth_width))
            } else {
                String::new()
            };
            let overlap_col = if with_overlap {
                let text = r.overlap.map(|o| o.to_string()).unwrap_or_default();
                format!("{}  ", pad_end(&text, overlap_width))
            } else {
                String::new()
            };
            let mark = if r.exploring == Some(true) {
                "[探索] "
            } else {
                ""
            };
            format!(
                "{head}{depth_col}{overlap_col}{mark}{}",
                truncate(&r.summary, 80)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One table row's inputs.
pub struct TableRow {
    pub id: String,
    pub node_type: String,
    pub summary: String,
    pub depth: Option<usize>,
    pub overlap: Option<usize>,
    pub exploring: Option<bool>,
}

/// `[CODE] message (file)` per issue; the file is storage vocabulary and
/// only storage-raised issues carry one.
pub fn render_issues(issues: &[StoreIssue]) -> String {
    issues
        .iter()
        .map(|issue| match issue.file() {
            Some(file) => format!("[{}] {} ({})", issue.code(), issue.message(), file),
            None => format!("[{}] {}", issue.code(), issue.message()),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Compact single-line identity, e.g. `decisions(id=E5F6G7H8, grounds=[...],
/// children=[...])`. Grounds are the decision's declared upstream; children
/// are the derived direct dependents, shown only when non-empty.
pub fn render_node_heading(node: &RefinoNode, children: &[String]) -> String {
    let mut parts = vec![format!("id={}", node.id())];
    if let Some(decision) = node.as_decision() {
        parts.push(format!("grounds=[{}]", decision.grounds.join(", ")));
    }
    if !children.is_empty() {
        parts.push(format!("children=[{}]", children.join(", ")));
    }
    let type_name = match node.node_type() {
        refino_core::NodeType::Premise => "premise",
        refino_core::NodeType::Decision => "decision",
    };
    format!("{type_name}s({})", parts.join(", "))
}

/// Full human-readable record: heading line (identity, grounds and direct
/// dependents), labeled attributes, then the body. Optional attributes
/// (rationale, confirmed, exploring) only occupy a line when present,
/// mirroring the JSON shape. Confirmed is stored as epoch milliseconds and
/// rendered in its RFC 3339 (UTC) form. The exploring line shows the stored
/// trial mark, or the derived effective status (no stored mark but an
/// exploring ground) when `effective` says so.
pub fn render_full_record(
    node: &RefinoNode,
    content: Option<&refino_storage::NodeContent>,
    effective: bool,
    children: &[String],
) -> String {
    let mut lines = vec![
        render_node_heading(node, children),
        format!("summary: {}", node.summary()),
    ];
    if let Some(rationale) = content.and_then(|c| c.rationale.clone()) {
        lines.push(format!("rationale: {rationale}"));
    }
    match node {
        RefinoNode::Premise(premise) => {
            if let Some(confirmed) = premise.confirmed
                && let Ok(iso) = refino_storage::confirmed_to_rfc3339(confirmed)
            {
                lines.push(format!("confirmed: {iso}"));
            }
        }
        RefinoNode::Decision(decision) => {
            if decision.exploring == Some(true) {
                lines.push("exploring: true".to_string());
            } else if effective {
                lines.push("exploring: true (derived)".to_string());
            }
        }
    }
    format!(
        "{}\n\n{}",
        lines.join("\n"),
        content.map(|c| c.body.as_str()).unwrap_or("")
    )
}

use refino_core::RefinoNode;
use refino_storage::StoreIssue;
