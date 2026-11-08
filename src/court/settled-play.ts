import { gateway, generateText, NoObjectGeneratedError, Output, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { project, sharedPipeline, type CaseRecord, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import type { ArtifactStore } from "../evidence/artifacts.ts";
import { caseArtifactStore } from "../evidence/blob.ts";
import { loadSettledCorpus } from "../evidence/settled.ts";
import { sha256 } from "../evidence/validate.ts";
import { CourtActionSchemas, createCourtActions, phaseActions, turnPhase, typedDecision } from "../instruction/court-tools.ts";
import { caseSourceService } from "../instruction/proxy.ts";
import { criticismIndex } from "../instruction/criticism-index.ts";
import { advancePreparation, nativePreparationDefinitions, preparationDefinitions } from "../instruction/preparation.ts";
import { normalizeOrKeep, type SourceService } from "../instruction/sources.ts";
import { executeSourceTool, SourceToolSchemas, sourceToolsFor } from "../instruction/tools.ts";
import { getCase, recordCaseToolActivity, saveCaseAuditRecord } from "../store.ts";
import { courtMaxOutputTokens, courtOutputPhase, modelEffort, seatModel, withoutEffort } from "./models.ts";
import { PhaseSession, phaseSystem, type PhaseRepository, type PhaseTurn } from "./phase-session.ts";
import { seatOf, type Docket, type TurnOutcome, type TurnSpec } from "./turns.ts";

export type SharedTurnDependencies = {
  reader: SourceService; artifacts: ArtifactStore; record: CaseRecord;
  repository?: PhaseRepository; model?: LanguageModel;
  // One unit of preparation: the draft once complete, undefined while under way.
  prepare?(session: PhaseSession): Promise<string | undefined>;
  worker?: Parameters<typeof executeSourceTool>[1]["worker"];
  audit: typeof saveCaseAuditRecord;
  activity: typeof recordCaseToolActivity;
  // Records the prompts for case.jsonl; injected runs record none without it.
  prompt?: typeof saveCaseAuditRecord;
};

// Time allowed to one decision generation and its tools. With setup, its step
// stays within the function duration even when the runtime starts it late.
const DECISION_GENERATION_MS = 150_000;
// A pipeline 3 decision is reasoned in prose over a long research report, with
// the model's thinking; its typed answer then only copies it, with as little
// thinking as the model allows, in a decision generation's time.
const REASONING_GENERATION_MS = 240_000;
// A pipeline 3 decision turn: the reasoning answer, then the typed answer and
// one correction after feedback.
const TYPED_TURN_MS = 600_000;

// Runs every unit of a shared turn in this process (tests and scripts).
export async function playSharedTurn(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number, injected?: SharedTurnDependencies): Promise<TurnOutcome> {
  for (;;) {
    const outcome = await advanceSharedTurn(caseId, docket, spec, record, attempt, injected);
    if (outcome) return outcome;
  }
}

// One bounded unit of a shared turn: one preparation unit or one decision
// generation. Returns the outcome once the turn ends, undefined while it is
// under way. Every unit is checkpointed, so each runs in a workflow step of its own.
export async function advanceSharedTurn(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number, injected?: SharedTurnDependencies): Promise<TurnOutcome | undefined> {
  const stored = injected?.record ?? await getCase(caseId);
  if (!stored || !sharedPipeline(stored.pipelineVersion) || !docket.models || !docket.language) throw new Error("Shared pipeline requires its durable processing snapshot");
  const artifacts = injected?.artifacts ?? caseArtifactStore;
  const reader = injected?.reader ?? caseSourceService(stored);
  const audit = injected?.audit ?? saveCaseAuditRecord;
  const activity = injected?.activity ?? recordCaseToolActivity;
  const seat = seatOf(spec), phase = turnPhase(spec), model = seatModel(docket.models, seat);
  // Native pipelines research with the provider's tools in one preparation call;
  // the decision only files what the report found.
  const native = (stored.pipelineVersion === 3 || stored.pipelineVersion === 4 || stored.pipelineVersion === 5) && (phase === "instruction" || phase === "criticism");
  // A native seat decides in prose, then gives the same decision as a typed
  // answer, which the host records: it cannot answer without deciding.
  const typed = native ? typedDecision(phase, record) : undefined;
  const corpus = phase === "debate" ? await loadSettledCorpus(caseId, record as RecordedEvent[], artifacts) : undefined;
  const initial = corpus
    ? `question.json:\n${corpus.question}\n\nindex.md:\n${corpus.index}`
    : JSON.stringify({ today: docket.today, submission: docket.submission, context: docket.submissionContext });
  const id = sha256(JSON.stringify([spec, attempt, ...record.map((event) => (event as RecordedEvent).seq || 0)]));
  const plan = createCourtActions(docket, spec, record, reader, corpus, native).plan;
  // The prompts are in English and are not translated: the language rule of the
  // system prompt makes the seats write in the case language.
  const instruction = plan.instruction.replaceAll("web_fetch", "read_source");
  const note = native ? (phase === "instruction" ? "Your filing gives, for each source of the preparation report, its exact URL and the verbatim quote, copied from the report in the source's language, and for each claim what you searched for in both directions. The host fetches the URLs and keeps a proposal only if its quote is found there."
      : "Index of the shared source file:\n" + await criticismIndex([...project(record).sources.values()], reader))
    : phase === "instruction" ? "file_evidence takes the sourceId and blockIds you read with read_source; the host fills in the title and the passage. unify_evidence takes no groups: the host groups by canonical identity." : "";
  const task = `${JSON.stringify(spec)}\n${instruction}\n${note}`;
  // The system prompt and the task of each turn go to case.jsonl, which
  // translates them into the case language. Their times are checkpointed, so a
  // retry writes the same records.
  const prompt = injected ? injected.prompt : saveCaseAuditRecord;
  const recordPrompts = async (phaseSession: PhaseSession, turn: PhaseTurn) => {
    if (!prompt) return;
    const { state } = phaseSession;
    const base = { schemaVersion: 2, kind: "prompt", seat, phase, modelId: model.id, effort: modelEffort(model) };
    const data = { sessionId: state.id, channel: state.channel };
    const system = `prompt:${state.id}:system`, turnPrompt = `prompt:${state.id}:${turn.id}`;
    await prompt(caseId, system, { ...base, id: system, at: state.createdAt, data: { ...data, role: "system", sequence: 0, text: state.system } });
    await prompt(caseId, turnPrompt, { ...base, id: turnPrompt, at: turn.startedAt, data: { ...data, role: "task", turnId: turn.id, spec, sequence: turn.start - 1, text: [instruction, note].filter(Boolean).join("\n") } });
  };

  const preparation = await PhaseSession.open(caseId, { phase, seat, channel: "preparation", model,
    system: phaseSystem(phase, seat, docket.language, "preparation", native), tools: JSON.stringify(native ? nativePreparationDefinitions(phase, model.id) : preparationDefinitions(phase)), initial }, injected?.repository);
  const prepTurn = await preparation.begin(id, record, task);
  await recordPrompts(preparation, prepTurn);
  let draft = prepTurn.draft ?? "";
  if (!prepTurn.complete) {
    const prepared = await (injected?.prepare ?? advancePreparation)(preparation);
    if (prepared === undefined) return undefined;
    draft = prepared;
    if (!prepTurn.complete) { prepTurn.draft = draft; await preparation.finish(); }
  }
  const names = phaseActions(phase, seat, native);
  const sourceTools = native ? [] : sourceToolsFor(phase);
  const schemas = typed ? { output: z.toJSONSchema(typed.schema, { target: "draft-7" }) }
    : Object.fromEntries([...sourceTools.map((name) => [name, z.toJSONSchema(SourceToolSchemas[name], { target: "draft-7" })]), ...names.map((name) => [name, z.toJSONSchema(CourtActionSchemas[name], { target: "draft-7" })])]);
  const session = await PhaseSession.open(caseId, { phase, seat, channel: "decision", model,
    system: phaseSystem(phase, seat, docket.language, "decision", native), tools: JSON.stringify(schemas), initial }, injected?.repository);
  // A pipeline 3 instruction report quotes its sources verbatim, in their own
  // language: translated, its quotes would no longer match the sources. A
  // report whose translation fails is kept in its own language.
  const normalizedDraft = !draft ? "" : phase === "instruction" && typed ? draft : (await normalizeOrKeep(reader, "", draft)).body;
  const draftPath = `${phase === "debate" ? "discussion" : "instruction/runs"}/${seat}/${id}/draft.md`;
  if (normalizedDraft) await artifacts.write(caseId, new Map([[draftPath, normalizedDraft]]));
  const turn = await session.begin(id, record, JSON.stringify({ task, preparation: normalizedDraft }), typed ? TYPED_TURN_MS : undefined);
  await recordPrompts(session, turn);
  if (turn.complete) return { events: turn.events, done: turn.done };
  const actions = createCourtActions(docket, spec, [...record, ...turn.events], reader, corpus, native);
  let pending = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => { const result = pending.then(run); pending = result.then(() => {}, () => {}); return result; };
  const tools: ToolSet = {};
  for (const name of sourceTools) tools[name] = {
    description: name, inputSchema: SourceToolSchemas[name],
    execute: (input, options) => executeSourceTool({ tool: name, input, callId: options.toolCallId }, { record: stored, events: record as RecordedEvent[], phase, seat, turnId: id, reader, artifacts, worker: injected?.worker, activity }),
  };
  if (!typed) for (const name of names) tools[name] = {
    description: name, inputSchema: CourtActionSchemas[name],
    execute: (input: unknown, options: { toolCallId: string }) => serialize(async () => {
      const signature = JSON.stringify([name, input]);
      const previous = turn.results[options.toolCallId];
      if (previous) { if (previous.input !== signature) throw new Error("Court tool-call ID was reused"); return previous.output; }
      const first = actions.plan.produced.length;
      const output = await actions.run(name, input);
      turn.events.push(...actions.plan.produced.slice(first));
      turn.done = actions.plan.done();
      turn.results[options.toolCallId] = { input: signature, output };
      await session.save();
      return output;
    }),
  };
  const more = () => (!turn.done || turn.inFlightStep) && turn.steps < 20 && Date.now() < Date.parse(turn.expiresAt);
  const stepRoot = (step: number) => `${phase === "debate" ? "discussion" : "instruction/runs"}/${seat}/${id}/decision-${step}`;
  try {
    if (typed && turn.answer) {
      // The typed answer of the last generation, recorded in a unit of its own.
      const { step, output, error } = turn.answer;
      let feedback: string;
      const again = " Answer again with your whole answer in the requested format.";
      if (error) feedback = "Your answer did not match the requested format (" + error + ")." + again;
      else {
        const { input, dropped } = typed.input(output);
        const first = actions.plan.produced.length;
        // The schema errors of the action, which it reports only as unavailable.
        const checked = CourtActionSchemas[typed.action].safeParse(input);
        const result = checked.success ? await actions.run(typed.action, input)
          : { error: checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
        turn.events.push(...actions.plan.produced.slice(first));
        turn.done = actions.plan.done();
        turn.results[`answer-${step}`] = { input: JSON.stringify(input), output: { result, dropped } };
        await artifacts.write(caseId, new Map([[`${stepRoot(step)}/${typed.artifact}`, JSON.stringify({ result, dropped })]]));
        // A partial source review keeps its votes: the retry names the sources
        // still missing, and the seat votes on those only.
        const notRecorded = dropped.length ? " Not recorded: " + dropped.map(({ proposal, reason }) => ((proposal as { sourceId?: string }).sourceId ?? (proposal as { url?: string }).url) + " (" + reason + ")").join("; ") + "." : "";
        feedback = typeof result !== "string" ? "The host could not record your answer: " + result.error + "." + again : turn.done ? "" : result + notRecorded;
      }
      delete turn.answer;
      if (feedback && !turn.done && more()) session.state.messages.push({ role: "user", content: feedback });
      await session.save();
      // A new answer, if any, is generated in a step of its own.
      if (more()) return undefined;
    }
    if (more()) {
      const stage = !typed ? "tools" : turn.reasoned ? "typed" : "reasoning";
      const stepId = turn.inFlightStep ?? `decision:${session.state.id}:${id}:${turn.steps}`;
      turn.inFlightStep = stepId;
      await session.save();
      const result = await reader.hostStage(stepId, "decision-generation", async () => {
        const root = stepRoot(turn.steps);
        const requestPath = `${root}/request.json`, resultPath = `${root}/result.json`;
        // The typed answer only copies the decision already reasoned: no thinking,
        // or the least the model allows (Claude Opus cannot turn it off).
        const reasoning = stage === "typed" ? { providerOptions: withoutEffort(session.state.model.providerOptions), reasoning: "none" as const } : { providerOptions: session.state.model.providerOptions };
        const maxOutputTokens = courtMaxOutputTokens(courtOutputPhase(phase));
        const request = JSON.stringify({ modelId: model.id, maxOutputTokens, ...reasoning, system: session.state.system, messages: session.state.messages, ...(stage === "typed" ? { output: schemas.output } : stage === "tools" ? { tools: schemas } : {}) });
        const common = { model: injected?.model ?? gateway(model.id), ...reasoning,
          system: session.state.system, messages: session.state.messages, maxOutputTokens, stopWhen: stepCountIs(1), maxRetries: 0,
          abortSignal: AbortSignal.timeout(Math.max(1, Math.min(stage === "reasoning" ? REASONING_GENERATION_MS : DECISION_GENERATION_MS, Date.parse(turn.expiresAt) - Date.now()))) };
        let typedAnswer: { output?: unknown; error?: string } | undefined;
        let answer: { messages: ModelMessage[]; usage: unknown; toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown }> };
        if (stage === "reasoning") {
          // The decision in prose, with the model's own thinking and no format.
          const generated = await generateText(common);
          answer = { messages: generated.responseMessages, usage: generated.usage, toolCalls: [] };
        } else if (stage === "typed") {
          try {
            const generated = await generateText({ ...common, output: Output.object({ schema: typed!.schema }) });
            typedAnswer = { output: generated.output };
            answer = { messages: generated.responseMessages, usage: generated.usage, toolCalls: [{ toolName: typed!.action, toolCallId: `output-${turn.steps}`, input: typedAnswer.output }] };
          } catch (error) {
            // An answer that does not parse is the seat's to correct, not a failure of the step.
            if (!NoObjectGeneratedError.isInstance(error)) throw error;
            const cause = error.cause instanceof Error ? " " + error.cause.message : "";
            typedAnswer = { error: (error.message + cause).slice(0, 300) };
            answer = { messages: [{ role: "assistant", content: error.text || "(no answer)" }], usage: error.usage, toolCalls: [] };
          }
        } else {
          const generated = await generateText({ ...common, tools, toolChoice: "required" });
          // AI SDK 7 accumulates all assistant/tool messages here, not on finalStep.
          answer = { messages: generated.responseMessages, usage: generated.usage, toolCalls: generated.toolCalls.map(({ toolName, toolCallId, input }) => ({ toolName, toolCallId, input })) };
        }
        const result = { ...answer, at: new Date().toISOString(), ...(typedAnswer ? { typedAnswer } : {}) };
        await artifacts.write(caseId, new Map([[requestPath, request], [resultPath, JSON.stringify(result)]]));
        return { ...result, requestPath, resultPath };
      });
      await audit(caseId, stepId, { schemaVersion: 2, id: `step:${stepId}`, kind: "model_step", at: result.at, seat, phase, modelId: model.id, effort: modelEffort(model), data: { sessionId: session.state.id, turnId: id, channel: "decision", sequence: session.state.messages.length, step: turn.steps, usage: result.usage, toolCalls: result.toolCalls, request: result.requestPath, result: result.resultPath } });
      delete turn.inFlightStep;
      if (result.typedAnswer) turn.answer = { step: turn.steps, ...result.typedAnswer };
      // After the reasoning answer, the same conversation asks for its typed form.
      const reasoned = stage === "reasoning";
      if (reasoned) turn.reasoned = true;
      await session.append([...result.messages as ModelMessage[], ...(reasoned ? [{ role: "user" as const, content: typed!.request }] : [])]);
      // The next generation, or the recording of this answer, runs in a step of its own.
      if (turn.answer || more()) return undefined;
    }
    if (turn.inFlightStep) throw new Error("Uncheckpointed model step blocks phase continuation");
    await session.finish();
    return { events: turn.events, done: turn.done };
  } finally {
    if (session.state.activeTurn) { delete session.state.activeTurn; await session.save(); }
  }
}
