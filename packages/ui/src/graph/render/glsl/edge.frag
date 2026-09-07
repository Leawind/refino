#version 300 es
// Edge program, fragment stage: carves the shaft (round start cap) and the
// arrowhead out of the instanced quad built by edge.vert. Geometry arrives
// in virtual units; only the anti-aliasing feather is screen-space (a fixed
// pixel width divided by the camera scale). The arrow constants are
// duplicated on purpose (GLSL has no cross-file includes);
// test/glsl.test.ts guards the vert/frag interface.

precision highp float;

in vec2 v_frame;
in float v_len;
in float v_half;
in vec4 v_color;
out vec4 outColor;
uniform float u_scale;   // virtual units → CSS px

// Arrowhead geometry in virtual units: length along the segment, half
// width. Must mirror the constants in edge.vert.
const float ARROW_LEN = 9.0;
const float ARROW_HALF_W = 5.0;
// Anti-aliasing feather in CSS px.
const float AA_PX = 0.75;

void main() {
  float aa = AA_PX / u_scale;
  // Shaft with a round start cap, ending where the head begins.
  float shaft = (1.0 - smoothstep(v_half - aa, v_half + aa, abs(v_frame.y)))
              * smoothstep(-v_half - aa, -v_half + aa, v_frame.x)
              * (1.0 - smoothstep(v_len - ARROW_LEN - aa, v_len - ARROW_LEN + aa, v_frame.x));
  // Head: a triangle from the base at half width to the tip on the border
  // of the downstream node (direction ground -> constraint).
  float t = clamp((v_frame.x - (v_len - ARROW_LEN)) / ARROW_LEN, 0.0, 1.0);
  float headHalf = mix(ARROW_HALF_W, 0.0, t);
  float along = v_frame.x - (v_len - ARROW_LEN);
  float head = (1.0 - smoothstep(headHalf - aa, headHalf + aa, abs(v_frame.y)))
             * smoothstep(-aa, aa, along)
             * (1.0 - smoothstep(ARROW_LEN - aa, ARROW_LEN + aa, along));
  // Edges cross each other all the time (multi-ground constraints); plain
  // blending keeps every crossing shaft and arrowhead whole, where a depth
  // test would bite notches out of whatever was drawn first.
  float alpha = max(shaft, head) * v_color.a;
  outColor = vec4(v_color.rgb * alpha, alpha);
}
