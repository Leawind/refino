import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createRenderKit,
  createToolText,
  PARAM_TEXT,
  toolRefs,
  type ApprovalOutcome,
  type AuthorizationOrigin,
  type ContextStatusResult,
  type ListResult,
  type PendingResult,
  type QueryEntryDepths,
  type QueryEntryFull,
  type QueryEntryNodes,
  type SearchResult,
  type SignResult,
  type SiblingsResult,
  type WriteResult,
} from "@refino/harness";
import {
  createSigningCore,
  RefinoWorkspace,
  runAncestors,
  runCreateConstraint,
  runCreatePremise,
  runDeleteNode,
  runDependents,
  runGrounds,
  runList,
  runPendingReview,
  runSearch,
  runShow,
  runSiblings,
  runUpdateNode,
} from "@refino/harness/host";
import { MODEL_TOOL_PREFIX, TOOLS } from "./tool-names.js";

/**
 * The CRG tool table for the plugin's MCP server (docs/design.md, cc-plugin
 * 落地形态): names, JSON Schemas, defensive argument coercion and text
 * rendering over the shared execution cores. Protocol-free on purpose —
 * `server.ts` binds the table to MCP; tests call `execute` directly.
 */

const TOOLS_REFS = toolRefs(MODEL_TOOL_PREFIX);
const TEXT = createToolText(TOOLS_REFS);
const kit = createRenderKit(TOOLS_REFS);

const INACTIVE =
  "当前工作目录及其祖先目录均未找到 .refino/：该项目未采用 refino，本插件不接管。确需采用时须先获得用户明确同意（refino init），不得自行立户。";

/** One MCP tool: protocol shape plus the execute/render pair over a core. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  render: (value: unknown) => string;
}

export interface ToolTableDeps {
  /** The session workspace, or undefined while the repo has no `.refino/`. */
  obtainWorkspace: () => Promise<RefinoWorkspace | undefined>;
  /**
   * Approval surface for dialogue signing. The default implements the
   * dialogue-approval protocol (same level as the generic form): the
   * presentation-before-call and explicit-consent requirements live in the
   * tool description and skill rules, and the host's tool-permission prompt
   * is the optional mechanical layer on top.
   */
  requestApproval?: (reason: string) => Promise<ApprovalOutcome>;
  /** Deliver signing deltas (the cross-process injection queue). */
  deliver: (text: string | undefined) => void;
  env?: NodeJS.ProcessEnv;
}

async function dialogueApproval(): Promise<ApprovalOutcome> {
  return "allowed-once";
}

