import type { RecordedEvent, Submission } from "./court.ts";
import type { RetryCommand, RetryContract, RetryCreation, RetryFence, RetryOperationState } from "./retry-contract.ts";

// Storage and workflow share a same-run protocol, never a continuation generation.
export type RetryCaseState = "starting" | "active" | "pausing" | "paused" | "blocked" | "finished";
export type RetryStartObservation = { state: "returned"; runId: string } | { state: "lost" };
export type RetryUnitSpec = {
  key: string;
  kind: string;
  format: number;
  dependencies: string[];
  input: unknown;
  effect: "pure" | "external";
  estimatedCost: number | null;
};
export type RetryUnit = RetryUnitSpec & {
  inputHash: string;
  state: RetryOperationState;
  owner: string | null;
  attempt: number;
  epoch: number;
  result?: unknown;
  resultHash?: string;
  reason?: string;
  inactivityProof?: string;
};
export type RetryPause = {
  id: string;
  token: string;
  unitKey: string;
  reason: string;
  attempt: number;
  epoch: number;
  hookId: string | null;
  registrationEventId: string | null;
};
export type RetryRequestState = "reserved" | "dispatching" | "uncertain" | "delivered" | "accepted" | "blocked";
export type RetryRequest = {
  key: string;
  adminId: string;
  pauseId: string;
  command: RetryCommand;
  state: RetryRequestState;
  acceptedFence?: RetryFence;
};
export type RetryRecord = {
  creation: RetryCreation;
  contract: RetryContract | null;
  state: RetryCaseState;
  fence: RetryFence | null;
  startCandidate: RetryContract["binding"] | null;
  startObservation: RetryStartObservation | null;
  startClaimed: boolean;
  nextSeq: number;
  cursor: unknown;
  pause: RetryPause | null;
  units: RetryUnit[];
  requests: RetryRequest[];
};
export type RetryUnitClaim = { state: "claimed"; unit: RetryUnit; owner: string } | { state: "reused"; unit: RetryUnit } | { state: "blocked"; reason: string };
export type RetryBoundary = { key: string; units: string[]; expectedSeq: number; events: RecordedEvent[]; cursor: unknown };

// An explicit repository is injected. Its read() MUST NOT bootstrap/migrate.
// Every mutation locks cases first, then the retry record and subordinate rows.
export interface RetryRepository {
  create(creation: RetryCreation, submission: Submission, ownerId?: string): Promise<void>;
  read(caseId: string): Promise<RetryRecord | null>;
  claimStart(caseId: string, requestKey: string): Promise<boolean>;
  registerStart(caseId: string, requestKey: string, binding: RetryContract["binding"]): Promise<void>;
  observeStart(caseId: string, requestKey: string, observation: RetryStartObservation): Promise<void>;
  reconcileStart(caseId: string, requestKey: string): Promise<RetryFence | null>;
  claimUnit(fence: RetryFence, spec: RetryUnitSpec): Promise<RetryUnitClaim>;
  completeUnit(fence: RetryFence, key: string, owner: string, result: unknown): Promise<void>;
  failUnit(fence: RetryFence, key: string, owner: string, failure: { state: "proven_failed" | "uncertain"; reason: string; inactivityProof?: string }): Promise<void>;
  skipUnit(fence: RetryFence, spec: RetryUnitSpec, reason: string): Promise<void>;
  publishBoundary(fence: RetryFence, boundary: RetryBoundary): Promise<void>;
  beginPause(fence: RetryFence, unitKey: string, reason: string): Promise<RetryPause>;
  confirmPause(fence: RetryFence, pauseId: string, registration: { runId: string; hookId: string; eventId: string }): Promise<void>;
  reserveRequest(fence: RetryFence, pauseId: string, requestKey: string, adminId: string): Promise<RetryRequest>;
  claimDispatch(fence: RetryFence, requestKey: string): Promise<boolean>;
  observeDispatch(fence: RetryFence, requestKey: string, state: "delivered" | "uncertain" | "blocked"): Promise<void>;
  consumeRequest(fence: RetryFence, command: unknown): Promise<RetryFence | null>;
  block(fence: RetryFence, reason: string): Promise<void>;
  finish(fence: RetryFence): Promise<void>;
}
