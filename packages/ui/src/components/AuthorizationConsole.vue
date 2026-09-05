<script setup lang="ts">
// Authorization console (docs/design.md, "用户侧：授权控制台"): one
// interaction for signing the task's authorization context — anchors plus
// the frozen-zone declarations — with the frozen-zone propagation, the
// injection preview and its size estimate visible before signing. The same
// component serves signing, mid-task adjustment and escalation adjudication.
// The host provides the ConsoleClient; the canvas pick-mode overlay remains
// the host's integration surface.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { NAlert, NButton, NInput, NSelect, NTag } from "naive-ui";
import { buildGraph } from "refino";
import type { Graph, RefinoNode } from "refino";
import {
  estimateContext,
  frozenFrontier,
  frozenZone,
  renderContext,
  validateContext,
  HarnessError,
  type AuthorizationContext,
} from "@refino/harness";
import type { ConsoleClient, ConsoleNode } from "../console";

const props = defineProps<{ client: ConsoleClient }>();

const emit = defineEmits<{ signed: [context: AuthorizationContext] }>();

const { t } = useI18n();

const graph = ref<Graph | null>(null);
const effective = ref<AuthorizationContext | null>(null);
const error = ref<string | null>(null);
const signing = ref(false);

const anchors = ref<string[]>([]);
const frozen = ref<string[]>([]);

const draft = computed<AuthorizationContext>(() => ({
  anchors: [...anchors.value],
  frozen: [...frozen.value],
}));

const zone = computed(() => {
  if (graph.value === null) return [];
  try {
    return frozenZone(graph.value, draft.value);
  } catch {
    return []; // an invalid draft (e.g. mid-edit) renders as empty, not broken
  }
});
const zoneConstraints = computed(() => zone.value.filter((node) => node.type === "constraint"));
const zonePremises = computed(() => zone.value.filter((node) => node.type === "premise"));
const frontier = computed(() => {
  if (graph.value === null) return [];
  try {
    return frozenFrontier(graph.value, draft.value);
  } catch {
    return [];
  }
});

/** The zone of the currently effective context, for the newly-frozen diff. */
const effectiveZone = computed(() => {
  if (graph.value === null || effective.value === null) return [];
  try {
    return frozenZone(graph.value, effective.value).map((node) => node.id);
  } catch {
    return []; // the effective context may reference nodes the draft graph lost
  }
});
const newlyFrozen = computed(() => {
  const effectiveIds = new Set(effectiveZone.value);
  return zoneConstraints.value.filter((node) => !effectiveIds.has(node.id));
});

const estimate = computed(() =>
  graph.value === null ? { blocks: 0, chars: 0 } : estimateContext(graph.value, draft.value),
);

const preview = computed(() => {
  if (graph.value === null) return "";
  try {
    return renderContext(graph.value, draft.value);
  } catch {
    return "";
  }
});

const nodeOptions = computed(() =>
  [...(graph.value?.nodes.values() ?? [])].map((node) => ({
    label: `${node.id} ${node.summary === "" ? t("node.untitled") : node.summary}`,
    value: node.id,
  })),
);

const frozenOptions = computed(() => {
  // Premises are never frozen directly — they join the zone as ancestors
  // (docs/crg.md 2.4) — so only constraints are offered.
  const options = new Map(
    nodeOptions.value
      .filter((option) => graph.value?.nodes.get(option.value)?.type === "constraint")
      .map((option) => [option.value, option]),
  );
  for (const id of frozen.value) {
    if (!options.has(id)) options.set(id, { label: id, value: id });
  }
  return [...options.values()];
});

const anchorOptions = computed(() => {
  const options = new Map(nodeOptions.value.map((option) => [option.value, option]));
  for (const id of anchors.value) {
    if (!options.has(id)) options.set(id, { label: id, value: id });
  }
  return [...options.values()];
});

