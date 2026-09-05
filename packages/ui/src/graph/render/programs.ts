import edgeFragment from "./glsl/edge.frag?raw";
import edgeVertex from "./glsl/edge.vert?raw";
import nodeFragment from "./glsl/node.frag?raw";
import nodeVertex from "./glsl/node.vert?raw";
import textFragment from "./glsl/text.frag?raw";
import textVertex from "./glsl/text.vert?raw";

/** Edge quad: x along the segment, y across it (two triangles). */
export const EDGE_QUAD = new Float32Array([0, -0.5, 1, -0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1, -0.5]);

/** Unit square for nodes and glyphs (two triangles covering it exactly). */
export const UNIT_QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);

export interface Program {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

/**
 * Compiled WebGL2 programs for the canvas renderer's three draw phases
 * (edges, nodes, labels). Shader sources live in the sibling glsl/
 * directory as standalone .vert/.frag files for IDE support and offline
 * validation (test/glsl.test.ts). All colors are straight alpha in RGBA;
 * fragments are emitted premultiplied so the default canvas compositing
 * (premultipliedAlpha: true) stays correct. Throws on compile or link
 * errors: a broken program otherwise leaves the canvas blank with no
 * signal.
 */
export function createProgram(gl: WebGL2RenderingContext, kind: "edge" | "node" | "text"): Program {
  const sources = {
    edge: [edgeVertex, edgeFragment],
    node: [nodeVertex, nodeFragment],
    text: [textVertex, textFragment],
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
