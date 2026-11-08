import type { RetryCreation } from "../domain/retry-contract.ts";
import type { Submission, RecordedEvent } from "../domain/court.ts";
import { continuationJson } from "../domain/continuation.ts";
import { initialRetryStored, RetryRepositoryBase, type RetryMutation } from "./repository.ts";

// Offline test double. No providers, filesystem, environment or database access.
// Transactions run synchronously before their promise resolves; callers get copies.
type Stored = ReturnType<typeof initialRetryStored>;
const clone = <T>(value: T): T => JSON.parse(continuationJson(value)) as T;
export class MemoryRetryRepository extends RetryRepositoryBase {
  private readonly cases = new Map<string, Stored>();
  private readonly events = new Map<string, RecordedEvent[]>();
  // Simulate a pre-existing legacy case without enrolling it.
  constructor(existingCaseIds: readonly string[] = []) { super(); for (const id of existingCaseIds) this.events.set(id, []); }
  protected async insert(creation: RetryCreation, _submission: Submission, _ownerId?: string): Promise<void> {
    const id=creation.creation.caseId;
    if (this.cases.has(id) || this.events.has(id)) throw new Error("Retry case already exists");
    this.cases.set(id,initialRetryStored(creation)); this.events.set(id,[]);
  }
  protected async load(caseId: string): Promise<Stored | null> { const value=this.cases.get(caseId); return value ? clone(value) : null; }
  protected async mutate<T>(caseId: string, _operation: string, fn: (data: Stored, mutation: RetryMutation) => T): Promise<T> {
    const current=this.cases.get(caseId); if (!current) throw new Error("Retry case not found");
    const data=clone(current), mutation:RetryMutation={events:[],audit:null};
    const result=fn(data,mutation);
    const runId=data.record.startCandidate?.runId;
    if (runId && [...this.cases].some(([id,stored])=>id!==caseId && stored.record.startCandidate?.runId===runId)) throw new Error("Retry run already bound");
    this.cases.set(caseId,data); this.events.get(caseId)!.push(...clone(mutation.events));
    return result;
  }
  async readEvents(caseId: string): Promise<RecordedEvent[]> { return clone(this.events.get(caseId) ?? []); }
}
