import { createHash } from "node:crypto";
import { types } from "node:util";
import type { PipelineVersion } from "./court.ts";

// Deliberately not an environment switch. No continuation entry point may run
// until cursors, artifact fencing, retention and historical preflight are proved.
export const CONTINUATION_ENABLED = false;
export function requireContinuationEnabled(): never {
  throw new Error("Continuation disabled: checkpoints, retention and historical inactivity are not verified");
}
export type ContinuationWriter = { generation: number; runId: string };
export type ContinuationReservation = { generation: number; token: string };
export type ContinuationStartOutcome = { state: "returned"; runId: string } | { state: "lost" };
export type ContinuationStartResult = { state: "registered"; runId: string } | { state: "blocked" };
export type ContinuationGeneration = {
  generation: number; token: string; state: "blocked" | "reserved" | "starting" | "uncertain" | "running" | "finished";
  runId?: string; pipeline: PipelineVersion; adminId: string; reason: string;
  sourceRunId?: string; sourceDeploymentId?: string; inputHash: string; at: string;
  startOutcome?: ContinuationStartOutcome; reconciledRunId?: string;
};
export type ContinuationCheckpoint = {
  unit: string; kind: string; inputHash: string; pipeline: PipelineVersion; format: number;
  state: "ready" | "uncertain"; sourceRunId: string; sourceDeploymentId?: string;
  result?: unknown; resultHash?: string; resultRef?: string;
};

// Keep the existing bytes/order for ordinary JSON. Reject anything traversal
// would omit, and inspect data descriptors without invoking accessors/toJSON.
export function continuationJson(value: unknown): string {
  const active = new Set<object>();
  const invalid = (): never => { throw new Error("Continuation data must be finite canonical JSON"); };
  const serialize = (current: unknown): string => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number" && Number.isFinite(current)) return JSON.stringify(current);
    if (!current || typeof current !== "object" || types.isProxy(current) || active.has(current)) return invalid();
    const array = Array.isArray(current);
    if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype)) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(descriptors);
    const length = array ? descriptors.length.value as number : 0;
    if (array && keys.length !== length + 1) return invalid();
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") return invalid();
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !("value" in descriptor) ||
          (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) return invalid();
    }
    active.add(current);
    try {
      const parts: string[] = [];
      if (array) {
        for (let index = 0; index < length; index++) parts.push(serialize(descriptors[index].value));
        return "[" + parts.join(",") + "]";
      }
      for (const key of (keys as string[]).sort()) parts.push(JSON.stringify(key) + ":" + serialize(descriptors[key].value));
      return "{" + parts.join(",") + "}";
    } finally {
      active.delete(current); // Shared, noncyclic references are valid JSON.
    }
  };
  return serialize(value);
}
export function continuationHash(value: unknown): string {
  return createHash("sha256").update(continuationJson(value)).digest("hex");
}
export function validateContinuationCheckpoint(checkpoint: ContinuationCheckpoint): void {
  continuationJson(checkpoint); // Reject lossy/effectful data before reading envelope fields.
  if (!checkpoint.unit || !checkpoint.kind || !/^[a-f0-9]{64}$/.test(checkpoint.inputHash) ||
      ![1, 2, 3, 4, 5].includes(checkpoint.pipeline) || !Number.isSafeInteger(checkpoint.format) || checkpoint.format < 1 ||
      !checkpoint.sourceRunId || !["ready", "uncertain"].includes(checkpoint.state)) throw new Error("Invalid continuation checkpoint envelope");
  if (checkpoint.result !== undefined && checkpoint.resultHash !== continuationHash(checkpoint.result)) throw new Error("Complete inline result with verified hash required");
  if (checkpoint.state === "ready") {
    // Referenced artifacts need step 3/4 validators. Do not accept them as ready
    // merely because a caller supplies a plausible path/hash.
    if (checkpoint.resultRef || checkpoint.result === undefined || checkpoint.resultHash !== continuationHash(checkpoint.result)) throw new Error("Complete inline result with verified hash required; referenced checkpoints are blocked");
  }
}
