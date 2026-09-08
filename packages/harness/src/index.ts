export { HarnessError } from "./errors.js";
export type { HarnessErrorCode } from "./errors.js";
export {
  checkModification,
  checkModifications,
  freezableConstraints,
  frozenFrontier,
  frozenZone,
  validateContext,
} from "./boundary.js";
export { defaultAuthorizationContext } from "./default.js";
export {
  applyAuthorization,
  authorizationContextOf,
  convergeAuthorization,
  materializeDefaultAuthorization,
  parseSignedAuthorization,
} from "./authorization.js";
export type { ApplyDraft, ApplyPreview, SignedAuthorization } from "./authorization.js";
export { pendingReview } from "./pending.js";
export { contextBlocks, diffContext, estimateContext, renderContext } from "./context.js";
export { searchNodes } from "./search.js";
export type { SearchPage, SearchParams } from "./search.js";
export { HarnessSession } from "./session.js";
export type { HarnessHost } from "./session.js";
export { byId, toolRefs, unknownNodes } from "./types.js";
export type {
  AuthorizationContext,
  ContextBlock,
  ContextBlockKind,
  DefaultContext,
  DeltaEvent,
  EscalationReport,
  ModificationCheck,
  NodeZone,
  ToolRefs,
} from "./types.js";
export {
  authorizationStatusText,
  initialContextText,
  orientationRoots,
  orientationText,
  reminderFrame,
  updateText,
} from "./inject-text.js";
export type { AuthorizationOrigin } from "./inject-text.js";
// Type-only: the known set itself is node-bound (content hashing), but its
// change vocabulary rides the browser-safe updateText signature.
export type { KnownChange, KnownEntry } from "./known-set.js";
export { createRenderKit, type RenderKit } from "./render.js";
export { createToolText, PARAM_TEXT, type ToolText } from "./descriptions.js";
export { depthLite, fullLite, issueLite, lite } from "./shapes.js";
export type {
  ApprovalOutcome,
  ContextStatusResult,
  EscalationLite,
  FullNodeLite,
  IssueLite,
  ListResult,
  NodeDepthLite,
  NodeLite,
  PendingResult,
  QueryEntryDepths,
  QueryEntryFull,
  QueryEntryNodes,
  QueryEntrySiblings,
  SearchResult,
  SiblingLite,
  SignResult,
  SiblingsResult,
  WriteResult,
} from "./shapes.js";
export type { QueryGroup } from "refino";
