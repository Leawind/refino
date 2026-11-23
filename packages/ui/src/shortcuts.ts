import { commands, matchBinding, type CommandContext } from "./commands";
import { isTextEntry } from "./peek";
import { paletteState } from "./palette";

/**
 * Global shortcut dispatch (ui DESIGN.md, "交互"): one document-level
 * keydown listener walks the command registry and runs the first command
 * whose binding matches. Stand-down rules keep the keyboard layered:
 *
 * - text entry surfaces are skipped (shared with the Alt-peek tracking);
 * - the open palette owns the keyboard (its own document handler navigates
 *   and closes it);
 * - the open detail editor owns the keyboard (its fields and its Esc chain
 *   must not race a global command).
 *
 * Esc is deliberately not a command: its layering (modal → palette → float
 * panels → clear selection) is handled by the surfaces' own listeners.
 */
export function installShortcuts(ctx: CommandContext): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.altKey || paletteState.open || ctx.store.state.editorOpen) return;
    if (isTextEntry(event.target)) return;
    for (const command of commands) {
      if (command.bindings === undefined) continue;
      for (const binding of command.bindings) {
        if (!matchBinding(event, binding)) continue;
        event.preventDefault();
        command.run(ctx);
        return;
      }
    }
  };
  document.addEventListener("keydown", onKeydown);
  return () => document.removeEventListener("keydown", onKeydown);
}