export function createToolTable(deps: ToolTableDeps): McpTool[] {
  const origin: AuthorizationOrigin = { source: "default", signedAt: "" };
  // The signing core's workspace handle is synchronous; the table resolves
  // it asynchronously before each signing/context call into this holder.
  let signingWorkspace: RefinoWorkspace | undefined;
  const signing = createSigningCore({
    get: () => signingWorkspace,
    requestApproval: deps.requestApproval ?? dialogueApproval,
    inject: deps.deliver,
    origin: () => origin,
    setOrigin: (next) => Object.assign(origin, next),
    env: deps.env,
  });
  const workspace = () => deps.obtainWorkspace();

  const list: McpTool = {
    name: TOOLS.list,
    description: TEXT.list,
    inputSchema: objectSchema({
      node_type: enumProp(["premise", "constraint"], PARAM_TEXT.listNodeType),
    }),
    async execute(args) {
      return runList(await requireWs(workspace), argType(args.node_type));
    },
    render: (value) => kit.renderList(value as ListResult),
  };
  const search: McpTool = {
    name: TOOLS.search,
    description: TEXT.search,
    inputSchema: objectSchema({
      q: stringProp(PARAM_TEXT.searchQ),
      node_type: enumProp(["premise", "constraint"], PARAM_TEXT.searchNodeType),
      limit: integerProp(PARAM_TEXT.searchLimit),
      cursor: stringProp(PARAM_TEXT.searchCursor),
    }),
    async execute(args) {
      return runSearch(await requireWs(workspace), {
        q: argString(args.q),
        type: argType(args.node_type),
        limit: argNumber(args.limit),
        cursor: argString(args.cursor),
      });
    },
    render: (value) => kit.renderSearch(value as SearchResult),
  };
  const show: McpTool = {
    name: TOOLS.show,
    description: TEXT.show,
    inputSchema: objectSchema({ ids: idsProp(PARAM_TEXT.idsShow) }, ["ids"]),
    async execute(args) {
      return runShow(await requireWs(workspace), argIds(args.ids));
    },
    render: (value) =>
      kit.renderEntries((value as { results: QueryEntryFull[] }).results, (entry) =>
        entry.node === undefined ? [] : [kit.renderFullNode(entry.node)],
      ),
  };
  const grounds: McpTool = {
    name: TOOLS.grounds,
    description: TEXT.grounds,
    inputSchema: objectSchema({ ids: idsProp(PARAM_TEXT.idsGrounds) }, ["ids"]),
    async execute(args) {
      return runGrounds(await requireWs(workspace), argIds(args.ids));
    },
    render: (value) =>
      kit.renderEntries((value as { results: QueryEntryNodes[] }).results, (entry) =>
        entry.nodes === undefined ? [] : entry.nodes.map(kit.nodeLine),
      ),
  };
  const ancestors: McpTool = {
    name: TOOLS.ancestors,
    description: TEXT.ancestors,
    inputSchema: objectSchema(
      { ids: idsProp(PARAM_TEXT.idsAncestors), max_depth: integerProp(PARAM_TEXT.maxDepth) },
      ["ids"],
    ),
    async execute(args) {
      return runAncestors(await requireWs(workspace), argIds(args.ids), argNumber(args.max_depth));
    },
    render: renderDepths(),
  };
  const dependents: McpTool = {
    name: TOOLS.dependents,
    description: TEXT.dependents,
    inputSchema: objectSchema(
      { ids: idsProp(PARAM_TEXT.idsDependents), max_depth: integerProp(PARAM_TEXT.maxDepth) },
      ["ids"],
    ),
    async execute(args) {
      return runDependents(await requireWs(workspace), argIds(args.ids), argNumber(args.max_depth));
    },
    render: renderDepths(),
  };
  const siblings: McpTool = {
    name: TOOLS.siblings,
    description: TEXT.siblings,
    inputSchema: objectSchema(
      { ids: idsProp(PARAM_TEXT.idsSiblings), limit: integerProp(PARAM_TEXT.siblingsLimit) },
      ["ids"],
    ),
    async execute(args) {
      return runSiblings(await requireWs(workspace), argIds(args.ids), argNumber(args.limit));
    },
    render: (value) => kit.renderSiblings(value as SiblingsResult),
  };
  const pendingReview: McpTool = {
    name: TOOLS.pendingReview,
    description: TEXT.pendingReview,
    inputSchema: objectSchema({ changed_ids: idsProp(PARAM_TEXT.changedIds) }, ["changed_ids"]),
    async execute(args) {
      return runPendingReview(await requireWs(workspace), argIds(args.changed_ids));
    },
    render: (value) => kit.renderPending(value as PendingResult),
  };
  const context: McpTool = {
    name: TOOLS.context,
    description: TEXT.context,
    inputSchema: objectSchema({}),
    async execute() {
      signingWorkspace = await requireWs(workspace);
      return signing.contextStatus();
    },
    render: (value) => kit.renderContextStatus(value as ContextStatusResult),
  };
  const createPremise: McpTool = {
    name: TOOLS.createPremise,
    description: TEXT.createPremise,
    inputSchema: objectSchema(
      {
        body: stringProp(PARAM_TEXT.bodyPremise),
        summary: stringProp(PARAM_TEXT.summary),
        confirmed: stringProp(PARAM_TEXT.confirmed),
        id: stringProp(PARAM_TEXT.explicitId),
      },
      ["body"],
    ),
    async execute(args) {
      return runCreatePremise(await requireWs(workspace), {
        body: argString(args.body) ?? "",
        summary: argString(args.summary),
        confirmed: argString(args.confirmed),
        id: argString(args.id),
      });
    },
    render: renderWrite(),
  };
  const createConstraint: McpTool = {
    name: TOOLS.createConstraint,
    description: TEXT.createConstraint,
    inputSchema: objectSchema(
      {
        body: stringProp(PARAM_TEXT.bodyConstraint),
        summary: stringProp(PARAM_TEXT.summary),
        rationale: stringProp(PARAM_TEXT.rationaleCreate),
        grounds: idsProp(PARAM_TEXT.grounds),
        id: stringProp(PARAM_TEXT.explicitId),
      },
      ["body"],
    ),
    async execute(args) {
      return runCreateConstraint(await requireWs(workspace), {
        body: argString(args.body) ?? "",
        summary: argString(args.summary),
        rationale: argString(args.rationale),
        grounds: argIdsOrUndefined(args.grounds),
        id: argString(args.id),
      });
    },
    render: renderWrite(),
  };
  const updateNode: McpTool = {
    name: TOOLS.updateNode,
    description: TEXT.updateNode,
    inputSchema: objectSchema(
      {
        id: stringProp(PARAM_TEXT.updateId),
        summary: stringProp(PARAM_TEXT.updateSummary),
        body: stringProp(PARAM_TEXT.updateBody),
        grounds: idsProp(PARAM_TEXT.updateGrounds),
        rationale: stringProp(PARAM_TEXT.updateRationale),
        confirmed: stringProp(PARAM_TEXT.updateConfirmed),
      },
      ["id"],
    ),
    async execute(args) {
      return runUpdateNode(await requireWs(workspace), {
        id: argString(args.id) ?? "",
        summary: argString(args.summary),
        body: argString(args.body),
        grounds: argIdsOrUndefined(args.grounds),
        rationale: argString(args.rationale),
        confirmed: argString(args.confirmed),
      });
    },
    render: renderWrite(),
  };
  const deleteNode: McpTool = {
    name: TOOLS.deleteNode,
    description: TEXT.deleteNode,
    inputSchema: objectSchema({ id: stringProp(PARAM_TEXT.deleteId) }, ["id"]),
    async execute(args) {
      return runDeleteNode(await requireWs(workspace), argString(args.id) ?? "");
    },
    render: renderWrite(),
  };
  const requestAuthorization: McpTool = {
    name: TOOLS.requestAuthorization,
    description: TEXT.requestAuthorization,
    inputSchema: objectSchema(
      {
        frozen_frontier: idsProp(
          "新冻结区的 frontier 约束 ID 列表（整体替换，冻结区即其全部祖先的闭包）；空列表表示解冻全部",
        ),
        rationale: stringProp(PARAM_TEXT.signRationale),
      },
      ["frozen_frontier"],
    ),
    async execute(args) {
      signingWorkspace = await requireWs(workspace);
      return signing.requestAuthorization({
        frozen_frontier: argIds(args.frozen_frontier),
        rationale: argString(args.rationale),
      });
    },
    render: (value) => kit.renderSign(value as SignResult),
  };

  return [
    list,
    search,
    show,
    grounds,
    ancestors,
    dependents,
    siblings,
    pendingReview,
    context,
    createPremise,
    createConstraint,
    updateNode,
    deleteNode,
    requestAuthorization,
  ];
}

