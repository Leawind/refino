/**
 * Field-level conflict resolution for the detail editor (docs/design.md,
 * "编辑冲突处理"). The editor keeps a base snapshot (the fields as loaded or
 * last merged) alongside the user's current form values; when an external
 * change arrives, each field is classified independently:
 *
 * - unchanged externally: the user's value (if any) stays;
 * - changed externally, untouched by the user: the external value is taken
 *   (silent field-level merge);
 * - changed externally while the user also edited it into something else:
 *   a conflict — the UI offers loading the external version or keeping the
 *   local edits (which then overwrite on save).
 */

export type EditorField = "summary" | "body" | "rationale" | "grounds" | "confirmed";

export const EDITOR_FIELDS: readonly EditorField[] = [
  "summary",
  "body",
  "rationale",
  "grounds",
  "confirmed",
];

export interface EditorFields {
  summary: string;
  body: string;
  rationale: string;
  grounds: string[];
  confirmed: string;
}

/** The node fields the editor works on; accepts read-only records. */
export interface EditorSource {
  summary: string;
  body: string;
  rationale?: string;
  grounds?: readonly string[];
  confirmed?: string;
}

/** Editor-facing fields of a node record, with defaults filled in. */
export function toEditorFields(node: EditorSource): EditorFields {
  return {
    summary: node.summary,
    body: node.body,
    rationale: node.rationale ?? "",
    grounds: [...(node.grounds ?? [])],
    confirmed: node.confirmed ?? "",
  };
}

function sameValue(a: string | readonly string[], b: string | readonly string[]): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
    );
  }
  return a === b;
}

/** Fields whose current value differs from the base snapshot. */
export function changedFields(base: EditorFields, current: EditorFields): EditorField[] {
  return EDITOR_FIELDS.filter((field) => !sameValue(base[field], current[field]));
}

export interface ExternalMerge {
  /** Fields where the external value was adopted (user had not touched them). */
  takenExternal: EditorField[];
  /** Fields where the user's edit collides with the external change. */
  conflicts: EditorField[];
  /** Form values after adopting the non-conflicting external changes. */
  merged: EditorFields;
}

/**
 * Classifies every externally changed field and produces the merged form
 * values: external changes land unless the user also edited the field into
 * something different from the external value.
 */
export function mergeExternal(
  base: EditorFields,
  form: EditorFields,
  external: EditorFields,
): ExternalMerge {
  const takenExternal: EditorField[] = [];
  const conflicts: EditorField[] = [];
  const merged: EditorFields = { ...form, grounds: [...form.grounds] };
  for (const field of EDITOR_FIELDS) {
    if (sameValue(base[field], external[field])) continue; // unchanged externally
    if (sameValue(form[field], external[field])) continue; // user already matches
    const userTouched = !sameValue(base[field], form[field]);
    if (userTouched) {
      conflicts.push(field);
    } else {
      takenExternal.push(field);
      // A union-keyed write infers an impossible intersection type; go
      // through an unknown-valued view.
      (merged as Record<EditorField, unknown>)[field] = Array.isArray(external[field])
        ? [...external[field]]
        : external[field];
    }
  }
  return { takenExternal, conflicts, merged };
}
