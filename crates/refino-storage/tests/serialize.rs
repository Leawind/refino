//! Golden tests for the restricted YAML emitter (the storage DESIGN.md
//! "YAML 序列化规范形"). Every expected string was produced by the `yaml`
//! package 2.9.x the TypeScript implementation used, so the emitter is
//! byte-compatible by construction.

use refino_storage::serialize_node;
use refino_storage::yaml::FieldValue;

fn field(key: &str, value: &str) -> (String, FieldValue) {
    (key.to_string(), FieldValue::Str(value.to_string()))
}

#[test]
fn body_only_file_has_no_frontmatter() {
    assert_eq!(serialize_node(&[], "Body."), "Body.\n");
    assert_eq!(serialize_node(&[], "Line1\nLine2"), "Line1\nLine2\n");
}

#[test]
fn plain_scalars_pass_through() {
    assert_eq!(
        serialize_node(&[field("summary", "Short relevance summary.")], "B."),
        "---\nsummary: Short relevance summary.\n---\n\nB.\n"
    );
    assert_eq!(
        serialize_node(&[field("summary", "中文摘要：决策一")], "B."),
        "---\nsummary: 中文摘要：决策一\n---\n\nB.\n"
    );
}

#[test]
fn ambiguous_scalars_are_double_quoted() {
    for (value, expected) in [
        ("123", "\"123\""),
        ("TRUE", "\"TRUE\""),
        ("null", "\"null\""),
        ("3.14", "\"3.14\""),
        ("- looks like list", "\"- looks like list\""),
        ("#comment", "\"#comment\""),
        ("ends with:", "\"ends with:\""),
        ("a: b", "\"a: b\""),
        ("[bracket]", "\"[bracket]\""),
        ("~", "\"~\""),
        ("", "\"\""),
        ("%directive", "\"%directive\""),
        ("@at", "\"@at\""),
        ("&anchor", "\"&anchor\""),
        ("*alias", "\"*alias\""),
        ("!tag", "\"!tag\""),
        ("|literal", "\"|literal\""),
        (">folded", "\">folded\""),
        ("{map}", "\"{map}\""),
        ("trailing ", "\"trailing \""),
        ("0o17", "\"0o17\""),
        ("0xFF", "\"0xFF\""),
        ("+42", "\"+42\""),
        ("1e3", "\"1e3\""),
        (".5", "\".5\""),
        ("-42", "\"-42\""),
        (".inf", "\".inf\""),
    ] {
        assert_eq!(
            serialize_node(&[field("summary", value)], "B."),
            format!("---\nsummary: {expected}\n---\n\nB.\n"),
            "value: {value:?}"
        );
    }
}

#[test]
fn multiline_strings_become_literal_blocks() {
    assert_eq!(
        serialize_node(&[field("summary", "line one\nline two")], "B."),
        "---\nsummary: |-\n  line one\n  line two\n---\n\nB.\n"
    );
    // A blank line inside the block stays unindented, like the yaml package.
    assert_eq!(
        serialize_node(
            &[
                (
                    "grounds".to_string(),
                    FieldValue::StrList(vec!["A1B2C3D4".to_string()])
                ),
                field("rationale", "para one\n\npara two"),
                field("summary", "s"),
            ],
            "B."
        ),
        "---\ngrounds:\n  - A1B2C3D4\nrationale: |-\n  para one\n\n  para two\nsummary: s\n---\n\nB.\n"
    );
}

#[test]
fn long_plain_scalars_fold_at_80_columns() {
    // Folded between words so the first line stays within 80 columns
    // including the "summary: " prefix; the continuation is indented by 2.
    let text = "start word word word word word word word word word word word word word word word word word word word word end";
    let out = serialize_node(&[field("summary", text)], "B.");
    let expected = "---\nsummary: start word word word word word word word word word word word word word\n  word word word word word word word end\n---\n\nB.\n";
    assert_eq!(out, expected);
}

#[test]
fn unbreakable_long_scalars_stay_on_one_line() {
    let text = "x".repeat(100);
    assert_eq!(
        serialize_node(&[field("summary", &text)], "B."),
        format!("---\nsummary: {text}\n---\n\nB.\n")
    );
}

#[test]
fn grounds_is_always_a_block_sequence() {
    assert_eq!(
        serialize_node(
            &[(
                "grounds".to_string(),
                FieldValue::StrList(vec!["A1B2C3D4".to_string()])
            )],
            "B."
        ),
        "---\ngrounds:\n  - A1B2C3D4\n---\n\nB.\n"
    );
    assert_eq!(
        serialize_node(
            &[(
                "grounds".to_string(),
                FieldValue::StrList(vec!["A1B2C3D4".to_string(), "B2C3D4E5".to_string()])
            )],
            "B."
        ),
        "---\ngrounds:\n  - A1B2C3D4\n  - B2C3D4E5\n---\n\nB.\n"
    );
    assert_eq!(
        serialize_node(
            &[("grounds".to_string(), FieldValue::StrList(vec![]))],
            "B."
        ),
        "---\ngrounds: []\n---\n\nB.\n".replace("[]", "[]") // empty list emits `[]` (flow), matching the yaml package
    );
}

#[test]
fn exploring_only_emits_true() {
    assert_eq!(
        serialize_node(&[("exploring".to_string(), FieldValue::BoolTrue)], "Trial."),
        "---\nexploring: true\n---\n\nTrial.\n"
    );
}
