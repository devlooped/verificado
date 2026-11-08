import { z } from "zod";
import { continuationHash, continuationJson } from "./continuation.ts";

// A separate contract, NOT another pipeline version or continuation generation.
// No environment variable can enable a route before its acceptance proofs exist.
export const RETRY_CONTRACT_VERSION = "same-run-retry/1";
export const RETRY_ROUTES_ENABLED = false;

const identity = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const configuration = z.strictObject({
  check: z.enum(["quick", "expert"]),
  pipelineVersion: z.literal(5),
  submission: z.json(),
  models: z.record(identity, z.json()).refine(value => Object.keys(value).length > 0),
  prompts: z.record(identity, z.string()).refine(value => Object.keys(value).length > 0),
  tools: z.record(identity, z.json()),
  language: identity,
  today: z.iso.date(),
  budgets: z.record(identity, z.json()).refine(value => Object.keys(value).length > 0),
  // Each live adapter still has to prove that it honours this snapshot.
  automaticRetries: z.strictObject({
    workflow: z.literal(0), ai: z.literal(0), provider: z.literal(0),
    broker: z.literal(0), sandbox: z.literal(0),
  }),
});
const contractSchema = z.strictObject({
  version: z.literal(RETRY_CONTRACT_VERSION),
  creation: z.strictObject({ caseId: identity, nonce: identity, at: z.iso.datetime(), snapshotHash: hash }),
  initialStart: z.strictObject({ requestKey: identity }),
  configuration,
  configurationHash: hash,
  binding: z.strictObject({ runId: identity, deploymentId: identity, world: identity }),
});
export type RetryContract = z.infer<typeof contractSchema>;
const creationSchema = contractSchema.omit({ binding: true });
export type RetryCreation = z.infer<typeof creationSchema>;

// Excludes the binding: creation must precede start(). The binding is admitted
// only after the initial-start intent, run registration and observation reconcile.
export function retryCreationHash(contract: Pick<RetryContract, "version" | "creation" | "initialStart" | "configuration">): string {
  return continuationHash({
    version: contract.version,
    creation: { caseId: contract.creation.caseId, nonce: contract.creation.nonce, at: contract.creation.at },
    initialStart: contract.initialStart,
    configuration: contract.configuration,
  });
}

export function parseRetryContract(value: unknown): RetryContract | null {
  try {
    // Reject accessors/proxies, omitted values and lossy JSON before parsing.
    continuationJson(value);
    const parsed = contractSchema.safeParse(value);
    if (!parsed.success) return null;
    const contract = parsed.data;
    if (contract.configurationHash !== continuationHash(contract.configuration) ||
        contract.creation.snapshotHash !== retryCreationHash(contract)) return null;
    return contract;
  } catch { return null; } // Never expose prompts, submission or parser details.
}

export function parseRetryCreation(value: unknown): RetryCreation | null {
  try {
    continuationJson(value);
    const parsed = creationSchema.safeParse(value);
    if (!parsed.success || parsed.data.configurationHash !== continuationHash(parsed.data.configuration) ||
        parsed.data.creation.snapshotHash !== retryCreationHash(parsed.data)) return null;
    return parsed.data;
  } catch { return null; }
}

export type RetryFence = { caseId: string; runId: string; attempt: number; epoch: number };
export const retryCommandSchema = z.strictObject({
  requestKey: identity,
  version: z.literal(RETRY_CONTRACT_VERSION),
  expectedAttempt: counter,
  expectedEpoch: counter,
});
export type RetryCommand = z.infer<typeof retryCommandSchema>;

export function retryCommandMatches(value: unknown, fence: RetryFence): boolean {
  try {
    continuationJson(value);
    const command = retryCommandSchema.safeParse(value);
    return command.success && Number.isSafeInteger(fence.attempt) && fence.attempt >= 0 &&
      Number.isSafeInteger(fence.epoch) && fence.epoch >= 0 &&
      command.data.expectedAttempt === fence.attempt && command.data.expectedEpoch === fence.epoch;
  } catch { return false; }
}

export type RetryOperationState = "pending" | "running" | "ready" | "proven_failed" | "uncertain" | "skipped";
export type RetryBlockReason =
  | "not_admin" | "no_creation_contract" | "invalid_contract" | "creation_not_proved"
  | "initial_start_unreconciled" | "run_mismatch" | "run_unavailable" | "run_terminal"
  | "not_paused" | "pause_unverified" | "hook_unconfirmed" | "hook_mismatch" | "deployment_unavailable"
  | "retention_unverified" | "quota_unverified" | "evidence_unverified"
  | "operation_active" | "operation_uncertain" | "failure_unproved" | "route_disabled";

