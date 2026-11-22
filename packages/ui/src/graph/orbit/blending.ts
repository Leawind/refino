/**
 * Blending for the orbit view's additive light (ui DESIGN.md, "三维视图").
 *
 * The orbit canvas is transparent: the deep-space backdrop is the page color
 * behind it. Additive light must therefore add its color without touching the
 * canvas alpha channel — with a written alpha, any dim fragment (a fogged
 * star, the tail of an edge pulse, a halo's fade) composites as an opaque
 * dark pixel and reads as a black spot over the backdrop.
 */

import { AddEquation, CustomBlending, OneFactor, SrcAlphaFactor, ZeroFactor } from "three";

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
