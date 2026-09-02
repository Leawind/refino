export type HarnessErrorCode = "UNKNOWN_NODE" | "FRONTIER_NOT_CONSTRAINT" | "EMPTY_FRONTIER";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;

  constructor(code: HarnessErrorCode, message: string) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
  }
}
