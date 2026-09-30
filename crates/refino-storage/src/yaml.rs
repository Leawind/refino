//! YAML frontmatter emission (the storage format's write side) and small
//! helpers over parsed YAML values.
//!
//! Writing does not use a general YAML emitter: the field set is closed
//! (grounds, rationale, summary, exploring, confirmed) and the canonical
//! output shape is pinned in the storage DESIGN.md ("YAML 序列化规范形").
//! The shape mirrors the `yaml` package's output byte for byte, anchored by
//! golden tests in tests/serialize.rs.

use yaml_rust2::Yaml;

/// One serializable frontmatter field, in output order.
#[derive(Debug, Clone)]
pub enum FieldValue {
    /// Block-sequence of strings (grounds).
    StrList(Vec<String>),
    /// Scalar; emitted plain when unambiguous, double-quoted otherwise.
    Str(String),
    /// `true` (exploring's only meaningful value).
    BoolTrue,
}

/// Serialize the frontmatter block + body. When no fields are present the
/// frontmatter block is omitted entirely; a body-only file is a valid node.
pub fn serialize_node(fields: &[(String, FieldValue)], body: &str) -> String {
    let trimmed_body = format!("{}\n", body.trim_end());
    if fields.is_empty() {
        return trimmed_body;
    }
    let mut out = String::from("---\n");
    for (key, value) in fields {
        match value {
            FieldValue::StrList(items) => {
                out.push_str(key);
                if items.is_empty() {
                    // An empty block sequence does not exist in YAML; the
                    // `yaml` package emits the flow form.
                    out.push_str(": []\n");
                } else {
                    out.push_str(":\n");
                    for item in items {
                        out.push_str("  - ");
                        out.push_str(item);
                        out.push('\n');
                    }
                }
            }
            FieldValue::Str(text) => {
                out.push_str(key);
                out.push_str(": ");
                // The first line's folding budget starts after "key: ".
                out.push_str(&emit_scalar(text, key.chars().count() + 2));
                out.push('\n');
            }
            FieldValue::BoolTrue => {
                out.push_str(key);
                out.push_str(": true\n");
            }
        }
    }
    out.push_str("---\n\n");
    out.push_str(&trimmed_body);
    out
}

/// Emit a string scalar in the `yaml` package's style: plain when
/// unambiguous, double-quoted otherwise; literal block for multi-line plain
/// strings; folding at 80 columns for long plain scalars. `first_line_width`
/// is the columns already occupied before the scalar on its first line
/// (folding budget = 80 - first_line_width; continuation lines are indented
/// by 2 and budgeted from there).
fn emit_scalar(text: &str, first_line_width: usize) -> String {
    if text.contains('\n') {
        // Literal block continuation lines sit at the mapping's own indent
        // (level 0) plus two.
        return emit_literal_block(text, 0);
    }
    if needs_quotes(text) {
        return emit_double_quoted(text);
    }
    emit_folded_plain(text, first_line_width)
}

/// Literal block style (`|-`), the `yaml` package's rendering for multi-line
/// strings.
fn emit_literal_block(text: &str, indent: usize) -> String {
    let pad = " ".repeat(indent + 2);
    let mut out = String::from("|-");
    for line in text.split('\n') {
        out.push('\n');
        if !line.is_empty() {
            out.push_str(&pad);
            out.push_str(line);
        }
    }
    out
}

