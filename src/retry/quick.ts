import { z } from "zod";
import { COUNSEL, majority, type Claim, type Counsel, type CourtEvent, type RecordedEvent, type Submission } from "../domain/court.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import type { RetryBoundary, RetryRecord, RetryUnitSpec } from "../domain/retry-state.ts";
import { quickClaimsSchema, quickTiebreakSchema, quickVoteSchema } from "../court/quick.ts";

const cursorSchema = z.strictObject({
  format: z.literal(1), profile: z.literal("quick"),
  stage: z.enum(["identify", "turns", "judgments", "post-close", "finish"]),
  claims: z.array(z.strictObject({ id: z.string().min(1), quote: z.string(), text: z.string().min(10) })).max(5),
  target: z.number().int().nonnegative(),
});
const rawSchema = z.strictObject({
  at: z.iso.datetime(), text: z.string(), output: z.json(),
  messages: z.array(z.json()), usage: z.json(), toolResults: z.array(z.json()),
  sources: z.array(z.strictObject({ url: z.url(), title: z.string().optional() })),
  finishReason: z.string(),
});
export type RetryQuickRawResult = z.infer<typeof rawSchema>;
export type RetryQuickPlan = { state: "units"; units: RetryUnitSpec[] } |
  { state: "skip"; unit: RetryUnitSpec; reason: string } |
  { state: "boundary"; boundary: RetryBoundary } | { state: "finished" } | { state: "blocked"; reason: string };

export const QUICK_POST_UNITS = ["prompt-translation", "cover.choice", "cover.download", "cover.approve", "cover.generate", "cover.publish", "archive", "cleanup"] as const;

// A complete input snapshot per subcall, not just seat/claim/attempt identifiers.
// Prompts, tools, options and budgets come from creation, never live settings.
function unit(record: RetryRecord, key: string, kind: string, dependencies: string[], payload: unknown, role = "judge", effect: "pure" | "external" = "external"): RetryUnitSpec {
  const c = record.contract!;
  const model = c.configuration.models[role];
  const prompt = c.configuration.prompts[kind];
  if (model === undefined || (effect === "external" && prompt === undefined)) throw new Error("quick_snapshot_incomplete");
  return {
    key, kind, format: 1, dependencies, effect, estimatedCost: null,
    input: { configurationHash: c.configurationHash, model, prompt: prompt ?? "", tools: c.configuration.tools,
      language: c.configuration.language, today: c.configuration.today, budgets: c.configuration.budgets,
      automaticRetries: c.configuration.automaticRetries, payload },
  };
}

function result(record: RetryRecord, expected: RetryUnitSpec): unknown | undefined {
  const found = record.units.find(u => u.key === expected.key);
  if (!found || (found.state !== "ready" && found.state !== "skipped")) return undefined;
  if (found.kind !== expected.kind || found.format !== expected.format || found.effect !== expected.effect ||
      continuationJson(found.dependencies) !== continuationJson(expected.dependencies) ||
      found.estimatedCost !== expected.estimatedCost || found.inputHash !== continuationHash(expected.input) ||
      found.inputHash !== continuationHash(found.input)) throw new Error("quick_result_unverified");
  if (found.state === "skipped") {
    if (!found.reason?.trim() || found.result !== undefined || found.resultHash !== undefined) throw new Error("quick_result_unverified");
    return { status: "skipped", reason: found.reason };
  }
  if (found.result === undefined || found.resultHash !== continuationHash(found.result)) throw new Error("quick_result_unverified");
  return found.result;
}

// A durable cursor chooses the next boundary; it never restarts holdQuickSession
// or renews its budgets. Partial seats have ready units but no out-of-order events.
export function nextRetryQuickPlan(record: RetryRecord, options = { simulation: false }): RetryQuickPlan {
  try { return plan(record, options); }
  catch (error) {
    const known = error instanceof Error && /^(quick_snapshot_incomplete|quick_result_unverified|quick_result_invalid|quick_cursor_invalid)$/.test(error.message);
    return { state: "blocked", reason: known ? (error as Error).message : "quick_contract_unverified" };
  }
}

