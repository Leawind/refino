import { describe, expect, it } from "vitest";
import { changedFields, mergeExternal, toEditorFields, type EditorFields } from "../src/conflict";

const fields = (overrides: Partial<EditorFields> = {}): EditorFields => ({
  summary: "摘要",
  body: "正文",
  rationale: "",
  grounds: [],
  confirmed: "",
  exploring: false,
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

  it("detects exploring mark edits as boolean flips", () => {
    expect(changedFields(fields(), fields({ exploring: true }))).toEqual(["exploring"]);
    expect(changedFields(fields({ exploring: true }), fields())).toEqual(["exploring"]);
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
      exploring: false,
    });
  });

  it("adopts an external exploring flip on an untouched field", () => {
    const base = fields();
    const external = fields({ exploring: true });
    expect(mergeExternal(base, fields(), external).merged.exploring).toBe(true);
    // A boolean field structurally cannot collide: from a shared base, any
    // user flip lands on the same value the external flip produced, and the
    // user-already-matches rule absorbs it.
    const matching = mergeExternal(base, fields({ exploring: true }), external);
    expect(matching.conflicts).toEqual([]);
    expect(matching.takenExternal).toEqual([]);
    expect(matching.merged.exploring).toBe(true);
  });
});

describe("toEditorFields", () => {
  it("fills absent optional fields with defaults", () => {
    const editor = toEditorFields({
      id: "A1B2C3D4",
      type: "premise",
      summary: "前提",
      body: "正文",
    });
    expect(editor).toEqual({
      summary: "前提",
      body: "正文",
      rationale: "",
      grounds: [],
      confirmed: "",
      exploring: false,
    });
  });

  it("carries the stored exploring mark as an explicit boolean", () => {
    const editor = toEditorFields({
      id: "B2C3D4E5",
      type: "constraint",
      summary: "试行",
      body: "正文",
      exploring: true,
    });
    expect(editor.exploring).toBe(true);
  });
});
