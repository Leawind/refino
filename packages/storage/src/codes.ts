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
  /** A file under `nodes/` does not have the `<id_2>-<type>.md` shape the storage format requires. */
  InvalidNodePath = "INVALID_NODE_PATH",
  /** The `.refino` directory is missing or not a directory (thrown as a `RefinoError`). */
  RefinoDirNotFound = "REFINO_DIR_NOT_FOUND",
}
