/**
 * `@refino/harness/host` — the shared tool-plugin core. Everything a host adapter
 * needs beyond the pure main entry: the session workspace over the storage Store,
 * external sync coalescing, the DLG tool execution cores and their render inputs.
 *
 * Node-only by necessity (the Store) and exported as this subpath so the
 * platform-agnostic main entry stays browser-safe.
 */

export { RefinoWorkspace, type ExternalSyncListener, type SyncOutcome } from "./workspace.js";
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
  runStale,
} from "./query-core.js";
export {
  runCreateDecision,
  runCreatePremise,
  runDeleteNode,
  runUpdateNode,
  type CreateDecisionArgs,
  type CreatePremiseArgs,
  type UpdateNodeArgs,
} from "./write-core.js";
