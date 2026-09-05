import type { RefinoIssue } from "refino";

/**
 * Codes of issues and thrown errors emitted by this package for
 * storage-format violations. Graph-level semantics reuse the engine's
 * `IssueCode` as-is; only the concepts owned by the storage format live
 * here. The string values are the wire format (CLI `--json` output, web
 * API responses), so members keep their SCREAMING_SNAKE spelling as the
 * value.
 */
export enum StorageIssueCode {
  /** Frontmatter is not valid YAML, not a mapping, or a known field has the wrong shape. */
  InvalidFrontmatter = "INVALID_FRONTMATTER",
  /** `confirmed` is not an RFC 3339 timestamp with an explicit UTC offset (checked at the file boundary; the engine's memory form is epoch milliseconds). */
  InvalidConfirmed = "INVALID_CONFIRMED",
  /** A file under `nodes/` does not have the `<id_2>-<type>.md` shape the storage format requires. */
  InvalidNodePath = "INVALID_NODE_PATH",
  /** The `.refino` directory is missing or not a directory (thrown as a `RefinoError`). */
  RefinoDirNotFound = "REFINO_DIR_NOT_FOUND",
}

/**
 * An issue reported by this package. File paths are persistence vocabulary,
 * so they live here, not on the engine's `RefinoIssue`: every issue raised
 * against a file carries its canonical path, which is the only reliable
 * locator for files that never resolve to a node.
 */
export interface StorageIssue extends RefinoIssue {
  /** Canonical path of the node file, relative to the `.refino` directory. */
  file: string;
}
