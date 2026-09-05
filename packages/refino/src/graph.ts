import { IssueCode, RefinoError } from "./types.js";
import type { ConstraintNode, Graph, GraphNode, RefinoNode } from "./types.js";

/**
 * Graph assembly and in-memory mutation. Pure and filesystem-free so the
 * engine can build graphs from any source.
 */

/**
 * Assemble a graph from resident node records: index them by id, intern id
 * strings and derive the children back-references (sorted, deduplicated;
 * unknown grounds stay out of the index — validateGraph reports them).
 * Rejecting duplicate ids is the caller's responsibility (last one wins).
 */
export function buildGraph(nodes: Iterable<RefinoNode>): Graph {
  const byId = new Map<string, GraphNode>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });
  for (const node of byId.values()) {
    if (node.type !== "constraint") continue;
    internGrounds(byId, node);
    for (const ground of node.grounds) addChild(byId.get(ground), node.id);
  }
  return { nodes: byId };
}

/**
 * Attach a node to the graph, maintaining the children back-references.
 * Throws on a duplicate id.
 */
export function addNode(graph: Graph, node: RefinoNode): void {
  if (graph.nodes.has(node.id)) {
    throw new RefinoError(IssueCode.DuplicateId, `Node id "${node.id}" is already in use.`);
  }
  const attached: GraphNode = { ...node, children: [] };
  graph.nodes.set(node.id, attached);
  if (attached.type === "constraint") {
    internGrounds(graph.nodes, attached);
    for (const ground of attached.grounds) addChild(graph.nodes.get(ground), attached.id);
  }
}

/**
 * Detach a node from the graph and return it. Throws when the id does not
 * resolve.
 */
export function removeNode(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.get(id);
  if (node === undefined) {
    throw new RefinoError(IssueCode.NodeNotFound, `Node "${id}" does not exist.`);
  }
  graph.nodes.delete(id);
  if (node.type === "constraint") {
    for (const ground of node.grounds) dropChild(graph.nodes.get(ground), id);
  }
  return node;
}

/**
 * Replace a constraint's grounds, maintaining the children back-references.
 * Validity (existing references, acyclicity) is the caller's job — run
 * `checkGroundsChange` before persisting; the primitive only keeps the
 * two-directional representation consistent.
 */
export function setGrounds(graph: Graph, node: ConstraintNode, grounds: readonly string[]): void {
  const attached = graph.nodes.get(node.id);
  if (attached === undefined || attached.type !== "constraint") {
    throw new RefinoError(IssueCode.NodeNotFound, `Node "${node.id}" does not exist.`);
  }
  replaceGrounds(graph, attached, grounds);
}

/**
 * Replace a node's resident fields with a fresh record (e.g. one re-read
 * from storage): summary, premise `confirmed` and constraint grounds in one
 * step. The id and type of the attached node are fixed; grounds
 * back-references are maintained.
 */
export function updateNode(graph: Graph, node: RefinoNode): void {
  const attached = graph.nodes.get(node.id);
  if (attached === undefined) {
    throw new RefinoError(IssueCode.NodeNotFound, `Node "${node.id}" does not exist.`);
  }
  if (attached.type !== node.type) return; // storage fixes the type by path; unreachable there
  attached.summary = node.summary;
  if (node.type === "premise" && attached.type === "premise") {
    if (node.confirmed === undefined) delete attached.confirmed;
    else attached.confirmed = node.confirmed;
  } else if (node.type === "constraint" && attached.type === "constraint") {
    replaceGrounds(graph, attached, node.grounds);
  }
}

/** Replace the attached node's grounds with id-interned copies and update both directions. */
function replaceGrounds(
  graph: Graph,
  attached: GraphNode & { type: "constraint" },
  grounds: readonly string[],
): void {
  for (const ground of attached.grounds) dropChild(graph.nodes.get(ground), attached.id);
  attached.grounds = grounds.map((g) => graph.nodes.get(g)?.id ?? g);
  for (const ground of attached.grounds) addChild(graph.nodes.get(ground), attached.id);
}

/** Point the node's grounds at the canonical id string instances. */
function internGrounds(nodes: Graph["nodes"], node: GraphNode & { type: "constraint" }): void {
  node.grounds = node.grounds.map((g) => nodes.get(g)?.id ?? g);
}

/** Sorted, deduplicated insertion into the parent's children. */
function addChild(parent: GraphNode | undefined, id: string): void {
  if (parent === undefined) return; // unknown grounds stay out; validateGraph reports them
  const children = parent.children as string[]; // engine-internal mutation of the derived index
  const at = children.findIndex((c) => c >= id);
  if (children[at] === id) return;
  if (at === -1) children.push(id);
  else children.splice(at, 0, id);
}

function dropChild(parent: GraphNode | undefined, id: string): void {
  if (parent === undefined) return;
  const children = parent.children as string[];
  const at = children.indexOf(id);
  if (at !== -1) children.splice(at, 1);
}
