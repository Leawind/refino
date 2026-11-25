import type { RGBA } from "../render/renderer";

/**
 * Palette of the orbit view. There are two of them (ui DESIGN.md, "三维视图"):
 * the deep-space night sky the dark theme was designed in, and a paper chart
 * with ink marks for the light one. The kinds of mark keep their meaning in
 * both — red virtual root, blue decisions that deepen with distance, premise
 * satellites in the tone opposite to the page — but the light palette cannot
 * keep the white premises of the dark one: white on paper is no mark at all,
 * so premises turn into charcoal ink and the palette is inverted as a whole.
 *
 * `ink` says which way the canvas is lit: dark palettes add light to a
 * transparent canvas over the dark page, light palettes composite ink alpha
 * onto a paper background drawn inside the canvas.
 */
export interface OrbitTheme {
  ink: boolean;
  background: RGBA;
  /** CSS color of the pane behind the canvas; matches `background`. */
  backgroundCss: string;
  /** Shallow decisions. */
  star: RGBA;
  /** Deep decisions drift towards this blue. */
  deepStar: RGBA;
  /** Premise satellites: small marks, opposite in tone to the page. */
  premise: RGBA;
  edge: RGBA;
  /** The display-only virtual root: red, so it can never be mistaken for a node. */
  root: RGBA;
  highlight: RGBA;
  /** Fixed background dust of the canvas. */
  sky: RGBA;
  /** Baseline strength of the light layers; the brightness setting scales
   * them. `track` is the focused system's orbit ring. */
  opacity: {
    star: number;
    glow: number;
    satellite: number;
    selection: number;
    hover: number;
    sky: number;
    track: number;
  };
  /** Callout typography, as CSS colors (the overlay is DOM, not WebGL). */
  text: string;
  /** Premise summary labels: a step quieter than the focused content. */
  label: string;
  textSoft: string;
  accent: string;
  /** Tinted fills of the body (code blocks, quotes, table borders). */
  fill: string;
  line: string;
  /** Leader, rule and the elbow between them. */
  leader: string;
  textShadow: string;
}

export const ORBIT_THEME: OrbitTheme = {
  ink: false,
  background: [0.016, 0.024, 0.05, 1],
  backgroundCss: "#05070f",
  star: [0.68, 0.83, 1, 1],
  deepStar: [0.2, 0.38, 1, 1],
  premise: [1, 1, 1, 1],
  edge: [0.2, 0.36, 0.72, 1],
  root: [1, 0.28, 0.25, 1],
  highlight: [0.5, 0.9, 1, 1],
  sky: [0.72, 0.84, 1, 1],
  opacity: {
    star: 1,
    glow: 0.12,
    satellite: 0.92,
    selection: 0.7,
    hover: 0.45,
    sky: 0.6,
    track: 0.12,
  },
  text: "rgba(232, 242, 255, 0.96)",
  label: "rgba(214, 232, 255, 0.82)",
  textSoft: "rgba(202, 218, 242, 0.86)",
  accent: "#9ec8ff",
  fill: "rgba(122, 162, 232, 0.1)",
  line: "rgba(146, 186, 255, 0.16)",
  leader: "rgb(146, 186, 255)",
  textShadow: "0 1px 5px rgba(0, 0, 0, 0.78)",
};

export const ORBIT_PAPER_THEME: OrbitTheme = {
  ink: true,
  background: [0.965, 0.957, 0.937, 1],
  backgroundCss: "#f6f4ef",
  star: [0.24, 0.46, 0.82, 1],
  deepStar: [0.09, 0.19, 0.48, 1],
  premise: [0.16, 0.18, 0.22, 1],
  edge: [0.22, 0.3, 0.44, 1],
  root: [0.8, 0.2, 0.18, 1],
  highlight: [0.06, 0.32, 0.72, 1],
  sky: [0.35, 0.4, 0.5, 1],
  opacity: {
    star: 1,
    glow: 0.14,
    satellite: 0.92,
    selection: 0.5,
    hover: 0.34,
    sky: 0.22,
    track: 0.1,
  },
  text: "rgba(28, 34, 46, 0.92)",
  label: "rgba(40, 48, 64, 0.86)",
  textSoft: "rgba(48, 56, 72, 0.86)",
  accent: "#1d5fa8",
  fill: "rgba(40, 80, 150, 0.07)",
  line: "rgba(40, 80, 150, 0.18)",
  leader: "rgb(52, 88, 148)",
  textShadow: "0 1px 4px rgba(255, 255, 255, 0.8)",
};

/** The palette the UI theme asks for. */
export function orbitThemeFor(mode: "light" | "dark"): OrbitTheme {
  return mode === "light" ? ORBIT_PAPER_THEME : ORBIT_THEME;
}
