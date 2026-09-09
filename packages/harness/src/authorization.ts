import type { Graph } from "refino";
import { getAncestors } from "refino";
import { frozenFrontier, frozenZone, validateContext } from "./boundary.js";
import { defaultAuthorizationContext } from "./default.js";
import { HarnessError } from "./errors.js";
import { byId } from "./types.js";
import type { AuthorizationContext } from "./types.js";

/**
 * A signed authorization document: the persistable form of a task's frozen
 * zone (docs/design.md, "harness 与工具插件功能设计"). One schema serves three
 * origins with decreasing precedence — an orchestrator credential (env var
 * or explicit path), a plugin's in-session signing, and the materialized
 * default. Whatever the
 * origin, the effective context is re-derived against the current graph at
 * read time: zone closure follows the live `grounds` edges, so ancestors
 * that grow after signing join the zone without re-signing, and entries
 * whose nodes were deleted are silently dropped (`convergeAuthorization`).
 *
 * Anchors are deliberately absent: they are an injection-policy parameter
 * derived at runtime (`defaultAuthorizationContext`), not a signed fact —
 * documents signed before this change may still carry an `anchors` field,
 * which parses as an unknown field and is ignored.
 */
export interface SignedAuthorization {
  version: 1;
  /** RFC 3339 UTC timestamp of signing. */
  signedAt: string;
  /**
   * Monotonic revision; 0 denotes the unsigned default. Signing increments by
   * one, so optimistic concurrency (`--expect-revision`) can branch on it.
   */
  revision: number;
  /**
   * The frozen zone's minimal representation (its most downstream
   * constraints). Stored instead of the full zone so the zone semantics keep
   * following the graph.
   */
  frozenFrontier: string[];
}

/** The authorization context a signed document acts as, over the given graph. */
export function authorizationContextOf(
  graph: Graph,
  doc: SignedAuthorization,
): AuthorizationContext {
  return {
    anchors: defaultAuthorizationContext(graph).context.anchors,
    frozen: doc.frozenFrontier,
  };
}

function fail(detail: string): never {
  throw new HarnessError("INVALID_AUTHORIZATION", `Invalid authorization document: ${detail}`);
}

/** Parse and shape-check a signed authorization document (e.g. from JSON). */
export function parseSignedAuthorization(value: unknown): SignedAuthorization {
  if (typeof value !== "object" || value === null) fail("expected an object");
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1) fail(`"version" must be 1, got ${JSON.stringify(doc.version)}`);
  const signedAt = doc.signedAt;
  if (typeof signedAt !== "string") fail(`"signedAt" must be an RFC 3339 timestamp string`);
  if (Number.isNaN(Date.parse(signedAt))) {
    fail(`"signedAt" must be an RFC 3339 timestamp, got ${JSON.stringify(signedAt)}`);
  }
  const revision = doc.revision;
  if (typeof revision !== "number") fail(`"revision" must be a non-negative integer`);
  if (!Number.isInteger(revision) || revision < 0) {
    fail(`"revision" must be a non-negative integer, got ${JSON.stringify(revision)}`);
  }
  return {
    version: 1,
    signedAt,
    revision,
    frozenFrontier: parseIdList(doc.frozenFrontier, "frozenFrontier", fail),
  };
}

function parseIdList(value: unknown, field: string, fail: (detail: string) => never): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    fail(`"${field}" must be an array of node ids, got ${JSON.stringify(value)}`);
  }
  return [...(value as string[])];
}

/** Epoch date as the document's RFC 3339 (UTC) form. */
function rfc3339(date: Date): string {
  return date.toISOString();
}

/**
 * Materialize the unsigned default as a document (docs/design.md, dsh plugin
 * defaults): the frontier names all root constraints. Revision 0; the
 * default is derived live and never persisted.
 */
