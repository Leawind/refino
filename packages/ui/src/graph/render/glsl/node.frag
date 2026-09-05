#version 300 es
// Node program, fragment stage: rounded-rectangle card via an SDF, border
// ring, and the selection badge disc. All geometry is in virtual units —
// border widths and the badge scale with the viewport; only the
// anti-aliasing feather is screen-space (a fixed pixel width divided by the
// camera scale).

precision highp float;

in vec2 v_local;
in vec2 v_size;
in float v_radius;
in float v_borderWidth;
in vec4 v_fill;
in vec4 v_border;
in vec2 v_flags;   // x: badge, y: alpha
uniform vec4 u_primary;
uniform float u_scale;   // virtual units → CSS px
out vec4 outColor;

// Anti-aliasing feather in CSS px.
const float AA_PX = 0.75;

float sdRoundBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + vec2(radius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  float aa = AA_PX / u_scale;
  vec2 halfSize = v_size * 0.5;
  float radius = min(v_radius, min(halfSize.x, halfSize.y));
  // Shrink by half the border width so the border ring centers on the edge.
  float d = sdRoundBox(v_local - halfSize, halfSize - vec2(v_borderWidth * 0.5), radius);
  float fillMask = 1.0 - smoothstep(0.0, aa, d);
  float halfBorder = v_borderWidth * 0.5;
  float borderMask = 1.0 - smoothstep(halfBorder - aa, halfBorder + aa, abs(d));
  vec4 fill = vec4(v_fill.rgb, v_fill.a * fillMask);
  vec4 border = vec4(v_border.rgb, v_border.a * borderMask);
  vec4 color = vec4(
    border.rgb * border.a + fill.rgb * fill.a * (1.0 - border.a),
    border.a + fill.a * (1.0 - border.a)
  );
  if (v_flags.x > 0.5) {
    // Selection badge: a small disc just inside the top-right corner so
    // the quad bounds never clip it into a quarter blob.
    vec2 badgeCenter = vec2(v_size.x - 10.0, 10.0);
    float badge = 1.0 - smoothstep(3.5, 4.5, length(v_local - badgeCenter));
    color = vec4(
      u_primary.rgb * badge + color.rgb * (1.0 - badge),
      badge + color.a * (1.0 - badge)
    );
  }
  float alpha = color.a * v_flags.y;
  outColor = vec4(color.rgb * alpha, alpha);
}