function toRefinoNode(node: ConsoleNode): RefinoNode {
  const base = { id: node.id, summary: node.summary, body: "" };
  return node.type === "premise"
    ? { ...base, type: "premise" }
    : { ...base, type: "constraint", grounds: node.grounds ?? [] };
}

onMounted(async () => {
  const [nodes, context] = await Promise.all([
    props.client.fetchGraph(),
    props.client.fetchContext(),
  ]);
  graph.value = buildGraph(nodes.map(toRefinoNode));
  if (context !== null) {
    effective.value = context;
    anchors.value = [...context.anchors];
    frozen.value = [...context.frozen];
  }
});

async function sign(): Promise<void> {
  if (graph.value === null) return;
  error.value = null;
  try {
    // The engine/harness validation is the console's own feedback; the host
    // revalidates before deriving the delta (docs/design.md).
    validateContext(graph.value, draft.value);
  } catch (e) {
    error.value = e instanceof HarnessError ? e.message : String(e);
    return;
  }
  signing.value = true;
  try {
    await props.client.sign(draft.value);
    effective.value = draft.value;
    emit("signed", draft.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    signing.value = false;
  }
}

function optionLabel(id: string): string {
  const node = graph.value?.nodes.get(id);
  if (node === undefined) return id;
  return node.summary === "" ? id : `${id} ${node.summary}`;
}
</script>

<template>
  <section class="console">
    <h2>{{ t("console.title") }}</h2>

    <NAlert v-if="error !== null" type="error" :show-icon="true" closable @close="error = null">
      {{ error }}
    </NAlert>

    <div class="field">
      <span class="label">{{ t("console.anchors") }}</span>
      <NSelect
        v-model:value="anchors"
        multiple
        filterable
        clearable
        :options="anchorOptions"
        :placeholder="t('console.anchorsPlaceholder')"
      />
    </div>

    <div class="field">
      <span class="label">{{ t("console.frozen") }}</span>
      <NSelect
        v-model:value="frozen"
        multiple
        filterable
        clearable
        :options="frozenOptions"
        :placeholder="t('console.frozenPlaceholder')"
      />
      <p class="propagation">
        {{
          t("console.propagation", {
            constraints: zoneConstraints.length,
            premises: zonePremises.length,
          })
        }}
        <template v-if="newlyFrozen.length > 0">
          ·
          {{ t("console.newlyFrozen", { count: newlyFrozen.length }) }}
          {{ newlyFrozen.map((node) => node.id).join(", ") }}
        </template>
      </p>
    </div>

    <div class="field">
      <span class="label">{{ t("console.frontier") }}</span>
      <div class="frontier">
        <NTag v-for="node in frontier" :key="node.id" size="small" :bordered="false">
          🔒 {{ optionLabel(node.id) }}
        </NTag>
        <span v-if="frontier.length === 0" class="none">{{ t("console.noFrozen") }}</span>
      </div>
    </div>

    <div class="field">
      <span class="label">
        {{ t("console.preview") }} ·
        {{ t("console.estimate", { blocks: estimate.blocks, chars: estimate.chars }) }}
      </span>
      <details class="preview">
        <summary>{{ t("console.previewToggle") }}</summary>
        <NInput
          :value="preview"
          type="textarea"
          readonly
          :autosize="{ minRows: 4, maxRows: 14 }"
          class="preview-text"
        />
      </details>
    </div>

    <div class="actions">
      <NButton type="primary" :loading="signing" @click="sign">
        {{ t("console.sign") }}
      </NButton>
    </div>
  </section>
</template>

<style scoped>
.console {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

h2 {
  margin: 0;
  font-size: 15px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label {
  font-size: 12px;
  opacity: 0.65;
}

.propagation {
  margin: 2px 0 0;
  font-size: 12px;
  opacity: 0.7;
  word-break: break-all;
}

.frontier {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.none {
  font-size: 12px;
  opacity: 0.5;
}

.preview summary {
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}

.preview-text {
  margin-top: 6px;
  font-family: monospace;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
</style>
