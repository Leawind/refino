import { ref } from "vue";

/**
 * Renderer feedback for the status pill: whether the render budget culled
 * content in the graph host. The host reports each culling state change
 * here — a singleton, like `peekState` — so any status surface can read it
 * without prop drilling through the float manifest.
 */
export const renderCulled = ref(false);
