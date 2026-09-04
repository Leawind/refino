import { describe, expect, it } from "vitest";
import { changedFields, mergeExternal, toEditorFields, type EditorFields } from "../src/conflict";

const fields = (overrides: Partial<EditorFields> = {}): EditorFields => ({
  summary: "摘要",
  body: "正文",
  rationale: "",
  grounds: [],
  confirmed: "",
  ...overrides,
});

describe("changedFields", () => {
  it("detects per-field edits, grounds order-sensitively", () => {
    expect(changedFields(fields(), fields())).toEqual([]);
    expect(changedFields(fields(), fields({ body: "改" }))).toEqual(["body"]);
    expect(changedFields(fields({ grounds: ["A", "B"] }), fields({ grounds: ["B", "A"] }))).toEqual(
      ["grounds"],
    );
  });
});

describe("mergeExternal", () => {
  it("keeps the form when nothing changed externally", () => {
    const base = fields();
    const result = mergeExternal(base, fields({ body: "我的" }), base);
    expect(result.takenExternal).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.body).toBe("我的");
  });

  it("adopts external changes on fields the user did not touch", () => {
    const base = fields();
    const external = fields({ summary: "外部", body: "外部正文" });
    const result = mergeExternal(base, fields(), external);
    expect(result.takenExternal).toEqual(["summary", "body"]);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.summary).toBe("外部");
  });

  it("flags a collision when the user edited an externally changed field", () => {
    const base = fields();
    const external = fields({ body: "外部正文" });
    const result = mergeExternal(base, fields({ body: "我的正文" }), external);
    expect(result.conflicts).toEqual(["body"]);
    expect(result.merged.body).toBe("我的正文"); // untouched by the merge
  });

  it("treats an edit matching the external value as no conflict", () => {
    const base = fields();
    const external = fields({ body: "外部正文" });
    const result = mergeExternal(base, fields({ body: "外部正文" }), external);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.body).toBe("外部正文");
  });

  it("merges and conflicts independently per field", () => {
    const base = fields({ rationale: "旧理由" });
    const external = fields({ summary: "外部摘要", body: "外部正文", rationale: "外部理由" });
    // The user edited body (collision) while rationale stayed as loaded:
    // the external rationale wins there.
    const result = mergeExternal(base, fields({ body: "我的正文", rationale: "旧理由" }), external);
    expect(result.takenExternal).toEqual(["summary", "rationale"]);
    expect(result.conflicts).toEqual(["body"]);
    expect(result.merged).toEqual({
      summary: "外部摘要",
      body: "我的正文",
      rationale: "外部理由",
      grounds: [],
      confirmed: "",
    });
  });
});

describe("toEditorFields", () => {
  it("fills absent optional fields with defaults", () => {
    const editor = toEditorFields({
      id: "A1B2C3D4",
      type: "premise",
      file: "nodes/A1/B2C3D4-premise.md",
      summary: "前提",
      body: "正文",
    });
    expect(editor).toEqual({
      summary: "前提",
      body: "正文",
      rationale: "",
      grounds: [],
      confirmed: "",
    });
  });
});
