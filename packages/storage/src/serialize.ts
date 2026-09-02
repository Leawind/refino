import { stringify as stringifyYaml } from "yaml";

/**
 * Node serialization (in-memory fields -> markdown text), the engine's write
 * side. Filesystem writes live in @refino/node.
 */

/**
 * Serialize a node file. When none of the fields are present the frontmatter
 * block is omitted entirely; a body-only file is a valid node.
 */
export function serializeNode(fields: Record<string, unknown>, body: string): string {
  const present = Object.entries(fields).filter(([, v]) => v !== undefined);
  const trimmedBody = `${body.trimEnd()}\n`;
  if (present.length === 0) return trimmedBody;
  const data = Object.fromEntries(present);
  return `---\n${stringifyYaml(data).trimEnd()}\n---\n\n${trimmedBody}`;
}
