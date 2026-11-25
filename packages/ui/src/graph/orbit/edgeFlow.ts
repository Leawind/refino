/**
 * Flow material for the orbit grounds edges (ui DESIGN.md, "三维视图"):
 * every edge carries a pulse travelling from its upstream end to its
 * downstream end, so the direction of a lineage is readable from motion
 * instead of arrowheads.
 *
 * The numbers below are the tuning surface: pulse length, pulse speed and
 * the spacing between pulses are world units, the glow strength scales the
 * light (0 leaves the plain line and no pulse at all). Long edges carry
 * several pulses and every edge flows at the same speed, so the effect does
 * not turn into a flicker on short links and a slow crawl on long ones. The
 * edge length is an attribute refreshed with the positions; the only
 * per-frame uniform is the clock.
 */

import { Color, ShaderMaterial } from "three";
import { ADDITIVE_OVER_PAGE } from "./blending";

/** Head-to-tail length of one pulse, in world units. */
export const EDGE_FLOW_LENGTH = 2;
/** Travel speed of a pulse, in world units per second. */
export const EDGE_FLOW_SPEED = 8;
/** Distance between consecutive pulses, in world units. */
export const EDGE_FLOW_SPACING = 2;
/** How loud the flow reads: 0 leaves the plain line without any pulse. */
export const EDGE_FLOW_GLOW = 0.04;
/** Brightness of the plain line under the flow: 0 leaves no base line, only
 * the pulses, and with the glow also 0 the edge disappears. */
export const EDGE_FLOW_BASE = 0.06;
/** Ink palette: how much of the line color the plain line leaves, and how much
 * more the pulse adds. There the line has no light to add; its alpha is the
 * ink, so the pulse reads as a darker pass instead of a brighter one. */
export const EDGE_INK_BASE = 0.5;
export const EDGE_INK_GLOW = 0.45;

const VERTEX_SHADER = /* glsl */ `
attribute float aFlow;
attribute float aEdgeLength;
varying float vFlow;
varying float vEdgeLength;
varying vec3 vColor;

void main() {
  vFlow = aFlow;
  vEdgeLength = aEdgeLength;
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform float uSpeed;
uniform float uSpacing;
uniform float uLength;
uniform vec3 uHighlight;
uniform float uGlow;
uniform float uBase;
uniform float uInk;
varying float vFlow;
varying float vEdgeLength;
varying vec3 vColor;

void main() {
  // Phase runs in world units along the edge, so the pulse keeps its length
  // and speed whatever the edge is.
  float phase = vFlow * vEdgeLength / uSpacing;
  float tail = clamp(uLength / uSpacing, 0.02, 0.98);
  // The light is a soft dash centred on the travelling point: brightest in
  // the middle, fading symmetrically towards both ends.
  float halfLength = 0.5 * tail;
  float offset = abs(fract(uTime * uSpeed / uSpacing - phase + 0.5) - 0.5);
  float pulse = 1.0 - smoothstep(0.0, halfLength, offset);
  if (uInk > 0.5) {
    // Ink leaves alpha instead of adding light: the pulse thickens the line.
    gl_FragColor = vec4(vColor, clamp(uBase + pulse * uGlow, 0.0, 1.0));
  } else {
    // The base line and the glow are separate additive layers: base 0 removes
    // the line but keeps the pulses, glow 0 keeps the line but removes the
    // pulses.
    vec3 color = vColor * uBase;
    color += vColor * pulse * uGlow;
    color += uHighlight * pulse * uGlow * 0.25;
    gl_FragColor = vec4(color, 1.0);
  }
  #include <colorspace_fragment>
}
`;

/** Material shared by every grounds edge of the orbit scene. */
export function createEdgeFlowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: EDGE_FLOW_SPEED },
      uSpacing: { value: EDGE_FLOW_SPACING },
      uLength: { value: EDGE_FLOW_LENGTH },
      uGlow: { value: EDGE_FLOW_GLOW },
      uBase: { value: EDGE_FLOW_BASE },
      uInk: { value: 0 },
      uHighlight: { value: new Color(1, 1, 1) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    ...ADDITIVE_OVER_PAGE,
  });
}

/** Fill the constant `aFlow` attribute: 0 at the upstream end, 1 at the
 * downstream end of every edge. */
export function fillFlowDirections(target: Float32Array): void {
  for (let index = 0; index < target.length; index += 2) {
    target[index] = 0;
    target[index + 1] = 1;
  }
}