async function requireWs(
  obtain: () => Promise<RefinoWorkspace | undefined>,
): Promise<RefinoWorkspace> {
  const ws = await obtain();
  if (ws === undefined) throw new Error(INACTIVE);
  return ws;
}

function renderDepths() {
  return (value: unknown): string =>
    kit.renderEntries((value as { results: QueryEntryDepths[] }).results, (entry) =>
      entry.nodes === undefined || entry.nodes.length === 0 ? [] : entry.nodes.map(kit.depthLine),
    );
}

function renderWrite() {
  return (value: unknown): string => kit.renderWrite(value as WriteResult);
}

// ---- JSON Schema helpers (plain JSON Schema; hosts pass it through) ----

function objectSchema(
  properties: Record<string, object>,
  required: string[] = [],
): Tool["inputSchema"] {
  return {
    type: "object" as const,
    properties,
    required,
    additionalProperties: false,
  };
}

function stringProp(description: string): object {
  return { type: "string" as const, description };
}

function integerProp(description: string): object {
  return { type: "integer" as const, description };
}

function enumProp(values: readonly string[], description: string): object {
  return { type: "string" as const, enum: [...values], description };
}

function idsProp(description: string): object {
  return { type: "array" as const, items: { type: "string" as const }, description };
}

// ---- defensive argument coercion (MCP arguments arrive as unknown JSON) ----

function argString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function argNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function argType(value: unknown): "premise" | "constraint" | undefined {
  return value === "premise" || value === "constraint" ? value : undefined;
}

function argIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function argIdsOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? argIds(value) : undefined;
}
