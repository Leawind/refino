import type { AuthorizationContext } from "@refino/harness";

/**
 * Data channel of the authorization console (docs/design.md, "用户侧：授权
 * 授权控制台"): a light graph snapshot plus the host's context operations.
 * Hosts (tool plugins) implement it over their in-process harness session;
 * the console itself stays graph-free by rebuilding a light engine graph
 * from the snapshot.
 */

/** Light node shape the console rebuilds its graph view from. */
export interface ConsoleNode {
  id: string;
  type: "premise" | "constraint";
  summary: string;
  /** Constraints only; premises declare none. */
  grounds?: string[];
}

export interface ConsoleClient {
  /** Light graph snapshot (no bodies). */
  fetchGraph(): Promise<ConsoleNode[]>;
  /** The currently effective context — signed, or the host's default. */
  fetchContext(): Promise<AuthorizationContext | null>;
  /** Sign the draft context; the host validates, derives the delta and injects it. */
  sign(context: AuthorizationContext): Promise<void>;
}
