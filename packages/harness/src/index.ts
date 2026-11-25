export { HarnessError } from "./errors.js";
export type { HarnessErrorCode } from "./errors.js";
export { derivedAnchors, type DerivedAnchors } from "./anchors.js";
export { pendingReview } from "./pending.js";
export { EXPLORING_PROTOCOL, contextBlocks, diffAnchors, renderContext } from "./context.js";
export { searchNodes } from "./search.js";
export type { SearchPage, SearchParams } from "./search.js";
export { DEFAULT_STALE_DAYS, staleNodes } from "./stale.js";
export type { StaleNode, StaleReport } from "./stale.js";
export { HarnessSession } from "./session.js";
export { byId, toolRefs, unknownNodes } from "./types.js";
export type { ContextBlock, DeltaEvent, ToolRefs } from "./types.js";
export {
  initialContextText,
  orientationRoots,
  orientationText,
  reminderFrame,
  updateText,
} from "./inject-text.js";
// Type-only: the known set itself is node-bound (content hashing), but its
// change vocabulary rides the browser-safe updateText signature.
export type { KnownChange, KnownEntry } from "./known-set.js";
export { createRenderKit, type RenderKit } from "./render.js";
export { createToolText, PARAM_TEXT, type ToolText } from "./descriptions.js";
export { depthLite, fullLite, issueLite, lite } from "./shapes.js";
export type {
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
  SiblingsResult,
  StaleNodeLite,
  StaleResult,
  WriteResult,
} from "./shapes.js";
export type { QueryGroup } from "refino";
