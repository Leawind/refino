import type { Store } from "./store";
import type { Workspace } from "./workspace";
import type { NodeOps } from "./nodeOps";
import { toggleHelp } from "./help";
import { openPalette } from "./palette";
import { viewportBridge } from "./viewportBridge";

/**
 * The global command registry (ui DESIGN.md, "命令面板"): one descriptor per
 * global action. The palette lists them (searchable, with key hints), the
 * shortcut dispatcher binds their keys and the help overlay renders them —
 * a single source of truth instead of three drifting lists.
 *
 * Commands are metadata plus a run function over the composition root's
 * context; viewport actions ride `viewportBridge` so the renderer instance
 * inside the canvas component stays decoupled from this module.
 */

export interface CommandContext {
  store: Store;
  workspace: Workspace;
  nodeOps: NodeOps;
}

/** One keybinding. `key` matches event.key (case-insensitive); `code`
 * matches event.code instead — for modifier-bearing top-row keys, where
 * event.key carries the shifted character (Shift+1 types "!"). Modifiers
 * must match exactly; a binding without `shift` accepts both states, so
 * character keys like "?" (Shift+/ on US layouts) stay layout-tolerant. */
export interface Binding {
  key?: string;
  code?: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
}

export interface Command {
  id: string;
  /** i18n key, or a function picking the key from the context (toggle-style
   * commands name their target state, like the theme toggle). */
  labelKey: string | ((ctx: CommandContext) => string);
  /** Dynamic suffix after the label ("方向 →", "前提事实层: 开"). */
  detail?: (ctx: CommandContext, t: (key: string) => string) => string;
  /** Display string for the keybinding (palette rows and the help overlay). */
  keys?: string;
  bindings?: Binding[];
  run(ctx: CommandContext): void;
}

