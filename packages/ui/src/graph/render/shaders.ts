/**
 * WebGL2 programs for the canvas renderer: instanced quads for edges and
 * nodes, instanced glyph quads for labels. All colors are straight alpha
 * in RGBA; fragments are emitted premultiplied so the default canvas
 * compositing (premultipliedAlpha: true) stays correct.
 */

/** Edge quad: x along the segment, y across it (two triangles). */
export const EDGE_QUAD = new Float32Array([0, -0.5, 1, -0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1, -0.5]);

/** Unit square for nodes and glyphs (two triangles covering it exactly). */
export const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

const COMMON_VERTEX_FOOT = /* glsl */ `
  vec2 toClip(vec2 cssPoint) {
    vec2 px = cssPoint * u_dpr;
    return vec2((px.x / u_resolution.x) * 2.0 - 1.0, 1.0 - (px.y / u_resolution.y) * 2.0);
  }
`;

const EDGE_VERTEX = /* glsl */ `#version 300 es
  precision highp float;
  layout(location = 0) in vec2 a_corner;   // x along, y across
  layout(location = 1) in vec2 a_from;
  layout(location = 2) in vec2 a_to;
  layout(location = 3) in float a_width;
  layout(location = 4) in vec4 a_color;
  uniform vec2 u_resolution;
  uniform float u_dpr;
  out vec4 v_color;
  ${COMMON_VERTEX_FOOT}
  void main() {
    vec2 dir = a_to - a_from;
    float len = length(dir);
    dir = len > 0.0 ? dir / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    vec2 p = a_from - dir * a_width * 0.5
           + dir * (len + a_width) * a_corner.x
           + normal * (a_width * a_corner.y);
    gl_Position = vec4(toClip(p), 0.0, 1.0);
    v_color = a_color;
  }
`;

const EDGE_FRAGMENT = /* glsl */ `#version 300 es
  precision mediump float;
  in vec4 v_color;
  out vec4 outColor;
  void main() {
    outColor = vec4(v_color.rgb * v_color.a, v_color.a);
  }
`;

const NODE_VERTEX = /* glsl */ `#version 300 es
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
  ${COMMON_VERTEX_FOOT}
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
`;

const NODE_FRAGMENT = /* glsl */ `#version 300 es
  precision mediump float;
  in vec2 v_local;
  in vec2 v_size;
  in float v_radius;
  in float v_borderWidth;
  in vec4 v_fill;
  in vec4 v_border;
  in vec2 v_flags;   // x: badge, y: alpha
  uniform vec4 u_primary;
  out vec4 outColor;
  float sdRoundBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + vec2(radius);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }
  void main() {
    vec2 halfSize = v_size * 0.5;
    float radius = min(v_radius, min(halfSize.x, halfSize.y));
    // Shrink by half the border width so the border ring centers on the edge.
    float d = sdRoundBox(v_local - halfSize, halfSize - vec2(v_borderWidth * 0.5), radius);
    float aa = 0.75;
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
`;

const TEXT_VERTEX = /* glsl */ `#version 300 es
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
  ${COMMON_VERTEX_FOOT}
  void main() {
    vec2 p = a_pos + a_corner * a_size;
    gl_Position = vec4(toClip(p), 0.0, 1.0);
    v_uv = a_uv + a_corner * a_uvSize;
    v_alpha = a_alpha;
  }
`;

const TEXT_FRAGMENT = /* glsl */ `#version 300 es
  precision mediump float;
  in vec2 v_uv;
  in float v_alpha;
  uniform sampler2D u_atlas;
  uniform vec4 u_color;
  out vec4 outColor;
  void main() {
    float a = texture(u_atlas, v_uv).a * v_alpha;
    outColor = vec4(u_color.rgb * a, a);
  }
`;

export interface Program {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

export function createProgram(gl: WebGL2RenderingContext, kind: "edge" | "node" | "text"): Program {
  const sources = {
    edge: [EDGE_VERTEX, EDGE_FRAGMENT],
    node: [NODE_VERTEX, NODE_FRAGMENT],
    text: [TEXT_VERTEX, TEXT_FRAGMENT],
  } as const;
  const [vertexSource, fragmentSource] = sources[kind];
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? ""}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? ""}`);
  }
  return { program, uniform: (name) => gl.getUniformLocation(program, name) };
}
