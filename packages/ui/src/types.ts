/** Shared front-end types mirroring the JSON API contract. */

export type NodeType = "premise" | "constraint";

export interface NodeRecord {
  id: string;
  type: NodeType;
  file: string;
  summary: string;
  body: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
  dependents: string[];
}

export interface IssueRecord {
  code: string;
  message: string;
  file?: string;
  nodeId?: string;
  groundId?: string;
}

export interface GraphRecord {
  refinoDir: string;
  issues: IssueRecord[];
  nodes: NodeRecord[];
}

/** Editable fields sent on create/update; the id is never editable. When
 * `type` is sent and differs from the current type, the node is converted. */
export interface NodePayload {
  type?: NodeType;
  body: string;
  summary?: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
}

/** Visualization directions, ordered from most abstract to most concrete. */
export type LayoutDirection = "LR" | "TB" | "RL" | "BT";
