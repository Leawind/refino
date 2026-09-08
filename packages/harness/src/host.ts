/**
 * `@refino/harness/host` — the shared tool-plugin core (docs/design.md,
 * “harness 与工具插件的分工”). Everything a host adapter needs beyond the
 * pure main entry: the session workspace over the storage Store, external
 * sync coalescing, the CRG tool execution cores, dialogue signing and
 * session-start authorization resolution.
 *
 * Node-only by necessity (the Store) and exported as this subpath so the
 * platform-agnostic main entry stays browser-safe (same policy as
 * `@refino/harness/state`).
 */

export {
  RefinoWorkspace,
  resolveAuthorization,
  type ExternalSyncListener,
  type ResolvedAuthorization,
  type SyncOutcome,
} from "./workspace.js";
export { DeltaCoalescer, type CoalescerDeps } from "./coalesce.js";
export {
  SessionKnownSet,
  contentHash,
  type KnownChange,
  type KnownDiffRead,
  type KnownEntry,
} from "./known-set.js";
export {
  runAncestors,
  runDependents,
  runGrounds,
  runList,
  runPendingReview,
  runSearch,
  runShow,
  runSiblings,
} from "./query-core.js";
export {
  runCreateConstraint,
  runCreatePremise,
  runDeleteNode,
  runUpdateNode,
  type CreateConstraintArgs,
  type CreatePremiseArgs,
  type UpdateNodeArgs,
} from "./write-core.js";
export {
  approvalReason,
  createSigningCore,
  OUTCOME_TEXT,
  type SigningCore,
  type SigningDeps,
} from "./signing-core.js";
