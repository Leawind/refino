#version 300 es
// Edge program, fragment stage: carves the shaft (round start cap) and the
// arrowhead out of the instanced quad built by edge.vert. The arrow constants
// and the camera foot are duplicated on purpose (GLSL has no cross-file
// includes); test/glsl.test.ts guards the vert/frag interface.

precision mediump float;

in vec2 v_frame;
in float v_len;
in float v_half;
in vec4 v_color;
out vec4 outColor;

// Arrowhead geometry in CSS px: length along the segment, half width.
// Must mirror the constants in edge.vert.
const float ARROW_LEN = 9.0;
const float ARROW_HALF_W = 5.0;

void main() {
  float aa = 0.75;
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
  float alpha = max(shaft, head) * v_color.a;
  outColor = vec4(v_color.rgb * alpha, alpha);
}
