/**
 * Tool naming for the cc plugin (docs/design.md, cc-plugin 落地形态): the
 * MCP server registers short snake_case names; hosts surface them to the
 * model as `mcp__<server>__<tool>`. The model-side prefix feeds `ToolRefs`
 * so injected and rendered texts cite the names the model actually calls.
 */

export const MCP_SERVER_NAME = "refino";

/** Model-side prefix: full names like `mcp__refino__show`. */
export const MODEL_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

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

/** Model-side full names, for texts and skill rules. */
export const MODEL_TOOLS = {
  list: `${MODEL_TOOL_PREFIX}${TOOLS.list}`,
  search: `${MODEL_TOOL_PREFIX}${TOOLS.search}`,
  show: `${MODEL_TOOL_PREFIX}${TOOLS.show}`,
  grounds: `${MODEL_TOOL_PREFIX}${TOOLS.grounds}`,
  ancestors: `${MODEL_TOOL_PREFIX}${TOOLS.ancestors}`,
  dependents: `${MODEL_TOOL_PREFIX}${TOOLS.dependents}`,
  siblings: `${MODEL_TOOL_PREFIX}${TOOLS.siblings}`,
  pendingReview: `${MODEL_TOOL_PREFIX}${TOOLS.pendingReview}`,
  context: `${MODEL_TOOL_PREFIX}${TOOLS.context}`,
  requestAuthorization: `${MODEL_TOOL_PREFIX}${TOOLS.requestAuthorization}`,
} as const;
