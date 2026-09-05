#version 300 es
// Text program, vertex stage: one instanced quad per glyph, textured from
// the label atlas. GLSL has no cross-file include mechanism, so the camera
// foot (toClip) is duplicated across the vertex stages on purpose;
// test/glsl.test.ts guards the vert/frag interface.

precision highp float;

layout(location = 0) in vec2 a_corner;   // unit square
layout(location = 1) in vec2 a_pos;      // bitmap top-left, css px
layout(location = 2) in vec2 a_size;     // bitmap size, css px
layout(location = 3) in vec2 a_uv;
layout(location = 4) in vec2 a_uvSize;
layout(location = 5) in float a_alpha;
uniform vec2 u_resolution;
uniform float u_dpr;
out vec2 v_uv;
out float v_alpha;

vec2 toClip(vec2 cssPoint) {
  vec2 px = cssPoint * u_dpr;
  return vec2((px.x / u_resolution.x) * 2.0 - 1.0, 1.0 - (px.y / u_resolution.y) * 2.0);
}

void main() {
  vec2 p = a_pos + a_corner * a_size;
  gl_Position = vec4(toClip(p), 0.0, 1.0);
  v_uv = a_uv + a_corner * a_uvSize;
  v_alpha = a_alpha;
}
