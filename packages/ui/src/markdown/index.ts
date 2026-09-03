import katexCss from "katex/dist/katex.min.css?inline";

/**
 * Client-side markdown rendering for the preview. Sync pipeline: marked with
 * the KaTeX extension ($...$ / $$...$$) plus a renderer that turns
 * ```mermaid fences into placeholder divs.
 */

import { Marked } from "marked";
import markedKatex from "marked-katex-extension";

const marked = new Marked();
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));
marked.use({
  renderer: {
    code(token) {
      if (token.lang !== "mermaid") {
        // Fall through to the default renderer.
        return false;
      }
      return `<div class="mermaid">${escapeHtml(token.text)}</div>`;
    },
  },
});

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Parse markdown into HTML (KaTeX already rendered, mermaid placeholders). */
export function renderMarkdown(source: string): string {
  return marked.parse(source) as string;
}

type Mermaid = (typeof import("mermaid"))["default"];
let mermaidPromise: Promise<Mermaid> | null = null;
let initializedTheme: "default" | "dark" | null = null;

async function loadMermaid(theme: "default" | "dark"): Promise<Mermaid> {
  if (mermaidPromise === null) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, theme });
    initializedTheme = theme;
  }
  return mermaid;
}

/**
 * Replace `.mermaid` placeholder divs inside `root` with rendered diagrams.
 * Mermaid is loaded on demand and only when such placeholders exist.
 * Diagram source is kept in a data attribute so a theme switch can
 * re-render; syntax errors leave the source visible.
 */
export async function renderMermaidDiagrams(
  root: HTMLElement,
  theme: "light" | "dark",
): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>(".mermaid")];
  if (nodes.length === 0) return;

  // KaTeX ships its styles as a css file that must be on the page; mermaid
  // injects its own styles when rendering.
  injectStylesOnce();

  const mermaid = await loadMermaid(theme === "dark" ? "dark" : "default");
  for (const node of nodes) {
    if (node.dataset.original === undefined) {
      node.dataset.original = node.textContent ?? "";
    } else {
      // Restore the source so a theme switch can re-render.
      node.textContent = node.dataset.original;
      delete node.dataset.processed;
    }
  }
  try {
    await mermaid.run({ nodes });
  } catch {
    // Keep the raw source visible on diagram errors.
  }
}

let stylesInjected = false;

function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  for (const css of [katexCss]) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }
}