export function materializeDefaultAuthorization(
  graph: Graph,
  now: Date = new Date(),
): SignedAuthorization {
  const { context } = defaultAuthorizationContext(graph);
  return {
    version: 1,
    signedAt: rfc3339(now),
    revision: 0,
    frozenFrontier: [...context.frozen],
  };
}

/**
 * Re-derive a signed document against the current graph: drop entries whose
 * nodes no longer exist (deleted externally, e.g. via git) and reduce the
 * frontier back to the zone's minimal representation — a frontier node may
 * have gained a downstream refinement since signing, and the zone then reads
 * through the refinement instead. Ids are deduplicated. Read-side only:
 * signing (`applyAuthorization`) validates strictly instead.
 */
export function convergeAuthorization(graph: Graph, doc: SignedAuthorization): SignedAuthorization {
  const frontier = [...new Set(doc.frozenFrontier)].filter((id) => {
    const node = graph.nodes.get(id);
    return node !== undefined && node.type === "constraint";
  });
  // The zone's minimal representation may have drifted from the stored
  // frontier (the graph grew or shrank since signing); recompute it from the
  // zone so unfreeze operations keep acting on true frontier nodes.
  const minimal = frozenFrontier(graph, { anchors: [], frozen: frontier }).map((n) => n.id);
  return { ...doc, frozenFrontier: minimal };
}

/** A draft for `applyAuthorization`: the full new document content. */
export interface ApplyDraft {
  frozenFrontier: string[];
}

/** What `applyAuthorization` reports about the signing it is about to make. */
export interface ApplyPreview {
  /** Frozen-zone size after applying, by node type. */
  frozenConstraints: number;
  frozenPremises: number;
  /**
   * Current root constraints the draft leaves outside the frozen zone.
   * Unfreezing roots lifts the project's highest-level decisions into the
   * modification space (docs/crg.md 1.3) — callers must warn loudly.
   */
  unfrozenRoots: string[];
  /** Frontier candidates dropped because another candidate dominates them. */
  redundantFrontier: string[];
}

/**
 * Validate a draft and turn it into the next signed document. The draft must
 * reference existing constraint nodes and list each id at most once
 * (`validateContext` semantics — signing is strict, unlike read-side
 * convergence); anchors are derived automatically and need no drafting. The
 * frontier is reduced to the zone's minimal representation: naming a
 * constraint together with one of its ancestors is accepted and the ancestor
 * is dropped as redundant. The returned document carries the given revision;
 * callers own revision policy.
 */
export function applyAuthorization(
  graph: Graph,
  draft: ApplyDraft,
  options: { now?: Date; revision: number },
): { doc: SignedAuthorization; preview: ApplyPreview } {
  const context: AuthorizationContext = {
    anchors: defaultAuthorizationContext(graph).context.anchors,
    frozen: [...draft.frozenFrontier],
  };
  validateContext(graph, context);
  const redundant = new Set(
    context.frozen.filter((id) =>
      context.frozen.some(
        (other) => other !== id && getAncestors(graph, other).some((a) => a.node.id === id),
      ),
    ),
  );
  const frontier = context.frozen.filter((id) => !redundant.has(id));
  const zone = frozenZone(graph, { anchors: context.anchors, frozen: frontier });
  const zoneIds = new Set(zone.map((n) => n.id));
  const unfrozenRoots = byId(
    [...graph.nodes.values()].filter(
      (n) => n.type === "constraint" && n.grounds.length === 0 && !zoneIds.has(n.id),
    ),
  ).map((n) => n.id);
  const doc: SignedAuthorization = {
    version: 1,
    signedAt: rfc3339(options.now ?? new Date()),
    revision: options.revision,
    frozenFrontier: frontier,
  };
  return {
    doc,
    preview: {
      frozenConstraints: zone.filter((n) => n.type === "constraint").length,
      frozenPremises: zone.filter((n) => n.type === "premise").length,
      unfrozenRoots,
      redundantFrontier: [...redundant].sort(),
    },
  };
}
