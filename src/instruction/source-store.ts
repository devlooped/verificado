export type OperationStatus = "pending" | "running" | "ready" | "failed" | "uncertain";

export interface Operation {
  key: string;
  stage: string;
  status: OperationStatus;
  at: string;
  owner?: string;
  expiresAt?: string;
  result?: unknown;
  error?: string;
  inputHash?: string;
  // Exact canonical input, not an artifact name or a hash-only receipt.
  inputJson?: string;
  writer?: { generation: number; runId: string };
  recoveries: Array<{ at: string; reason: string }>;
}

export type OperationClaim = { owned: true; operation: Operation; owner: string } | { owned: false; operation: Operation };

export interface OperationRepository {
  // Explicit scope is a blocking signal, never evidence of authorization.
  readonly writer?: { generation: number; runId: string };
  claim(caseId: string, key: string, stage: string, leaseMs: number, inputHash?: string, input?: unknown): Promise<OperationClaim>;
  get(caseId: string, key: string): Promise<Operation | undefined>;
  publish(caseId: string, key: string, owner: string, result: unknown): Promise<void>;
  fail(caseId: string, key: string, owner: string, error: string, uncertain: boolean): Promise<void>;
  defer(caseId: string, key: string, owner: string): Promise<void>;
  recover(caseId: string, key: string, reason: string): Promise<void>;
  alias(caseId: string, url: string, sourceId: string): Promise<string>;
  resolve(caseId: string, url: string): Promise<string | undefined>;
}

// Test/mock equivalent of the durable repository. Services share this repository,
// never a service-local promise cache. Ownership expires to uncertain, not retryable.
export class MemoryOperationRepository implements OperationRepository {
  private operations = new Map<string, Operation>();
  private aliases = new Map<string, string>();
  private serial = 0;
  constructor(private now: () => number = Date.now) {}
  private id(caseId: string, key: string) { return JSON.stringify([caseId, key]); }
  private current(caseId: string, key: string) {
    const operation = this.operations.get(this.id(caseId, key));
    if (operation?.status === "running" && Date.parse(operation.expiresAt!) <= this.now()) {
      operation.status = "uncertain";
      operation.error = "Owner expired before checkpoint";
    }
    return operation;
  }
  async claim(caseId: string, key: string, stage: string, leaseMs: number, inputHash?: string): Promise<OperationClaim> {
    let operation = this.current(caseId, key);
    if (!operation) {
      operation = { key, stage, status: "pending", at: new Date(this.now()).toISOString(), recoveries: [], ...(inputHash ? {inputHash} : {}) };
      this.operations.set(this.id(caseId, key), operation);
    }
    if(operation.stage !== stage || (inputHash && operation.inputHash !== inputHash)) throw new Error("Source operation input or stage mismatch");
    if (operation.status !== "pending") return { owned: false, operation: structuredClone(operation) };
    const owner = String(++this.serial);
    Object.assign(operation, { status: "running", owner, expiresAt: new Date(this.now() + leaseMs).toISOString() });
    return { owned: true, owner, operation: structuredClone(operation) };
  }
  async get(caseId: string, key: string) { const result = this.current(caseId, key); return result && structuredClone(result); }
  private owned(caseId: string, key: string, owner: string) {
    const operation = this.current(caseId, key);
    if (!operation || operation.status !== "running" || operation.owner !== owner) throw new Error("Operation ownership lost");
    return operation;
  }
  async publish(caseId: string, key: string, owner: string, result: unknown) {
    Object.assign(this.owned(caseId, key, owner), { status: "ready", result: structuredClone(result), at: new Date(this.now()).toISOString() });
  }
  async fail(caseId: string, key: string, owner: string, error: string, uncertain: boolean) {
    Object.assign(this.owned(caseId, key, owner), { status: uncertain ? "uncertain" : "failed", error, at: new Date(this.now()).toISOString() });
  }
  async defer(caseId: string, key: string, owner: string) {
    const operation = this.owned(caseId, key, owner);
    if (operation.stage !== "canonical") throw new Error("External stages cannot be deferred");
    operation.status = "pending";
    delete operation.owner; delete operation.expiresAt;
  }
  async recover(caseId: string, key: string, reason: string) {
    if (!reason.trim()) throw new Error("Recovery requires an explicit reason");
    const operation = this.current(caseId, key);
    if (!operation || !["failed", "uncertain"].includes(operation.status)) throw new Error("Only failed/uncertain operations can be recovered");
    operation.recoveries.push({ at: new Date(this.now()).toISOString(), reason });
    operation.status = "pending";
    delete operation.owner; delete operation.error; delete operation.expiresAt;
  }
  async alias(caseId: string, url: string, sourceId: string) {
    const id = this.id(caseId, url);
    if (!this.aliases.has(id)) this.aliases.set(id, sourceId);
    return this.aliases.get(id)!;
  }
  async resolve(caseId: string, url: string) { return this.aliases.get(this.id(caseId, url)); }
  async list(caseId: string): Promise<Operation[]> {
    return [...this.operations].filter(([key]) => JSON.parse(key)[0] === caseId).map(([, operation]) => structuredClone(operation));
  }
}
