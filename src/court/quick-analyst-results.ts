import { types } from "node:util";
import { z } from "zod";
import { COUNSEL } from "../domain/court.ts";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { nativeResearchTools } from "../instruction/native-research.ts";
import { MOCK_MODEL_ID, modelEffort, withoutEffort, type CourtModel } from "./models.ts";
import { quickPrompt, quickVoteMessages, quickVoteSchema } from "./quick.ts";

// An offline JSON export, NOT the SDK journal format or an execution checkpoint.
// Hash pins must be supplied independently of the export being checked.
export const QUICK_ANALYST_RESULTS_UNIT = "quick.complete-analyst-results";
const id = z.string().min(1).refine(value => value === value.trim(), "Identifiers must not be normalized");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.iso.datetime();
const source = z.object({ url: z.string().url(), title: z.string().optional() }).strict();
const model = z.object({ id, providerOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }).strict()
  .transform(value => value as CourtModel); // boundedJson validates every provider-option value first.
export const QuickAnalystOriginSchema = z.object({
  caseId: id, runId: id, deploymentId: id, pipeline: z.literal(5), language: id, simulated: z.boolean(),
  submission: z.object({ kind: z.literal("text"), text: z.string().min(1), check: z.literal("quick"),
    language: z.enum(["auto", "es", "en"]).optional(), resolvedLanguage: id.optional(), identifyClaims: z.literal(false).optional(),
  }).strict(),
  models: z.object({ judge: model, grok: model, gemini: model, claude: model, chatgpt: model }).strict(),
}).strict();
const artifact = z.object({ path: id, body: z.unknown() }).strict();
const step = z.object({
  journal: z.object({ id, method: z.enum(["answerQuick", "voteQuick"]), state: z.literal("completed"), arguments: z.unknown(), output: z.unknown() }).strict(),
  request: artifact, result: artifact, audit: z.object({ key: id, body: z.unknown() }).strict(),
}).strict();
export const QuickAnalystResultsSchema = z.object({
  schemaVersion: z.literal(1), origin: QuickAnalystOriginSchema,
  analysts: z.array(z.object({ by: z.enum(COUNSEL), answer: step, vote: step }).strict()).length(4),
  events: z.array(z.unknown()).length(9),
  // Historical Quick has no durable per-call intent ledger. Never turn an
  // empty supplied list into proof that every external operation is settled.
  operationCoverage: z.literal("unproved"), unresolvedOperations: z.array(id).length(0),
}).strict();
export const QuickAnalystExpectationSchema = z.object({
  origin: QuickAnalystOriginSchema, inputHash: hash, evidenceHash: hash,
}).strict();
export type QuickAnalystResults = z.infer<typeof QuickAnalystResultsSchema>;
export type QuickAnalystExpectation = z.infer<typeof QuickAnalystExpectationSchema>;

const answerOutput = z.object({ text: z.string().min(1), sources: z.array(source), at, modelId: id, effort: z.string().nullable() }).strict();
const voteOutput = quickVoteSchema.extend({ at, text: z.string() }).strict();
const answerStored = z.object({ at, text: z.string().min(1), sources: z.array(source), finishReason: z.literal("stop"),
  messages: z.array(z.unknown()), usage: z.unknown().optional(),
}).strict();
const voteStored = z.object({ at, output: quickVoteSchema, text: z.string().optional(), messages: z.array(z.unknown()), usage: z.unknown().optional() }).strict();

