import type { RGBA } from "../render/renderer";

/** Palette of the orbit view: a fixed deep-space scene, independent of the
 * surrounding UI theme. Stars read best against darkness, so the canvas is
 * always a small planetarium. */
export interface OrbitTheme {
  background: RGBA;
  /** Shallow decisions: cold white. */
  star: RGBA;
  /** Deep decisions drift towards this blue. */
  deepStar: RGBA;
  /** Premise satellites: deliberately much dimmer than a decision. */
  premise: RGBA;
  edge: RGBA;
  root: RGBA;
  highlight: RGBA;
}

export const ORBIT_THEME: OrbitTheme = {
  background: [0.016, 0.024, 0.05, 1],
  star: [0.9, 0.95, 1, 1],
  deepStar: [0.24, 0.42, 1, 1],
  premise: [0.44, 0.52, 0.72, 1],
  edge: [0.2, 0.36, 0.72, 1],
  root: [1, 1, 1, 1],
  highlight: [0.5, 0.9, 1, 1],
};
