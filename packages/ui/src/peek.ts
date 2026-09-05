import { reactive } from "vue";

/**
 * Alt-peek state (README, "交互"): holding Alt while hovering any node
 * surface shows a read-only floating preview card. The state is a singleton
 * reactive — one peek at a time, fed by every node surface (canvas, explorer
 * rows, selection list). The card itself is non-interactive
 * (`pointer-events: none`): the peek only answers "what is this node";
 * interaction belongs to selection and the editor.
 */

export interface PeekState {
  /** The hovered node id, or null when nothing qualifies. */
  id: string | null;
  /** Cursor position (viewport coordinates) the card anchors to. */
  x: number;
  y: number;
  /** Whether Alt is currently held outside text inputs. */
  alt: boolean;
}

export const peekState = reactive<PeekState>({ id: null, x: 0, y: 0, alt: false });

/** Feed one hover move; coordinates are the pointer's viewport position. */
export function peekMove(id: string, x: number, y: number): void {
  peekState.id = id;
  peekState.x = x;
  peekState.y = y;
}

export function peekHide(id?: string): void {
  if (id === undefined || peekState.id === id) peekState.id = null;
}

/**
 * Global Alt tracking. Installs window-level key listeners; returns the
 * cleanup function. Alt keydowns are prevented outside text entry surfaces
 * so the browser menu bar does not steal the modifier (Windows/Firefox);
 * Alt+Tab and friends are OS-level and unaffected. Typing with Option on
 * macOS is untouched because inputs are skipped.
 */
export function installAltTracking(): () => void {
  const isTextEntry = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable ||
      target.closest("input, textarea, [contenteditable]") !== null);

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Alt") return;
    if (isTextEntry(event.target)) return;
    event.preventDefault();
    peekState.alt = true;
  };
  const onKeyup = (event: KeyboardEvent): void => {
    if (event.key !== "Alt") return;
    peekState.alt = false;
  };
  const onBlur = (): void => {
    // Window focus loss can swallow the keyup; never stick the peek on.
    peekState.alt = false;
  };
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("keyup", onKeyup, true);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("keyup", onKeyup, true);
    window.removeEventListener("blur", onBlur);
  };
}
