// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

describe("markdown rendering", () => {
  it("renders plain markdown", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
  });

  it("renders inline and block LaTeX via KaTeX", () => {
    const html = renderMarkdown("Energy: $E=mc^2$\n\n$$\\int_0^1 x\\,dx$$");
    expect(html).toContain("katex");
  });

  it("turns mermaid fences into placeholder divs with escaped source", () => {
    const html = renderMarkdown('```mermaid\ngraph TD\nA["<b>"] --> B\n```');
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("leaves ordinary code fences to the default renderer", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("language-ts");
  });
});
