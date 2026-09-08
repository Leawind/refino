/**
 * Tool naming for the cc plugin (docs/design.md, cc-plugin 落地形态): the
 * MCP server registers short snake_case names; the host surfaces them under
 * its own scheme and injects the full names into the model's tool list
 * (ZCode, verified 2026-09: `mcp__plugin_refino_refino__<tool>`). Texts and
 * the skill cite the bare short names — a hard-coded host prefix would drift
 * per host.
 */

export const MCP_SERVER_NAME = "refino";

/** Short tool names registered on the MCP server (one per CRG capability). */
export const TOOLS = {
  list: "list",
  search: "search",
  show: "show",
  grounds: "grounds",
  ancestors: "ancestors",
  dependents: "dependents",
  siblings: "siblings",
  pendingReview: "pending_review",
  context: "context",
  createPremise: "create_premise",
  createConstraint: "create_constraint",
  updateNode: "update_node",
  deleteNode: "delete_node",
  requestAuthorization: "request_authorization",
} as const;
