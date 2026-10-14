import { reactive } from "vue";

/**
 * Shortcut-help overlay open state: a module singleton like `palette.ts`,
 * so the "?" binding, the palette action and the overlay itself all drive
 * one piece of state.
 */
export const helpState = reactive({ open: false });

export function toggleHelp(): void {
  helpState.open = !helpState.open;
}

export function closeHelp(): void {
  helpState.open = false;
}
