/**
 * Blending for the orbit view's marks (ui DESIGN.md, "三维视图").
 *
 * Over the dark page the canvas is transparent and the marks are light: they
 * add their color without touching the canvas alpha — with a written alpha,
 * any dim fragment (a fogged star, the tail of an edge pulse, a halo's fade)
 * composites as an opaque dark pixel and reads as a black spot over the
 * backdrop.
 *
 * Over paper the palette is ink, and ink is drawn the other way round: the
 * canvas paints its own paper background and the marks composite over it with
 * plain alpha, so their own alpha is exactly how much ink they leave.
 */

import {
  AddEquation,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  ZeroFactor,
} from "three";
import type { Material } from "three";

export const ADDITIVE_OVER_PAGE = {
  blending: CustomBlending,
  blendSrc: SrcAlphaFactor,
  blendDst: OneFactor,
  blendEquation: AddEquation,
  // Leave the destination alpha as it is.
  blendSrcAlpha: ZeroFactor,
  blendDstAlpha: OneFactor,
  blendEquationAlpha: AddEquation,
} as const;

/** Alpha compositing, spelled out because a material may arrive here with the
 * additive factors already applied. */
const ALPHA_OVER_PAGE = {
  blending: CustomBlending,
  blendSrc: SrcAlphaFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendEquation: AddEquation,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor,
  blendEquationAlpha: AddEquation,
} as const;

/** Blend one mark for the current palette: light over the dark page, ink over
 * paper. */
export function applyOrbitBlending(material: Material, ink: boolean): void {
  Object.assign(material, ink ? ALPHA_OVER_PAGE : ADDITIVE_OVER_PAGE);
}
