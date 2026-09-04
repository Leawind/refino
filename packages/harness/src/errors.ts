export type HarnessErrorCode = "UNKNOWN_NODE" | "FROZEN_NOT_CONSTRAINT" | "DUPLICATE_CONTEXT_ID";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;

  constructor(code: HarnessErrorCode, message: string) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
  }
}