function plan(record: RetryRecord, options: { simulation: boolean }): RetryQuickPlan {
  const c = record.contract;
  if (!c || !record.fence || record.state !== "active" || record.fence.caseId !== c.creation.caseId ||
      record.fence.runId !== c.binding.runId || c.configuration.check !== "quick" || c.configuration.pipelineVersion !== 5) return { state: "blocked", reason: "quick_contract_unverified" };
  const submission = c.configuration.submission as Submission;
  // Images require a separately verified immutable original; not inferred from
  // an object that happens to contain a plausible hash/reference.
  if (submission.kind !== "text" && submission.kind !== "link") return { state: "blocked", reason: "quick_original_unverified" };
  const model = (role: string) => {
    const value = c.configuration.models[role];
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" ||
        (value.effort !== null && typeof value.effort !== "string")) throw new Error("quick_snapshot_incomplete");
    return { id: value.id, effort: value.effort };
  };
  const seatModels = Object.fromEntries(COUNSEL.map(seat => [seat, model(`counsel.${seat}`)])) as Record<Counsel, ReturnType<typeof model>>;
  const judge = model("judge");
  let nextSeq = record.nextSeq;
  const recorded = (event: CourtEvent & { at: string }) => ({ ...event, seq: nextSeq++ }) as RecordedEvent;
  const cursor = (stage: z.infer<typeof cursorSchema>["stage"], claims: Claim[], target = 0) => ({ format: 1 as const, profile: "quick" as const, stage, claims, target });
  const boundary = (key: string, units: string[], events: RecordedEvent[], next: unknown): RetryQuickPlan =>
    ({ state: "boundary", boundary: { key, units, expectedSeq: record.nextSeq, events, cursor: next } });
  if (record.cursor === null) {
    if (record.nextSeq !== 1) throw new Error("quick_cursor_invalid");
    const opened = unit(record, "quick/open", "quick.open", [], { creation: c.creation }, "judge", "pure");
    const completed = result(record, opened);
    if (completed === undefined) return { state: "units", units: [opened] };
    if (continuationJson(completed) !== continuationJson({ status: "opened" })) throw new Error("quick_result_invalid");
    return boundary("quick/open", [opened.key], [recorded({
      type: "session_opened", judgeModel: judge.id, judgeEffort: judge.effort,
      counselModels: Object.fromEntries(COUNSEL.map(seat => [seat, seatModels[seat].id])) as Record<Counsel, string>,
      counselEfforts: Object.fromEntries(COUNSEL.map(seat => [seat, seatModels[seat].effort])) as Record<Counsel, string | null>, at: c.creation.at,
      ...(options.simulation ? { simulated: true } : {}),
    })], cursor("identify", []));
  }
  const current = cursorSchema.parse(record.cursor);
  const identify = unit(record, "quick/identify", "quick.identify", [], { submission }, "judge", submission.identifyClaims ? "external" : "pure");
  if (current.stage === "identify") {
    const identified = result(record, identify);
    if (identified === undefined) return submission.identifyClaims ? { state: "units", units: [identify] } :
      { state: "skip", unit: identify, reason: "identification_not_requested" };
    if (!submission.identifyClaims) {
      if (continuationJson(identified) !== continuationJson({ status: "skipped", reason: "identification_not_requested" })) throw new Error("quick_result_invalid");
      return boundary("quick/identify", [identify.key], [], cursor("turns", []));
    }
    const raw = rawSchema.parse(identified);
    const claims = quickClaimsSchema.parse(raw.output).claims.map((claim, i) => ({ id: "A" + (i + 1), ...claim }));
    return boundary("quick/identify", [identify.key], [recorded({ type: "claims_entered", claims, at: raw.at })], cursor("turns", claims));
  }
  if (current.stage === "finish") return { state: "finished" };
  if (current.stage === "post-close") {
    // Every post-close omission is an explicit result, not absence of bytes.
    // Runtime adapters remain blocked until artifact/retention proofs exist.
    if (!options.simulation || ![judge, ...Object.values(seatModels)].every(m => m.id.startsWith("fixture/"))) {
      return { state: "blocked", reason: "quick_artifact_retention_unverified" };
    }
    const required = QUICK_POST_UNITS.map((kind, i) => unit(record, `quick/post/${kind}`, `quick.post.${kind}`,
      i ? [`quick/post/${QUICK_POST_UNITS[i - 1]}`] : [], { submission, closedCursor: current }, "judge", "pure"));
    for (const expected of required) {
      const completed = result(record, expected);
      if (completed === undefined) return { state: "skip", unit: expected, reason: "simulation_has_no_external_artifacts" };
      if (continuationJson(completed) !== continuationJson({ status: "skipped", reason: "simulation_has_no_external_artifacts" })) throw new Error("quick_result_invalid");
    }
    return boundary("quick/post-close", required.map(u => u.key), [], cursor("finish", current.claims));
  }

  const answers = COUNSEL.map(seat => unit(record, `quick/answer/${seat}`, "quick.answer", [identify.key], { submission, claims: current.claims }, `counsel.${seat}`));
  const missingAnswers = answers.filter(expected => result(record, expected) === undefined);
  if (missingAnswers.length) return { state: "units", units: missingAnswers };
  const answered = answers.map(expected => {
    const raw = rawSchema.parse(result(record, expected));
    if (!raw.text.trim()) throw new Error("quick_result_invalid");
    return raw;
  });
  const targets: Array<Claim | null> = [...current.claims, null];
  const ballots = COUNSEL.flatMap((seat, i) => targets.map(target => unit(record,
    `quick/vote/${seat}/${target?.id ?? "content"}`, "quick.vote", [answers[i].key],
    { submission, claim: target, answer: answered[i] }, `counsel.${seat}`)));
  const missingVotes = ballots.filter(expected => result(record, expected) === undefined);
  if (missingVotes.length) return { state: "units", units: missingVotes };
  const voted = ballots.map(expected => {
    const raw = rawSchema.parse(result(record, expected));
    const output = quickVoteSchema.parse(raw.output);
    if (output.rationale.trim().length < 10) throw new Error("quick_result_invalid");
    return { ...output, at: raw.at };
  });
  if (current.stage === "turns") {
    const events: RecordedEvent[] = answered.map((raw, i) => recorded({ type: "quick_response", by: COUNSEL[i], text: raw.text,
      sources: raw.sources, modelId: seatModels[COUNSEL[i]].id, effort: seatModels[COUNSEL[i]].effort, at: raw.at }));
    COUNSEL.forEach((seat, i) => current.claims.forEach((claim, j) => {
      const vote = voted[i * targets.length + j];
      events.push(recorded({ type: "vote", by: seat, claimId: claim.id, verdict: vote.verdict, rationale: vote.rationale.trim(), at: vote.at }));
    }));
    COUNSEL.forEach((seat, i) => {
      const vote = voted[i * targets.length + targets.length - 1];
      events.push(recorded({ type: "content_vote", by: seat, verdict: vote.verdict, rationale: vote.rationale.trim(), at: vote.at }));
    });
    return boundary("quick/turns", [...answers, ...ballots].map(u => u.key), events, cursor("judgments", current.claims));
  }
  if (current.target >= targets.length) throw new Error("quick_cursor_invalid");
  const target = targets[current.target];
  const votes = COUNSEL.map((_seat, i) => voted[i * targets.length + current.target]);
  const agreed = majority(votes.map(vote => vote.verdict));
  let verdict = agreed;
  let reasoning = "";
  let at = votes.at(-1)!.at;
  const dependencies = COUNSEL.map(seat => `quick/vote/${seat}/${target?.id ?? "content"}`);
  if (!agreed) {
    const tiebreak = unit(record, `quick/tiebreak/${target?.id ?? "content"}`, "quick.tiebreak", dependencies,
      { submission, claim: target, answers: answered, votes });
    const completed = result(record, tiebreak);
    if (completed === undefined) return { state: "units", units: [tiebreak] };
    const raw = rawSchema.parse(completed);
    const decision = quickTiebreakSchema.parse(raw.output);
    if (!decision.reasoning.trim()) throw new Error("quick_result_invalid");
    verdict = decision.verdict; reasoning = decision.reasoning.trim(); at = raw.at;
    dependencies.push(tiebreak.key);
  }
  const events = [recorded(target ? { type: "judgment", claimId: target.id, verdict: verdict!, method: agreed ? "consensus" : "judge", reasoning, at } :
    { type: "content_judgment", verdict: verdict!, method: agreed ? "consensus" : "judge", reasoning, at })];
  if (!target) events.push(recorded({ type: "session_closed", at }));
  return boundary(`quick/judgment/${target?.id ?? "content"}`, dependencies, events,
    target ? cursor("judgments", current.claims, current.target + 1) : cursor("post-close", current.claims));
}

// Only pure outcomes are implemented here. Live generators are deliberately
// absent, so no provider/cost retry policy is silently inherited from quick-play.
export async function performPureRetryQuickUnit(spec: RetryUnitSpec): Promise<unknown> {
  if (spec.key === "quick/open" && spec.kind === "quick.open" && spec.effect === "pure") return { status: "opened" };
  if (spec.key === "quick/identify" && spec.effect === "pure") return { status: "skipped", reason: "identification_not_requested" };
  throw new Error("Retry adapter unavailable");
}
