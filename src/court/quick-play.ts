import { gateway, generateText, jsonSchema, NoObjectGeneratedError, Output, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import type { Claim, Counsel, QuickSource, Submission } from "../domain/court.ts";
import type { ArtifactStore } from "../evidence/artifacts.ts";
import { caseArtifactStore } from "../evidence/blob.ts";
import { nativeResearchTools } from "../instruction/native-research.ts";
import { mockInstructionArtifacts } from "../instruction/mock.ts";
import { getImage, saveCaseAuditRecord } from "../store.ts";
import { createQuickMockModel } from "./mock.ts";
import { MOCK_MODEL_ID, modelEffort, withoutEffort, type CourtModel } from "./models.ts";
import { quickClaimsPrompt, quickClaimsSchema, quickPrompt, quickTiebreakPrompt, quickTiebreakSchema, quickVoteMessages, quickVoteSchema, type QuickAnswer, type QuickClaims, type QuickDecision, type QuickEntry, type QuickFailure, type QuickImage, type QuickVote } from "./quick.ts";

// The live calls of a Quick check, one per workflow step. Each writes its
// request and result to the case artifacts and a model_step audit record, so
// case.jsonl and the costs of case.json include it.

// An answer thinks and searches; its step must end within the function duration.
export const QUICK_ANSWER_MS = 240_000;
// A typed vote only copies the answer, without thinking.
const QUICK_VOTE_MS = 150_000;

export type QuickPlayDependencies = {
  artifacts: ArtifactStore;
  audit: typeof saveCaseAuditRecord;
  getImage: typeof getImage;
  // A simulated model, in place of the Gateway; no native tools are given to it.
  model?: LanguageModel;
};

const live: QuickPlayDependencies = { artifacts: caseArtifactStore, audit: saveCaseAuditRecord, getImage };

// A local simulation (`npm run dev:mock`): files in memory, no audit records, a scripted model.
export function simulatedQuickDependencies(step: "claims" | "answer" | "vote" | "tiebreak"): QuickPlayDependencies {
  return { artifacts: mockInstructionArtifacts, audit: async () => {}, getImage, model: createQuickMockModel(step) };
}

type Seat = Counsel | "judge";
type Stored = { at: string; error?: string; text?: string; messages?: ModelMessage[]; usage?: unknown; sources?: QuickSource[]; output?: unknown; finishReason?: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

// The submitted image goes to the model, never into request.json.
function withoutImages(messages: readonly ModelMessage[]): unknown[] {
  return messages.map((m) => Array.isArray(m.content)
    ? { ...m, content: m.content.map((part) => part.type === "file" ? { type: "file", mediaType: part.mediaType, data: "(the submitted image)" } : part) }
    : m);
}

// Provider-executed search, passed in-process as the sandbox harness passes it.
function nativeTools(modelId: string): { tools: ToolSet; definitions: unknown[] } {
  const definitions = nativeResearchTools(modelId, "instruction");
  const tools = Object.fromEntries(definitions.map((d) => [d.name, { type: "provider", id: d.id, args: d.args, isProviderExecuted: true, inputSchema: jsonSchema({ type: "object" }) }])) as ToolSet;
  return { tools, definitions };
}

async function image(caseId: string, submission: Submission, deps: QuickPlayDependencies): Promise<QuickImage | undefined> {
  if (submission.kind !== "image") return undefined;
  const stored = await deps.getImage(caseId);
  if (!stored) throw new Error(`No se encontró la imagen original del caso ${caseId}.`);
  return { bytes: stored.bytes, mimeType: stored.mimeType };
}

async function readStored(caseId: string, path: string, deps: QuickPlayDependencies): Promise<Stored | undefined> {
  const bytes = (await deps.artifacts.read(caseId)).get(path);
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) as Stored : undefined;
}

// One generation: a result already written (a step run again after a crash) is
// reused, so a completed paid call is not paid again; otherwise the model is
// called, and its failure is a result too, for the orchestration to retry.
async function generation(caseId: string, deps: QuickPlayDependencies, call: {
  seat: Seat; step: "claims" | "answer" | "vote" | "tiebreak"; attempt: number; sequence: number; model: CourtModel; claim?: Claim;
  request: () => Promise<Record<string, unknown>>; generate: () => Promise<Omit<Stored, "at">>;
}): Promise<Stored> {
  const root = `quick/${call.seat}/${call.claim ? "claims/" + call.claim.id + "/" : ""}${call.step}-${call.attempt}`;
  const requestPath = `${root}/request.json`, resultPath = `${root}/result.json`;
  let result = await readStored(caseId, resultPath, deps);
  if (!result) {
    const request = await call.request();
    let generated: Omit<Stored, "at">;
    try { generated = await call.generate(); } catch (error) { generated = { error: message(error) }; }
    result = { at: new Date().toISOString(), ...generated };
    await deps.artifacts.write(caseId, new Map([[requestPath, JSON.stringify({ modelId: call.model.id, ...request })], [resultPath, JSON.stringify(result)]]));
  }
  const sessionId = `quick:${call.seat}${call.claim ? ":claim:" + call.claim.id : ""}`;
  const id = `${sessionId}:${call.step}:${call.attempt}`;
  await deps.audit(caseId, id, { schemaVersion: 2, id: `step:${id}`, kind: "model_step", at: result.at, seat: call.seat, phase: "quick", modelId: call.model.id, effort: modelEffort(call.model),
    data: { channel: "decision", sessionId, sequence: call.sequence, usage: result.usage, request: requestPath, result: resultPath, ...(result.error ? { error: result.error } : {}), ...(result.sources ? { sources: result.sources } : {}) } });
  return result;
}

function citedSources(sources: ReadonlyArray<{ sourceType: string; url?: string; title?: string }>): QuickSource[] {
  const seen = new Set<string>();
  return sources.flatMap((s) => s.sourceType === "url" && s.url && !seen.has(s.url) && seen.add(s.url) ? [{ url: s.url, ...(s.title ? { title: s.title } : {}) }] : []);
}

export async function quickIdentifyClaims(caseId: string, submission: Submission, language: string, model: CourtModel, attempt: number, injected?: QuickPlayDependencies): Promise<QuickClaims | QuickFailure> {
  const deps = injected ?? live;
  const prompt = quickClaimsPrompt(submission, language, await image(caseId, submission, deps));
  const native = !deps.model && submission.kind === "link" ? nativeTools(model.id) : undefined;
  const result = await generation(caseId, deps, {
    seat: "judge", step: "claims", attempt, sequence: attempt, model,
    request: async () => ({ providerOptions: model.providerOptions, system: prompt.system, messages: withoutImages(prompt.messages), tools: native?.definitions ?? [], output: z.toJSONSchema(quickClaimsSchema, { target: "draft-7" }) }),
    generate: async () => {
      try {
        const generated = await generateText({ model: deps.model ?? gateway(model.id), providerOptions: model.providerOptions, system: prompt.system, messages: prompt.messages,
          ...(native ? { tools: native.tools } : {}), output: Output.object({ schema: quickClaimsSchema }), stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: AbortSignal.timeout(QUICK_ANSWER_MS) });
        return { output: generated.output, text: generated.text, messages: generated.responseMessages, usage: generated.usage };
      } catch (error) {
        if (!NoObjectGeneratedError.isInstance(error)) throw error;
        return { error: error.message.slice(0, 300), text: error.text ?? "", usage: error.usage };
      }
    },
  });
  if (result.error) return { error: result.error };
  return { claims: quickClaimsSchema.parse(result.output).claims.map((claim, i) => ({ id: "A" + (i + 1), ...claim })), at: result.at };
}

export async function quickAnswer(caseId: string, submission: Submission, language: string, model: CourtModel, by: Counsel, attempt: number, injected?: QuickPlayDependencies, claims: readonly Claim[] = []): Promise<QuickAnswer | QuickFailure> {
  const deps = injected ?? live;
  const prompt = quickPrompt(submission, language, await image(caseId, submission, deps), claims);
  const native = deps.model ? undefined : nativeTools(model.id);
  const result = await generation(caseId, deps, {
    seat: by, step: "answer", attempt, sequence: attempt, model,
    request: async () => ({ providerOptions: model.providerOptions, system: prompt.system, messages: withoutImages(prompt.messages), tools: native?.definitions ?? [] }),
    generate: async () => {
      const generated = await generateText({ model: deps.model ?? gateway(model.id), providerOptions: model.providerOptions, system: prompt.system, messages: prompt.messages,
        ...(native ? { tools: native.tools } : {}), stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: AbortSignal.timeout(QUICK_ANSWER_MS) });
      const text = generated.text.trim();
      const answer = { messages: generated.responseMessages, usage: generated.usage, finishReason: generated.finishReason, sources: citedSources(generated.sources) };
      return text ? { ...answer, text } : { ...answer, error: "empty answer (" + generated.finishReason + ")" };
    },
  });
  if (result.error || !result.text) return { error: result.error ?? "empty answer" };
  return { text: result.text, sources: result.sources ?? [], at: result.at, modelId: deps.model ? MOCK_MODEL_ID : model.id, effort: deps.model ? null : modelEffort(model) };
}

export async function quickVote(caseId: string, submission: Submission, language: string, model: CourtModel, by: Counsel, answer: QuickAnswer, attempt: number, retry?: QuickFailure, injected?: QuickPlayDependencies, claim?: Claim): Promise<QuickVote | QuickFailure> {
  const deps = injected ?? live;
  const prompt = quickPrompt(submission, language, await image(caseId, submission, deps));
  const messages = quickVoteMessages(prompt.messages, answer.text, retry, claim);
  // The vote copies the answer: no thinking, or the least the model allows.
  const reasoning = { providerOptions: withoutEffort(model.providerOptions), reasoning: "none" as const };
  const result = await generation(caseId, deps, {
    seat: by, step: "vote", attempt, sequence: (claim ? 0 : 2) + attempt, model, claim,
    request: async () => ({ ...reasoning, system: prompt.system, messages: withoutImages(messages), output: z.toJSONSchema(quickVoteSchema, { target: "draft-7" }) }),
    generate: async () => {
      try {
        const generated = await generateText({ model: deps.model ?? gateway(model.id), ...reasoning, system: prompt.system, messages, output: Output.object({ schema: quickVoteSchema }),
          stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: AbortSignal.timeout(QUICK_VOTE_MS) });
        return { output: generated.output, text: generated.text, messages: generated.responseMessages, usage: generated.usage };
      } catch (error) {
        // An answer that does not parse is the seat's to correct.
        if (!NoObjectGeneratedError.isInstance(error)) throw error;
        const cause = error.cause instanceof Error ? " " + error.cause.message : "";
        return { error: (error.message + cause).slice(0, 300), text: error.text ?? "", usage: error.usage };
      }
    },
  });
  if (result.error) return { error: result.error, text: result.text ?? "" };
  const output = quickVoteSchema.parse(result.output);
  return { ...output, at: result.at, text: result.text ?? "" };
}

export async function quickTiebreak(caseId: string, submission: Submission, language: string, model: CourtModel, entries: QuickEntry[], attempt: number, injected?: QuickPlayDependencies, claim?: Claim): Promise<QuickDecision | QuickFailure> {
  const deps = injected ?? live;
  const prompt = quickTiebreakPrompt(submission, language, entries, await image(caseId, submission, deps), claim);
  const result = await generation(caseId, deps, {
    seat: "judge", step: "tiebreak", attempt, sequence: (submission.identifyClaims && !claim ? 2 : 0) + attempt, model, claim,
    request: async () => ({ providerOptions: model.providerOptions, system: prompt.system, messages: withoutImages(prompt.messages), output: z.toJSONSchema(quickTiebreakSchema, { target: "draft-7" }) }),
    generate: async () => {
      try {
        const generated = await generateText({ model: deps.model ?? gateway(model.id), providerOptions: model.providerOptions, system: prompt.system, messages: prompt.messages,
          output: Output.object({ schema: quickTiebreakSchema }), stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: AbortSignal.timeout(QUICK_ANSWER_MS) });
        return { output: generated.output, text: generated.text, messages: generated.responseMessages, usage: generated.usage };
      } catch (error) {
        if (!NoObjectGeneratedError.isInstance(error)) throw error;
        return { error: error.message.slice(0, 300), text: error.text ?? "", usage: error.usage };
      }
    },
  });
  if (result.error) return { error: result.error };
  return { ...quickTiebreakSchema.parse(result.output), at: result.at };
}
