<script setup lang="ts">
// Shortcut help overlay (ui DESIGN.md, "交互"): every bound command from
// the shared registry, so the list can never drift from what the keyboard
// actually does. Esc or an outside press closes it.
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { commands, commandLabel } from "../commands";
import { injectRequired } from "../context";
import { injectRequiredNodeOps } from "../nodeOps";
import { closeHelp, helpState } from "../help";
import { storeKey } from "../store";
import { workspaceKey } from "../workspace";
import type { CommandContext } from "../commands";

const store = injectRequired(storeKey, "store");
const workspace = injectRequired(workspaceKey, "workspace");
const nodeOps = injectRequiredNodeOps();
const { t } = useI18n();

const ctx: CommandContext = { store, workspace, nodeOps };

const bound = computed(() => commands.filter((command) => command.bindings !== undefined));

function onKeydown(event: KeyboardEvent): void {
  if (!helpState.open) return;
  if (event.key === "Escape") {
    closeHelp();
    // Registered before the app shell's Esc handler (child before parent):
    // stop here or closing the overlay would also clear the selection.
    event.stopImmediatePropagation();
  }
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="help">
      <div v-if="helpState.open" class="backdrop" @click.self="closeHelp">
        <div class="help" role="dialog" :aria-label="t('help.title')">
          <h3>{{ t("help.title") }}</h3>
          <ul>
            <li v-for="command in bound" :key="command.id">
              <span class="label">{{ commandLabel(command, ctx, t) }}</span>
              <kbd>{{ command.keys }}</kbd>
            </li>
          </ul>
          <p class="hint">{{ t("help.hint") }}</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 200;
  display: grid;
  place-items: center;
}

.help {
  width: min(420px, calc(100vw - 32px));
  max-height: 70vh;
  overflow-y: auto;
  background: var(--refino-surface);
  border: 1px solid var(--refino-border);
  border-radius: var(--refino-radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  padding: 14px 16px;
}

h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 2px;
  font-size: 13px;
}

.label {
  min-width: 0;
}

kbd {
  flex: none;
  font-family: monospace;
  font-size: 12px;
  padding: 1px 7px;
  border: 1px solid var(--refino-border);
  border-radius: 5px;
  background: rgba(128, 128, 128, 0.08);
}

.hint {
  margin: 10px 0 0;
  font-size: 11px;
  opacity: 0.55;
}

.help-enter-active,
.help-leave-active {
  transition: opacity 0.12s ease;
}

.help-enter-from,
.help-leave-to {
  opacity: 0;
}
</style>