/** Whether a keyboard event satisfies one binding. */
export function matchBinding(event: KeyboardEvent, binding: Binding): boolean {
  // Alt is the peek modifier (ui DESIGN.md, "交互") and never prefixes a
  // command; no binding may fire under it.
  if (event.altKey) return false;
  if (binding.ctrlOrMeta === true) {
    if (!event.ctrlKey && !event.metaKey) return false;
  } else if (event.ctrlKey || event.metaKey) {
    return false;
  }
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false;
  if (binding.code !== undefined) return event.code === binding.code;
  if (binding.key === undefined) return false;
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

const ZOOM_IN_STEP = 1.25;

/** Modifier prefix of the display strings (palette rows, help overlay):
 * Cmd on Apple platforms, Ctrl elsewhere. */
export const MOD_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

function createCommands(): Command[] {
  return [
    {
      id: "command-palette",
      labelKey: "palette.title",
      keys: `${MOD_LABEL}K`,
      bindings: [{ key: "k", ctrlOrMeta: true }],
      run: () => openPalette(),
    },
    {
      id: "create-decision",
      labelKey: "node.createDecision",
      run: ({ store }) => store.startCreate("decision"),
    },
    {
      id: "create-premise",
      labelKey: "node.createPremise",
      run: ({ store }) => store.startCreate("premise"),
    },
    {
      id: "theme",
      labelKey: (ctx) => (ctx.store.state.theme === "dark" ? "app.themeLight" : "app.themeDark"),
      run: ({ store }) => store.setTheme(store.state.theme === "dark" ? "light" : "dark"),
    },
    {
      id: "view-toggle",
      labelKey: (ctx) =>
        ctx.workspace.state.config.canvasView === "orbit"
          ? "canvas.viewPlanar"
          : "canvas.viewOrbit",
      keys: "V",
      bindings: [{ key: "v" }],
      run: ({ workspace }) =>
        workspace.setConfig({
          canvasView: workspace.state.config.canvasView === "orbit" ? "planar" : "orbit",
        }),
    },
    {
      id: "layout-layered",
      labelKey: "app.layoutLayered",
      run: ({ workspace }) => workspace.setConfig({ layoutMode: "layered" }),
    },
    {
      id: "layout-force",
      labelKey: "app.layoutForce",
      run: ({ workspace }) => workspace.setConfig({ layoutMode: "force" }),
    },
    {
      id: "layout-rail",
      labelKey: "app.layoutRail",
      run: ({ workspace }) => workspace.setConfig({ layoutMode: "rail" }),
    },
    {
      id: "direction-lr",
      labelKey: "app.direction",
      detail: () => "→",
      run: ({ workspace }) => workspace.setConfig({ direction: "LR" }),
    },
    {
      id: "direction-tb",
      labelKey: "app.direction",
      detail: () => "↓",
      run: ({ workspace }) => workspace.setConfig({ direction: "TB" }),
    },
    {
      id: "direction-rl",
      labelKey: "app.direction",
      detail: () => "←",
      run: ({ workspace }) => workspace.setConfig({ direction: "RL" }),
    },
    {
      id: "direction-bt",
      labelKey: "app.direction",
      detail: () => "↑",
      run: ({ workspace }) => workspace.setConfig({ direction: "BT" }),
    },
    {
      id: "premises",
      labelKey: "canvas.premises",
      detail: (ctx, t) =>
        ctx.workspace.state.config.showPremises ? t("common.on") : t("common.off"),
      run: ({ workspace }) =>
        workspace.setConfig({ showPremises: !workspace.state.config.showPremises }),
    },
    {
      id: "minimap",
      labelKey: "canvas.minimap",
      detail: (ctx, t) =>
        ctx.workspace.state.config.showMinimap ? t("common.on") : t("common.off"),
      run: ({ workspace }) =>
        workspace.setConfig({ showMinimap: !workspace.state.config.showMinimap }),
    },
    {
      id: "virtual-root",
      labelKey: "canvas.virtualRoot",
      detail: (ctx, t) =>
        ctx.workspace.state.config.showVirtualRoot ? t("common.on") : t("common.off"),
      run: ({ workspace }) =>
        workspace.setConfig({ showVirtualRoot: !workspace.state.config.showVirtualRoot }),
    },
    {
      id: "view-zoom-in",
      labelKey: "app.zoomIn",
      keys: `${MOD_LABEL}=`,
      bindings: [
        { key: "=", ctrlOrMeta: true },
        { key: "+", ctrlOrMeta: true },
        { code: "NumpadAdd", ctrlOrMeta: true },
      ],
      run: () => viewportBridge.commands?.zoomBy(ZOOM_IN_STEP),
    },
    {
      id: "view-zoom-out",
      labelKey: "app.zoomOut",
      keys: `${MOD_LABEL}-`,
      bindings: [
        { key: "-", ctrlOrMeta: true },
        { code: "NumpadSubtract", ctrlOrMeta: true },
      ],
      run: () => viewportBridge.commands?.zoomBy(1 / ZOOM_IN_STEP),
    },
    {
      id: "view-fit",
      labelKey: "app.fitView",
      keys: "Shift+1",
      bindings: [{ code: "Digit1", shift: true }],
      run: () => viewportBridge.commands?.fitView(),
    },
    {
      id: "view-fit-selection",
      labelKey: "app.fitSelection",
      keys: "Shift+2",
      bindings: [{ code: "Digit2", shift: true }],
      run: () => viewportBridge.commands?.fitSelection(),
    },
    {
      id: "node-delete",
      labelKey: "node.delete",
      keys: "Del",
      bindings: [{ key: "Delete" }, { key: "Backspace" }],
      run: ({ workspace, nodeOps }) => {
        const id = workspace.state.focusId;
        if (id !== null) void nodeOps.deleteNode(id);
      },
    },
    {
      id: "help-shortcuts",
      labelKey: "app.shortcuts",
      keys: "?",
      bindings: [{ key: "?" }],
      run: () => toggleHelp(),
    },
    {
      id: "refresh",
      labelKey: "app.refresh",
      run: ({ workspace }) => void workspace.reload(),
    },
  ];
}

/** The one command list: the palette, the shortcut dispatcher and the help
 * overlay all consume this instance. */
export const commands: Command[] = createCommands();

/** Resolves a command's full label: translated base plus optional detail. */
export function commandLabel(
  command: Command,
  ctx: CommandContext,
  t: (key: string) => string,
): string {
  const key = typeof command.labelKey === "function" ? command.labelKey(ctx) : command.labelKey;
  const base = t(key);
  return command.detail === undefined ? base : `${base}: ${command.detail(ctx, t)}`;
}
