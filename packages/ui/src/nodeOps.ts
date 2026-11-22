import { inject, type InjectionKey } from "vue";
import type { RefinoClient } from "./api";
import { confirmAction, notify } from "./feedback";
import type { NodeLite, NodePayload } from "./types";
import type { Store } from "./store";
import type { Workspace } from "./workspace";

/**
 * Canvas-side node operations (ui DESIGN.md, "交互"/"编辑功能"): the connect
 * gesture writes a ground directly, and deletion runs the same guarded flow
 * from the context menu and the Delete key. UI feedback rides the feedback
 * seam; the confirm dialog keeps destructive deletion off single gestures.
 */

export interface NodeOps {
  /**
   * Adds `groundId` to the decision `targetId`'s grounds, saving directly.
   * A live edit session holding unsaved edits for the target owns the node:
   * the ground joins its draft instead of racing the merge flow.
   */
  addGround(targetId: string, groundId: string): Promise<"added" | "duplicate" | "draft" | "error">;
  /** Guarded delete: blocked with a notice while dependents exist, else a
   * confirm dialog, then the store's remove. */
  deleteNode(id: string): Promise<void>;
}

export const nodeOpsKey: InjectionKey<NodeOps> = Symbol("refino-node-ops");

/** Injection with fail-fast semantics, mirroring `context.ts`. */
export function injectRequiredNodeOps(): NodeOps {
  const ops = inject(nodeOpsKey, null);
  if (ops === null) throw new Error("NodeOps not provided");
  return ops;
}

export function createNodeOps(
  client: RefinoClient,
  store: Store,
  workspace: Workspace,
  t: (key: string, named?: Record<string, unknown>) => string,
): NodeOps {
  /** Whether an edit session for the node is alive and holds (or may hold)
   * user edits — direct writes would race the external-merge flow. */
  function sessionOwns(id: string): boolean {
    return (
      store.state.detail.id === id &&
      (store.state.detailOpen || store.state.inlineId === id || store.isDirty(id))
    );
  }

  async function addGround(
    targetId: string,
    groundId: string,
  ): Promise<"added" | "duplicate" | "draft" | "error"> {
    try {
      const detail = await client.fetchNode(targetId);
      const node = detail.node;
      if (node.type !== "decision") return "error";
      if (sessionOwns(targetId)) {
        if (store.form.grounds.includes(groundId)) return "duplicate";
        store.form.grounds = [...store.form.grounds, groundId];
        return "draft";
      }
      const grounds = node.grounds ?? [];
      if (grounds.includes(groundId)) return "duplicate";
      const payload: NodePayload = {
        body: node.body,
        summary: node.summary,
        grounds: [...grounds, groundId],
        rationale: node.rationale,
        // The exploring boolean is always stated: an omitted field would
        // settle a trial decision (docs/design.md, "编辑冲突处理").
        exploring: node.exploring === true,
        ...(node.confirmed !== undefined && {
          confirmed: new Date(node.confirmed).toISOString(),
        }),
      };
      await client.updateNode(targetId, payload, detail.revision);
      // The SSE feed carries our own write; refresh covers the window
      // where the feed is unavailable.
      void workspace.refresh();
      return "added";
    } catch {
      return "error";
    }
  }

  async function deleteNode(id: string): Promise<void> {
    try {
      const groups = await client.queryNeighbors([id], { ancestorDepth: 0, descendantDepth: 1 });
      const dependents = groups
        .flatMap((group) => ("results" in group ? (group.results[0]?.nodes ?? []) : []))
        .filter((node: NodeLite) => node.id !== id);
      if (dependents.length > 0) {
        notify(t("node.deleteBlocked", { count: dependents.length }), "warning");
        return;
      }
      const lite = workspace.displayed.value.find((node) => node.id === id);
      const label =
        lite === undefined ? id : lite.summary === "" ? t("node.untitled") : lite.summary;
      confirmAction({
        title: t("node.delete"),
        content: t("node.deleteConfirm", { node: label }),
        positiveText: t("node.delete"),
        onConfirm: () => {
          void store
            .remove(id)
            .then(() => notify(t("canvas.nodeDeleted"), "success"))
            .catch(() => notify(t("canvas.deleteFailed"), "error"));
        },
      });
    } catch {
      notify(t("canvas.deleteFailed"), "error");
    }
  }

  return { addGround, deleteNode };
}