/// Double-quoted with JSON-style escapes; never folded (the values that
/// reach this path are short in practice).
fn emit_double_quoted(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Plain scalar folded at 80 columns on spaces, continuation lines indented
/// by two.
fn emit_folded_plain(text: &str, first_line_width: usize) -> String {
    let max_width: usize = 80;
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_width = first_line_width;
    for word in text.split(' ') {
        let word_len = word.chars().count();
        if !current.is_empty() && current_width + 1 + word_len > max_width {
            lines.push(std::mem::take(&mut current));
            current.push_str(word);
            current_width = 2 + word_len; // continuation lines are indented by 2
        } else if current.is_empty() {
            current.push_str(word);
            current_width += word_len;
        } else {
            current.push(' ');
            current.push_str(word);
            current_width += 1 + word_len;
        }
    }
    lines.push(current);
    let mut out = lines[0].clone();
    for line in &lines[1..] {
        out.push('\n');
        out.push_str(&" ".repeat(2));
        out.push_str(line);
    }
    out
}

/// Whether a plain-style emission would be ambiguous or invalid, forcing the
/// double-quoted style. Mirrors the `yaml` package's decisions, anchored by
/// golden tests.
fn needs_quotes(text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    // Leading or trailing whitespace.
    if text.starts_with(' ')
        || text.ends_with(' ')
        || text.starts_with('\t')
        || text.ends_with('\t')
    {
        return true;
    }
    // Strings that would read back as bool/null/number-like scalars.
    if reads_as_other_type(text) {
        return true;
    }
    let mut chars = text.chars();
    let first = chars.next().expect("non-empty checked");
    if matches!(
        first,
        '-' | '?'
            | ':'
            | ','
            | '['
            | ']'
            | '{'
            | '}'
            | '#'
            | '&'
            | '*'
            | '!'
            | '|'
            | '>'
            | '\''
            | '"'
            | '%'
            | '@'
            | '`'
    ) {
        return true;
    }
    // `: ` anywhere, a trailing `:`, or ` #` anywhere.
    if text.contains(": ") || text.ends_with(':') || text.contains(" #") {
        return true;
    }
    false
}

/// Whether the plain scalar would parse as null, bool or number instead of a
/// string (YAML 1.2 core-ish set, as the `yaml` package resolves it).
fn reads_as_other_type(text: &str) -> bool {
    matches!(
        text,
        "~" | "null"
            | "Null"
            | "NULL"
            | "true"
            | "True"
            | "TRUE"
            | "false"
            | "False"
            | "FALSE"
            | ".inf"
            | ".Inf"
            | ".INF"
            | "-.inf"
            | "-.Inf"
            | "-.INF"
            | "+.inf"
            | "+.Inf"
            | "+.INF"
            | ".nan"
            | ".NaN"
            | ".NAN"
    ) || looks_numeric(text)
}

fn looks_numeric(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    if body.is_empty() {
        return false;
    }
    if matches!(body, ".inf" | ".Inf" | ".INF" | ".nan" | ".NaN" | ".NAN") {
        return true;
    }
    // Hexadecimal / octal literals.
    if let Some(hex) = body.strip_prefix("0x") {
        return !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if let Some(oct) = body.strip_prefix("0o") {
        return !oct.is_empty() && oct.bytes().all(|b| (b'0'..=b'7').contains(&b));
    }
    // Decimal integers, floats and scientific notation (1e3, .5, 1_000.25).
    let has_digit = body.bytes().any(|b| b.is_ascii_digit());
    let all_num_chars = body
        .bytes()
        .all(|b| b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'e' || b == b'E');
    let starts_right = body
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit() || c == '.');
    has_digit && all_num_chars && starts_right
}

/// Render a parsed YAML value the way `JSON.stringify` does in error
/// messages (the message contract of grounds parse issues).
pub fn yaml_to_json_string(value: &Yaml) -> String {
    match value {
        Yaml::Null | Yaml::BadValue => "null".to_string(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(s) => s.clone(),
        Yaml::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        Yaml::Array(items) => {
            let inner: Vec<String> = items.iter().map(yaml_to_json_string).collect();
            format!("[{}]", inner.join(","))
        }
        Yaml::Hash(pairs) => {
            let inner: Vec<String> = pairs
                .iter()
                .map(|(k, v)| format!("{}:{}", yaml_to_json_string(k), yaml_to_json_string(v)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
        _ => "null".to_string(),
    }
}
