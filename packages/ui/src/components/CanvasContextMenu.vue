<script setup lang="ts">
// Canvas context menu (ui DESIGN.md, "交互"): right-click on a node offers
// per-node actions, right-click on empty space offers creation and view
// actions. Opens at the pointer, keyboard-navigable, closes on an outside
// press or Esc (its Esc handler sits on the window capture phase so it runs
// ahead of the app shell's clear-selection listener).
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { injectRequired } from "../context";
import { injectRequiredNodeOps } from "../nodeOps";
import { viewportBridge } from "../viewportBridge";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";

const props = defineProps<{ x: number; y: number; nodeId: string | null }>();
const emit = defineEmits<{ close: [] }>();

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const nodeOps = injectRequiredNodeOps();
const { t } = useI18n();

interface MenuItem {
  key: string;
  label: string;
  run(): void;
  danger?: boolean;
}

const items = computed<MenuItem[]>(() => {
  const id = props.nodeId;
  if (id !== null) {
    return [
      { key: "open", label: t("node.edit"), run: () => store.openDetail(id) },
      { key: "locate", label: t("selection.locate"), run: () => workspace.locate(id) },
      {
        key: "toggle",
        label: t("selection.toggle"),
        run: () => {
          const lite = workspace.displayed.value.find((node) => node.id === id);
          if (lite !== undefined) workspace.toggle(lite);
        },
      },
      {
        // Creation always runs through the full editor; the menu only
        // stages it with this node pre-filled as the ground.
        key: "refine",
        label: t("canvas.refineThis"),
        run: () => store.startCreate("decision", { grounds: [id] }),
      },
      {
        key: "delete",
        label: t("node.delete"),
        danger: true,
        run: () => void nodeOps.deleteNode(id),
      },
    ];
  }
  return [
    {
      key: "new-decision",
      label: t("node.createDecision"),
      run: () => store.startCreate("decision"),
    },
    { key: "new-premise", label: t("node.createPremise"), run: () => store.startCreate("premise") },
    { key: "fit", label: t("app.fitView"), run: () => viewportBridge.commands?.fitView() },
  ];
});

const active = ref(0);
const rootEl = ref<HTMLElement | null>(null);

function runItem(item: MenuItem): void {
  emit("close");
  item.run();
}

/** Keep the menu inside the viewport. */
const style = computed(() => {
  const width = 176;
  const height = items.value.length * 30 + 12;
  const x = Math.max(8, Math.min(props.x, window.innerWidth - width - 8));
  const y = Math.max(8, Math.min(props.y, window.innerHeight - height - 8));
  return { left: `${x}px`, top: `${y}px` };
});

function onOutsideDown(event: MouseEvent): void {
  if (rootEl.value !== null && !rootEl.value.contains(event.target as Node)) emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    emit("close");
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    active.value = Math.min(active.value + 1, items.value.length - 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    active.value = Math.max(active.value - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const item = items.value[active.value];
    if (item !== undefined) runItem(item);
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onOutsideDown);
  // Capture phase: ahead of every bubble listener (the app shell's Esc
  // clear-selection included), which a late-mounted menu cannot outrun.
  window.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onOutsideDown);
  window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <Teleport to="body">
    <div ref="rootEl" class="menu" :style="style" role="menu">
      <button
        v-for="(item, index) in items"
        :key="item.key"
        class="item"
        :class="{ active: index === active, danger: item.danger }"
        role="menuitem"
        type="button"
        @click="runItem(item)"
        @mousemove="active = index"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.menu {
  position: fixed;
  min-width: 176px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  z-index: 300;
}

.item {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.item.active {
  background: rgba(24, 160, 88, 0.14);
}

.item.danger {
  color: #d03050;
}
</style>
