import { onBeforeUnmount, onMounted, type Ref } from "vue";

/**
 * Escape closes a naive dropdown even though focus stays on its trigger. The
 * key is consumed while the menu is open, so the shell peels this layer first
 * instead of skipping straight to clearing the selection.
 */
export function useMenuEscape(open: Ref<boolean>): void {
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !open.value) return;
    open.value = false;
    event.stopPropagation();
  }

  onMounted(() => window.addEventListener("keydown", onKeydown, true));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown, true));
}
