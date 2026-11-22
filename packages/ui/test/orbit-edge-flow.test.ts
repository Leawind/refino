import { describe, expect, it } from "vitest";
import { OneFactor, ZeroFactor } from "three";
import { ADDITIVE_OVER_PAGE } from "../src/graph/orbit/blending";
import {
  createEdgeFlowMaterial,
  EDGE_FLOW_BASE,
  EDGE_FLOW_GLOW,
  EDGE_FLOW_LENGTH,
  EDGE_FLOW_SPACING,
  EDGE_FLOW_SPEED,
  fillFlowDirections,
} from "../src/graph/orbit/edgeFlow";

/**
 * Edge flow (ui DESIGN.md, "三维视图"): the pulse of every grounds edge
 * travels from its upstream end to its downstream end, so the flow attribute
 * and the material clock are the direction contract.
 */

describe("orbit edge flow", () => {
  it("orients the flow attribute from upstream to downstream", () => {
    const values = new Float32Array(6);
    fillFlowDirections(values);
    expect([...values]).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("leaves the backdrop alpha untouched", () => {
    // Writing alpha would composite dim light as an opaque black spot over
    // the page backdrop.
    expect(ADDITIVE_OVER_PAGE.blendSrcAlpha).toBe(ZeroFactor);
    expect(ADDITIVE_OVER_PAGE.blendDstAlpha).toBe(OneFactor);
  });

  it("carries the clock and the pulse spacing", () => {
    const material = createEdgeFlowMaterial();
    expect(material.uniforms.uTime).toBeDefined();
    expect(material.uniforms.uLength!.value).toBe(EDGE_FLOW_LENGTH);
    expect(material.uniforms.uSpeed!.value).toBe(EDGE_FLOW_SPEED);
    expect(material.uniforms.uSpacing!.value).toBe(EDGE_FLOW_SPACING);
    // 0 is the documented "no glow" value, so the uniform must track it.
    expect(material.uniforms.uGlow!.value).toBe(EDGE_FLOW_GLOW);
    expect(material.uniforms.uBase!.value).toBe(EDGE_FLOW_BASE);
    material.dispose();
  });
});