// Reject lossy canonicalization (including sparse arrays), accessors, cycles,
// non-JSON data and oversized exports BEFORE schemas/hashes can normalize them.
function boundedJson(value: unknown): void {
  let nodes = 0, characters = 0;
  const active = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new Error("Quick analyst export exceeds JSON bounds");
    if (typeof current === "string") { characters += current.length; }
    else if (typeof current === "number") { if (!Number.isFinite(current)) throw new Error("Quick analyst export requires finite JSON"); }
    else if (current !== null && typeof current !== "boolean") {
      if (!current || typeof current !== "object" || types.isProxy(current) || active.has(current)) throw new Error("Quick analyst export requires acyclic JSON");
      const array = Array.isArray(current);
      if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype)) throw new Error("Quick analyst export requires plain JSON");
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(current);
      if (array && (current.length > 100_000 || keys.length !== current.length + 1)) throw new Error("Quick analyst export requires dense JSON arrays");
      active.add(current);
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") throw new Error("Quick analyst export requires JSON keys");
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor) || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length))) throw new Error("Quick analyst export requires ordinary JSON properties");
        characters += key.length;
        visit(descriptor.value, depth + 1);
      }
      active.delete(current);
    }
    if (characters > 2_000_000) throw new Error("Quick analyst export exceeds JSON bounds");
  };
  visit(value, 0);
}

function equal(actual: unknown, expected: unknown, reason: string): void {
  if (continuationJson(actual) !== continuationJson(expected)) throw new Error(`Quick analyst results blocked: ${reason}`);
}
function options(value: CourtModel["providerOptions"]) {
  return value === undefined ? {} : { providerOptions: value };
}

