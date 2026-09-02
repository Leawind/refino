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

/** Editable fields sent on create/update; type and id are never editable. */
export interface NodePayload {
  body: string;
  summary?: string;
  grounds?: string[];
  rationale?: string;
  confirmed?: string;
}

/** Visualization directions, ordered from most abstract to most concrete. */
export type LayoutDirection = "LR" | "TB" | "RL" | "BT";
