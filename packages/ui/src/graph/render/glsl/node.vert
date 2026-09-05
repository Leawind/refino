#version 300 es
// Node program, vertex stage: one instanced quad per node card. GLSL has no
// cross-file include mechanism, so the camera foot (toClip) is duplicated
// across the vertex stages on purpose; test/glsl.test.ts guards the
// vert/frag interface.

precision highp float;

layout(location = 0) in vec2 a_corner;   // unit square
layout(location = 1) in vec2 a_pos;      // center, css px
layout(location = 2) in vec2 a_size;     // css px
layout(location = 3) in float a_radius;
layout(location = 4) in float a_borderWidth;
layout(location = 5) in vec4 a_fill;
layout(location = 6) in vec4 a_border;
layout(location = 7) in vec2 a_flags;    // x: badge, y: alpha
uniform vec2 u_resolution;
uniform float u_dpr;
out vec2 v_local;
out vec2 v_size;
out float v_radius;
out float v_borderWidth;
out vec4 v_fill;
out vec4 v_border;
out vec2 v_flags;

vec2 toClip(vec2 cssPoint) {
  vec2 px = cssPoint * u_dpr;
  return vec2((px.x / u_resolution.x) * 2.0 - 1.0, 1.0 - (px.y / u_resolution.y) * 2.0);
}

void main() {
  vec2 p = a_pos + (a_corner - 0.5) * a_size;
  gl_Position = vec4(toClip(p), 0.0, 1.0);
  v_local = a_corner * a_size;
  v_size = a_size;
  v_radius = a_radius;
  v_borderWidth = a_borderWidth;
  v_fill = a_fill;
  v_border = a_border;
  v_flags = a_flags;
}
