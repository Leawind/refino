/**
 * User-facing settings of the orbit view (ui DESIGN.md, "三维视图"): the
 * brightness of the starfield, the lineage flow, the force simulation and the
 * revolution of the premise satellites. Every value is a multiplier around the
 * tuned baseline — 1 reads as designed — and the limits mark the range in
 * which the picture still holds together. The callout text size is not part of
 * the scene: it scales DOM content only, so it lives here beside its peers
 * rather than in the renderer.
 */

import {
  ORBIT_FORCE_TUNING_DEFAULT,
  ORBIT_FORCE_TUNING_MAX,
  ORBIT_FORCE_TUNING_MIN,
} from "./force";

export interface OrbitSettings {
  /** Light of decisions, premises, their glows and the background starfield. */
  starBrightness: number;
  /** Travel speed of the upstream-to-downstream pulse. */
  flowSpeed: number;
  /** Light of the pulse; 0 leaves the plain line without any flow. */
  flowGlow: number;
  /** Stiffness of the layout springs. */
  spring: number;
  /** Pair repulsion that spreads the decisions and their rings. */
  repulsion: number;
  /** Angular speed of the premise satellites; 0 holds every ring still. */
  revolutionSpeed: number;
}

export interface OrbitSettingLimit {
  min: number;
  max: number;
  step: number;
}

export const ORBIT_SETTINGS_DEFAULT: OrbitSettings = {
  starBrightness: 1,
  flowSpeed: 1,
  flowGlow: 1,
  spring: ORBIT_FORCE_TUNING_DEFAULT.spring,
  repulsion: ORBIT_FORCE_TUNING_DEFAULT.repulsion,
  revolutionSpeed: 1,
};

export const ORBIT_SETTING_LIMITS: Record<keyof OrbitSettings, OrbitSettingLimit> = {
  starBrightness: { min: 0.3, max: 2, step: 0.05 },
  flowSpeed: { min: 0.2, max: 3, step: 0.1 },
  flowGlow: { min: 0, max: 3, step: 0.1 },
  spring: { min: ORBIT_FORCE_TUNING_MIN.spring, max: ORBIT_FORCE_TUNING_MAX.spring, step: 0.1 },
  repulsion: {
    min: ORBIT_FORCE_TUNING_MIN.repulsion,
    max: ORBIT_FORCE_TUNING_MAX.repulsion,
    step: 0.1,
  },
  revolutionSpeed: { min: 0, max: 3, step: 0.1 },
};

/** Font scale of the focused content and the summaries around it. */
export const ORBIT_TEXT_SCALE_DEFAULT = 1;
export const ORBIT_TEXT_SCALE_MIN = 0.7;
export const ORBIT_TEXT_SCALE_MAX = 1.8;

/** One setting clamped into its limit; a non-finite value falls back to the
 * baseline so a corrupted preference never breaks the scene. */
export function clampOrbitSetting(key: keyof OrbitSettings, value: number): number {
  if (!Number.isFinite(value)) return ORBIT_SETTINGS_DEFAULT[key];
  const limit = ORBIT_SETTING_LIMITS[key];
  return Math.min(limit.max, Math.max(limit.min, value));
}

export function clampOrbitTextScale(value: number): number {
  if (!Number.isFinite(value)) return ORBIT_TEXT_SCALE_DEFAULT;
  return Math.min(ORBIT_TEXT_SCALE_MAX, Math.max(ORBIT_TEXT_SCALE_MIN, value));
}