// Validates only fully published, first-attempt, claim-free textual Quick 5.
// No artifact reader, DB, clock, provider, workflow or PhaseSession is called.
export function verifyQuickAnalystResults(expectationInput: unknown, exportInput: unknown) {
  boundedJson(expectationInput);
  boundedJson(exportInput);
  const expectation = QuickAnalystExpectationSchema.parse(expectationInput);
  const exported = QuickAnalystResultsSchema.parse(exportInput);
  equal(exported.origin, expectation.origin, "origin/model/input mismatch");
  if (expectation.inputHash !== continuationHash(expectation.origin) || expectation.evidenceHash !== continuationHash(exportInput)) throw new Error("Quick analyst results blocked: independent hash mismatch");
  const origin = exported.origin;
  if (origin.submission.resolvedLanguage !== undefined && origin.submission.resolvedLanguage !== origin.language) throw new Error("Quick analyst results blocked: language mismatch");
  const prompt = quickPrompt(origin.submission, origin.language);
  const journalIds = new Set<string>();
  const publicAnswers: unknown[] = [], publicVotes: unknown[] = [];
  for (const [index, by] of COUNSEL.entries()) {
    const analyst = exported.analysts[index];
    if (analyst.by !== by) throw new Error("Quick analyst results blocked: ordered complete seats required");
    const configured = origin.models[by] as CourtModel;
    const answer = answerOutput.parse(analyst.answer.journal.output);
    const vote = voteOutput.parse(analyst.vote.journal.output);
    const storedAnswer = answerStored.parse(analyst.answer.result.body);
    const storedVote = voteStored.parse(analyst.vote.result.body);
    if (storedAnswer.text !== storedAnswer.text.trim() || !storedAnswer.text.trim() || vote.rationale.trim().length < 10 || new Set(answer.sources.map(s => s.url)).size !== answer.sources.length) throw new Error("Quick analyst results blocked: incomplete answer/vote or duplicate source");
    equal(answer, { text: storedAnswer.text, sources: storedAnswer.sources, at: storedAnswer.at,
      modelId: origin.simulated ? MOCK_MODEL_ID : configured.id, effort: origin.simulated ? null : modelEffort(configured) }, "answer journal/artifact/model mismatch");
    equal(vote, { ...storedVote.output, at: storedVote.at, text: storedVote.text ?? "" }, "vote journal/artifact mismatch");
    for (const [kind, evidence] of [["answer", analyst.answer], ["vote", analyst.vote]] as const) {
      if (journalIds.has(evidence.journal.id)) throw new Error("Quick analyst results blocked: journal ID collision");
      journalIds.add(evidence.journal.id);
      const root = `quick/${by}/${kind}-0`;
      equal([evidence.request.path, evidence.result.path], [`${root}/request.json`, `${root}/result.json`], "artifact path/attempt collision");
      const args = { caseId: origin.caseId, submission: origin.submission, language: origin.language, model: configured, by, attempt: 0, simulated: origin.simulated };
      equal(evidence.journal.method, kind === "answer" ? "answerQuick" : "voteQuick", "journal method mismatch");
      equal(evidence.journal.arguments, kind === "answer" ? args : { ...args, answer }, "journal arguments mismatch");
      const request = kind === "answer"
        ? { modelId: configured.id, ...options(configured.providerOptions), ...prompt, tools: origin.simulated ? [] : nativeResearchTools(configured.id, "instruction") }
        : { modelId: configured.id, ...options(withoutEffort(configured.providerOptions)), reasoning: "none", system: prompt.system,
          // Zod adds non-enumerable ~standard metadata, absent from stored JSON.
          // Project only this locally generated schema, never supplied evidence.
          messages: quickVoteMessages(prompt.messages, answer.text), output: { ...z.toJSONSchema(quickVoteSchema, { target: "draft-7" }) } };
      equal(evidence.request.body, request, "request prompt/tools/provider configuration mismatch");
      const stored = kind === "answer" ? storedAnswer : storedVote;
      const auditId = `quick:${by}:${kind}:0`;
      const audit = { schemaVersion: 2, id: `step:${auditId}`, kind: "model_step", at: stored.at, seat: by, phase: "quick", modelId: configured.id, effort: modelEffort(configured),
        data: { channel: "decision", sessionId: `quick:${by}`, sequence: kind === "answer" ? 0 : 2,
          ...(stored.usage === undefined ? {} : { usage: stored.usage }), request: evidence.request.path, result: evidence.result.path,
          ...(kind === "answer" ? { sources: storedAnswer.sources } : {}) } };
      equal(evidence.audit, { key: auditId, body: audit }, "audit ID/sequence/provenance mismatch");
    }
    publicAnswers.push({ type: "quick_response", by, text: answer.text, sources: answer.sources, modelId: answer.modelId, effort: answer.effort, seq: index + 2, at: answer.at });
    publicVotes.push({ type: "content_vote", by, verdict: vote.verdict, rationale: vote.rationale.trim(), seq: index + 6, at: vote.at });
  }
  const openedAt = z.object({ at }).passthrough().parse(exported.events[0]).at;
  const effort = (configured: CourtModel) => origin.simulated ? null : modelEffort(configured);
  const opened = { type: "session_opened", judgeModel: origin.models.judge.id,
    counselModels: Object.fromEntries(COUNSEL.map(by => [by, origin.models[by].id])), judgeEffort: effort(origin.models.judge as CourtModel),
    counselEfforts: Object.fromEntries(COUNSEL.map(by => [by, effort(origin.models[by] as CourtModel)])),
    ...(origin.simulated ? { simulated: true } : {}), seq: 1, at: openedAt };
  equal(exported.events, [opened, ...publicAnswers, ...publicVotes], "publication incomplete or event collision");
  return { schemaVersion: 1 as const, unit: QUICK_ANALYST_RESULTS_UNIT, status: "verified-offline" as const,
    continuationEnabled: false as const, nextSeq: 10 as const, inputHash: expectation.inputHash,
    evidenceHash: expectation.evidenceHash, prefixHash: continuationHash(exported.events), evidence: structuredClone(exported) };
}

export function quickAnalystPreflight(expectation: unknown, exported: unknown) {
  const blockers = ["historical_inactivity_unproved", "historical_operation_coverage_unproved", "artifact_bytes_and_export_provenance_unproved", "continuation_disabled"];
  try {
    return { state: "blocked" as const, continuationEnabled: false as const, blockers, analystResults: verifyQuickAnalystResults(expectation, exported) };
  } catch {
    // Do not leak private artifact text, prompts or Zod diagnostics to callers.
    return { state: "blocked" as const, continuationEnabled: false as const, blockers: ["quick_analyst_evidence_invalid", ...blockers] };
  }
}
