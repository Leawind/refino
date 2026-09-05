#version 300 es
// Text program, fragment stage: alpha-mask the glyph atlas texel with the
// instance alpha, tinted by the label color.

precision highp float;

in vec2 v_uv;
in float v_alpha;
uniform sampler2D u_atlas;
uniform vec4 u_color;
out vec4 outColor;

void main() {
  float a = texture(u_atlas, v_uv).a * v_alpha;
  outColor = vec4(u_color.rgb * a, a);
}
