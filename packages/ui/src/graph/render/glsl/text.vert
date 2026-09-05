#version 300 es
// Text program, vertex stage: one instanced quad per glyph, textured from
// the label atlas. Instances are submitted in virtual (layout) coordinates;
// the camera turns them into clip space here, so labels scale with the
// viewport like the rest of the canvas content. GLSL has no cross-file
// include mechanism, so the camera foot (toClip) is duplicated across the
// vertex stages on purpose; test/glsl.test.ts guards the vert/frag
// interface.

precision highp float;

layout(location = 0) in vec2 a_corner;   // unit square
layout(location = 1) in vec2 a_pos;      // bitmap top-left, virtual units
layout(location = 2) in vec2 a_size;     // bitmap size, virtual units
layout(location = 3) in vec2 a_uv;
layout(location = 4) in vec2 a_uvSize;
layout(location = 5) in float a_alpha;
uniform float u_scale;                   // virtual units → CSS px
uniform vec2 u_offset;                   // camera translation, CSS px
uniform float u_dpr;
uniform vec2 u_resolution;
out vec2 v_uv;
out float v_alpha;

vec2 toClip(vec2 virtualPoint) {
  vec2 px = (virtualPoint * u_scale + u_offset) * u_dpr;
  return vec2((px.x / u_resolution.x) * 2.0 - 1.0, 1.0 - (px.y / u_resolution.y) * 2.0);
}

void main() {
  vec2 p = a_pos + a_corner * a_size;
  gl_Position = vec4(toClip(p), 0.0, 1.0);
  v_uv = a_uv + a_corner * a_uvSize;
  v_alpha = a_alpha;
}
