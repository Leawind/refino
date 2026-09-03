// Type shim for marked-katex-extension. The real package ships raw .ts that
// does not compile under the repo's strict settings, so tsconfig paths map
// imports here for type checking; the bundler still uses the real package.
import type { MarkedExtension } from "marked";

export default function markedKatex(options?: {
  throwOnError?: boolean;
  /** Treat single-dollar $...$ as inline math (marked-katex: nonStandard). */
  nonStandard?: boolean;
}): MarkedExtension;
