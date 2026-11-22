import { onBeforeUnmount, watch, type Ref } from "vue";

/**
 * Collapse-on-dismiss behavior shared by the canvas float panels (ui
 * DESIGN.md, "布局"): a pointer press outside the control's root element,
 * or Escape, collapses it. Listeners are installed only while open and
 * always removed on unmount. `onClose` runs on every close-side transition
 * and at unmount-while-open, so idempotent cleanup hooks (e.g. ending a
 * live drag gesture) are safe to pass.
 */

let openPanels = 0;

/** Whether any float panel is open. The shell's Esc handler consults this so
 * that closing a panel does not also clear the selection: Esc peels surfaces
 * one layer at a time. */
export function hasOpenDismissable(): boolean {
  return openPanels > 0;
}

export function useDismissable(
  open: Ref<boolean>,
  root: Ref<HTMLElement | null>,
  onClose?: () => void,
): void {
  /** Any press outside the root collapses the panel. */
  function onDocumentDown(event: MouseEvent): void {
    if (root.value !== null && event.target instanceof Node && !root.value.contains(event.target)) {
      open.value = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") open.value = false;
  }

  let listening = false;

  function attach(): void {
    if (listening) return;
    listening = true;
    openPanels++;
    document.addEventListener("mousedown", onDocumentDown);
    window.addEventListener("keydown", onKeydown);
  }

  function detach(): void {
    if (!listening) return;
    listening = false;
    openPanels--;
    document.removeEventListener("mousedown", onDocumentDown);
    window.removeEventListener("keydown", onKeydown);
  }

  watch(open, (value) => {
    if (value) attach();
    else {
      detach();
      onClose?.();
    }
  });

  onBeforeUnmount(() => {
    detach();
    if (open.value) onClose?.();
  });
}