// Observations must come from authorized, read-only adapters. This pure reducer
// imports neither store (whose bootstrap executes DDL) nor Workflow APIs. Booleans
// here are proof requirements, not a replacement for reading/verifying evidence.
export type RetryPreflightInput = {
  admin: boolean;
  caseId: string;
  contract: unknown;
  creationRecordedAtomically: boolean;
  initialStartReconciled: boolean;
  caseState: "active" | "pausing" | "paused" | "blocked" | "finished";
  run: null | { runId: string; deploymentId: string; world: string; status: "pending" | "running" | "completed" | "failed" | "cancelled" };
  pause: null | { runId: string; hookId: string; attempt: number; epoch: number };
  hook: null | { runId: string; hookId: string; registrationInJournal: boolean; active: boolean };
  deploymentAvailable: boolean;
  retentionVerified: boolean;
  quotaVerified: boolean;
  evidenceVerified: boolean;
  operations: readonly { state: RetryOperationState; inactivityProved: boolean; estimatedCost: number | null }[];
};
export type RetryPreflight = {
  eligible: boolean;
  state: "blocked";
  reasons: RetryBlockReason[];
  estimatedPendingCost: number | null;
};

export function retryPreflight(input: RetryPreflightInput): RetryPreflight {
  const blocked = (eligible: boolean, reasons: RetryBlockReason[], estimatedPendingCost: number | null = null): RetryPreflight =>
    ({ eligible, state: "blocked", reasons, estimatedPendingCost });
  if (!input.admin) return blocked(false, ["not_admin"]);
  if (input.contract === null || input.contract === undefined) return blocked(false, ["no_creation_contract"]);
  const contract = parseRetryContract(input.contract);
  if (!contract) return blocked(false, ["invalid_contract"]);
  if (!input.creationRecordedAtomically || contract.creation.caseId !== input.caseId) return blocked(false, ["creation_not_proved"]);

  const reasons: RetryBlockReason[] = [];
  if (!input.initialStartReconciled) reasons.push("initial_start_unreconciled");
  if (!input.run) reasons.push("run_unavailable");
  else {
    if (input.run.runId !== contract.binding.runId || input.run.deploymentId !== contract.binding.deploymentId || input.run.world !== contract.binding.world) reasons.push("run_mismatch");
    if (["completed", "failed", "cancelled"].includes(input.run.status)) reasons.push("run_terminal");
    else if (input.run.status !== "running") reasons.push("run_unavailable");
  }
  if (input.caseState !== "paused") reasons.push("not_paused");
  if (!input.pause || input.pause.runId !== contract.binding.runId || !input.pause.hookId ||
      !Number.isSafeInteger(input.pause.attempt) || input.pause.attempt < 0 ||
      !Number.isSafeInteger(input.pause.epoch) || input.pause.epoch < 0) reasons.push("pause_unverified");
  if (!input.hook?.registrationInJournal || !input.hook.active) reasons.push("hook_unconfirmed");
  if (input.hook && (input.hook.runId !== contract.binding.runId || input.hook.hookId !== input.pause?.hookId)) reasons.push("hook_mismatch");
  if (!input.deploymentAvailable) reasons.push("deployment_unavailable");
  if (!input.retentionVerified) reasons.push("retention_unverified");
  if (!input.quotaVerified) reasons.push("quota_unverified");
  if (!input.evidenceVerified) reasons.push("evidence_unverified");
  let cost: number | null = 0;
  for (const operation of input.operations) {
    if (operation.state === "running") reasons.push("operation_active");
    if (operation.state === "uncertain") reasons.push("operation_uncertain");
    if (operation.state === "proven_failed" && !operation.inactivityProved) reasons.push("failure_unproved");
    if (operation.state === "ready" || operation.state === "skipped") continue;
    if (operation.estimatedCost === null || !Number.isFinite(operation.estimatedCost) || operation.estimatedCost < 0) cost = null;
    else if (cost !== null) {
      cost += operation.estimatedCost;
      if (!Number.isFinite(cost)) cost = null;
    }
  }
  // This is intentionally NOT an authorization path. No route is verified yet.
  reasons.push("route_disabled");
  return blocked(true, [...new Set(reasons)], cost);
}
