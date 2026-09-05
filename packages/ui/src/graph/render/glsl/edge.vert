#version 300 es
// Edge program, vertex stage: one instanced quad per edge, x along the
// segment and y across it. Instances are submitted in virtual (layout)
// coordinates; the camera turns them into clip space here, so every
// dimension below — endpoints, widths, arrow constants — scales with the
// viewport like the rest of the canvas content. GLSL has no cross-file
// include mechanism, so the camera foot (toClip) and the arrow constants
// shared with edge.frag are duplicated on purpose; test/glsl.test.ts guards
// the vert/frag interface.

precision highp float;

layout(location = 0) in vec2 a_corner;   // x along, y across
layout(location = 1) in vec2 a_from;     // virtual
layout(location = 2) in vec2 a_to;       // virtual
layout(location = 3) in float a_width;   // virtual units
layout(location = 4) in vec4 a_color;
uniform float u_scale;                   // virtual units → CSS px
uniform vec2 u_offset;                   // camera translation, CSS px
uniform float u_dpr;
uniform vec2 u_resolution;
out vec2 v_frame;   // virtual units along / across the segment, from its start
out float v_len;    // segment length in virtual units
out float v_half;   // shaft half width in virtual units
out vec4 v_color;

// Arrowhead geometry in virtual units: length along the segment, half
// width. Must mirror the constants in edge.frag.
const float ARROW_LEN = 9.0;
const float ARROW_HALF_W = 5.0;

vec2 toClip(vec2 virtualPoint) {
  vec2 px = (virtualPoint * u_scale + u_offset) * u_dpr;
  return vec2((px.x / u_resolution.x) * 2.0 - 1.0, 1.0 - (px.y / u_resolution.y) * 2.0);
}

void main() {
  vec2 dir = a_to - a_from;
  float len = length(dir);
  dir = len > 0.0 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  // The quad also carries the arrowhead, so it is wider and longer than
  // the shaft; the fragment shader carves the actual shape.
  float ext = max(a_width * 0.5, ARROW_HALF_W);
  float along = mix(-a_width * 0.5, len, a_corner.x);
  vec2 p = a_from + dir * along + normal * (a_corner.y * 2.0 * ext);
  gl_Position = vec4(toClip(p), 0.0, 1.0);
  v_frame = vec2(along, a_corner.y * 2.0 * ext);
  v_len = len;
  v_half = a_width * 0.5;
  v_color = a_color;
}
