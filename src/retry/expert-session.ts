import { z } from "zod";
import { PhaseSession, type PhaseState, type PhaseTurn } from "../court/phase-session.ts";
import type { RecordedEvent } from "../domain/court.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { parseRetryContract, type RetryFence } from "../domain/retry-contract.ts";
import type { RetryRepository, RetryUnitSpec } from "../domain/retry-state.ts";
import { modelFacingEvents } from "../instruction/court-tools.ts";
import { executeRecordedUnit } from "./execute.ts";
import { RetryExpertPhaseRepository } from "./expert-phase.ts";

const same = (a: unknown, b: unknown) => continuationJson(a) === continuationJson(b);
const reject = (): never => { throw new Error("Expert original input rejected"); };
const modelSchema = z.strictObject({ id: z.string().min(1), effort: z.string().nullable(),
  providerOptions: z.record(z.string(), z.record(z.string(), z.json())).optional() });
export type RetryExpertPhaseIdentity = Pick<PhaseState, "phase" | "seat" | "channel">;

// Only this NEW-path facade opens retry conversations. No caller-provided
// prompt, live case, settings lookup, or legacy repository can enter open().
export class RetryExpertSession {
  private constructor(readonly session: PhaseSession, private retry: RetryRepository,
    private fence: RetryFence, private configurationHash: string) {}

  static async open(retry: RetryRepository, fence: RetryFence, identity: RetryExpertPhaseIdentity): Promise<RetryExpertSession> {
    const record = await retry.read(fence.caseId), contract = parseRetryContract(record?.contract);
    if (!record || !contract || record.state !== "active" || !same(record.fence, fence) ||
      contract.configuration.check !== "expert" || contract.creation.caseId !== fence.caseId || contract.binding.runId !== fence.runId ||
      !same(record.creation, (({ binding: _binding, ...creation }) => creation)(contract))) return reject();
    const key = `${identity.phase}:${identity.seat}:${identity.channel}`;
    const config = contract.configuration;
    const initial = config.prompts[`expert.initial.${key}`], system = config.prompts[`expert.system.${key}`];
    const tools = config.tools[`expert.${key}`];
    if (typeof initial !== "string" || typeof system !== "string" || tools === undefined) return reject();
    const parsed = modelSchema.safeParse(config.models[identity.seat === "judge" ? "judge" : `counsel.${identity.seat}`]);
    if (!parsed.success) return reject();
    const model = { id: parsed.data.id, ...(parsed.data.providerOptions ? { providerOptions: parsed.data.providerOptions } : {}) };
    const session = await PhaseSession.open(fence.caseId, { ...identity, model, initial, system, tools: continuationJson(tools) },
      new RetryExpertPhaseRepository(retry, fence, initial));
    return new RetryExpertSession(session, retry, structuredClone(fence), contract.configurationHash);
  }

  // The full original record, not just its seqs or model-visible subset, is
  // pinned BEFORE begin. Reuse validates task/record/budget even when complete.
  async begin(id: string, record: readonly RecordedEvent[], task: string, budgetMs = 300_000): Promise<PhaseTurn> {
    continuationJson(record);
    if (!id || !Number.isSafeInteger(budgetMs) || budgetMs <= 0 || typeof task !== "string" ||
      record.some((event, index) => event.seq !== index + 1)) return reject();
    const { session } = this;
    const key = `expert/turn-pin/${continuationHash([session.key, id])}`;
    const stored = (await this.retry.read(this.fence.caseId))?.units.find(unit => unit.key === key);
    const previous = session.state.turns[id];
    const previousCursor = stored ? (stored.input as { previousCursor?: unknown }).previousCursor : session.state.cursor;
    if (!Number.isSafeInteger(previousCursor) || (previousCursor as number) < 0 || (previousCursor as number) > record.length ||
      (previous && !stored)) return reject();
    const input = { configurationHash: this.configurationHash, sessionId: session.state.id, phaseKey: session.key,
      turnId: id, previousCursor, task, record, budgetMs };
    const spec: RetryUnitSpec = { key, kind: "expert.turn.pin", format: 1, effect: "pure", estimatedCost: null, dependencies: [], input };
    const pinned = await executeRecordedUnit(this.retry, this.fence, spec, async () => ({ status: "pinned" }));
    if (pinned.state !== "complete" || !same(pinned.result, { status: "pinned" })) return reject();
    const closed = session.state.phase === "debate" ? record.find(event => event.type === "instruction_closed")?.seq : 0;
    if (closed === undefined) return reject();
    const expected = { role: "user", content: JSON.stringify({
      events: modelFacingEvents(record.filter(event => event.seq > Math.max(previousCursor as number, closed))), task,
    }) };
    // Validate before calling legacy begin: its reuse branch ignores arguments.
    if (previous && !same(session.state.messages[previous.start - 1], expected)) return reject();
    const turn = await session.begin(id, record, task, budgetMs);
    if (!same(session.state.messages[turn.start - 1], expected)) return reject();
    return turn;
  }
}
