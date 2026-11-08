import { illustrateCase, liveCoverDeps, type CoverModels } from "../court/cover.ts";
import { loadModels } from "../court/model-config.ts";
import { counselModels, courtModel, DEFAULT_MODELS, MOCK_MODEL_ID, modelEffort, modelSnapshot, seatModel, type CourtModel, type ModelConfig } from "../court/models.ts";
import { playTurn } from "../court/play.ts";
import { resolveCaseLanguage } from "../court/language.ts";
import { holdSession } from "../court/procedure.ts";
import { holdQuickSession, type QuickAnswer, type QuickEntry, type QuickFailure, type QuickMajority } from "../court/quick.ts";
import { quickAnswer, quickIdentifyClaims, quickSummarize, quickTiebreak, quickVote, simulatedQuickDependencies } from "../court/quick-play.ts";
import type { Docket, TurnOutcome, TurnSpec } from "../court/turns.ts";
import { checkType, sharedPipeline, type CaseRecord, type Claim, type Counsel, type CourtEvent, type RecordedEvent, type Submission, type SubmissionContext } from "../domain/court.ts";
import { languageRule } from "../domain/language.ts";
import { collectEvidenceBase } from "../evidence/collect.ts";
import { imageDescriber } from "../evidence/describe.ts";
import { liveContributionDeps, saveContributedSources } from "../evidence/contributions.ts";
import { translateFiledEvidence, translatorFor } from "../evidence/translate.ts";
import { archiveEvidence, casePromptLocalization } from "../evidence/archive.ts";
import { cachePromptTranslations } from "../evidence/prompt-translation.ts";
import { blobConfigured, caseArtifactStore } from "../evidence/blob.ts";
import { runEvidenceStep, type EvidenceStepResult } from "../evidence/sandbox.ts";
import type { EvidenceSeat, EvidenceStage } from "../evidence/schema.ts";
import { closeCase, openCase, saveEvents } from "./steps.ts";
import { getCase, getCaseAuditRecords, getImage, recordCaseToolActivity, revokeSandboxBindings, saveCaseAuditRecord, saveCaseLanguage, saveCaseModels } from "../store.ts";
import { collectEvidence, fetchProposedUrls, rejectionRecord, type FetchedUrl } from "../instruction/collection.ts";
import { COLLECTION_BATCH, collectProposedBatches, proposedUrls } from "../instruction/proposed-urls.ts";
import { collectInstruction } from "../instruction/intake.ts";
import { fatalSourceFailure, liveSourceDependencies, SourceService } from "../instruction/sources.ts";
import { sourceDownloader } from "../instruction/research.ts";
import { mockInstructionArtifacts, mockInstructionSources, mockResearchWorker } from "../instruction/mock.ts";
import { createMockSeat } from "../court/mock.ts";
import { advanceSharedTurn } from "../court/settled-play.ts";
import { settleEvidence } from "../evidence/settled.ts";
import { caseSourceService } from "../instruction/proxy.ts";
import { deleteCaseSandboxes } from "../instruction/preparation.ts";
import { caseLog, errorFields, observeCaseStep } from "../lib/case-telemetry.ts";
import { sha256 } from "../evidence/validate.ts";

// One snapshot per session: every turn uses, and the case records, the same models.
async function configuredModels(caseId: string, shared = false): Promise<ModelConfig> {
  "use step";
  return observeCaseStep(caseId, "configure_models", {}, async () => {
    if (shared) {
      const stored = await getCase(caseId);
      if (stored?.models) return Object.fromEntries(Object.entries(stored.models).map(([role, model]) => [role, courtModel(model.id, model.effort)])) as ModelConfig;
    }
    const models = await loadModels();
    await saveCaseModels(caseId, modelSnapshot(models));
    return models;
  });
}

async function collectShared(caseId: string, submission: Submission, simulated: boolean, models: ModelConfig) {
  "use step";
  return observeCaseStep(caseId, "intake_collection", {}, async () => {
    const sources = simulated ? mockInstructionSources : liveSourceDependencies(models.translator, caseId);
    if (!simulated) sources.download = sourceDownloader(models["research.x"], caseId);
    try {
      return await collectInstruction(caseId, submission, models, simulated, {
        sources, artifacts: simulated ? mockInstructionArtifacts : caseArtifactStore, getImage, saveLanguage: saveCaseLanguage, detect: resolveCaseLanguage,
        ...(simulated ? { describe: async () => ({ text: "SIMULACIÓN LOCAL: Imagen ficticia para el procedimiento.", tool: "fixture", confidence: 1 }) } : {}),
      });
    } catch (error) { throw fatalSourceFailure(error); }
  });
}

// One unit of a shared turn: a preparation call or a decision generation. The
// workflow loops over units, so no step lasts as long as the whole turn.
async function advanceShared(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome | null> {
  "use step";
  return observeCaseStep(caseId, "advance_turn", { "turn.kind": spec.kind, "turn.seat": "counsel" in spec ? spec.counsel : "speaker" in spec ? spec.speaker : "judge", "turn.attempt": attempt }, async () => {
    const stored = await getCase(caseId);
    if (!stored) throw new Error("Shared case unavailable");
    let outcome: TurnOutcome | undefined;
    try {
      outcome = await advanceSharedTurn(caseId, docket, spec, record, attempt, docket.simulated ? {
        record: stored, reader: new SourceService(caseId, docket.language!, mockInstructionSources), artifacts: mockInstructionArtifacts,
        model: createMockSeat({ spec, record, submission: docket.submission, shared: true, native: stored.pipelineVersion === 3 || stored.pipelineVersion === 4 || stored.pipelineVersion === 5 }, false).model,
        prepare: async () => "SIMULACIÓN LOCAL: Análisis preparatorio ficticio; no agrega pruebas.", worker: mockResearchWorker,
        audit: async () => {}, activity: recordCaseToolActivity,
      } : undefined);
    } catch (error) { throw fatalSourceFailure(error); }
    caseLog(caseId, outcome && !outcome.done ? "warn" : "info", outcome ? "case.turn.finished" : "case.turn.pending", { "turn.kind": spec.kind, "turn.seat": "counsel" in spec ? spec.counsel : "speaker" in spec ? spec.speaker : "judge", "turn.done": outcome?.done ?? false });
    return outcome ? linkEvidenceRun(outcome, undefined, docket.simulated, docket.models) : null;
  });
}

// A turn makes progress or spends its time budget at every unit; this bound
// only stops a defect from looping without end.
const MAX_TURN_UNITS = 100;

async function playShared(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome> {
  for (let unit = 0; unit < MAX_TURN_UNITS; unit++) {
    const outcome = await advanceShared(caseId, docket, spec, record, attempt);
    if (outcome) return outcome;
  }
  throw new Error("Shared turn did not finish within " + MAX_TURN_UNITS + " steps");
}

async function settleShared(caseId: string, language: string, events: readonly RecordedEvent[], simulated: boolean) {
  "use step";
  return observeCaseStep(caseId, "settle_evidence", {}, async () => {
    await revokeSandboxBindings(caseId);
    const stored = await getCase(caseId);
    if (!stored) throw new Error("Shared case unavailable");
    try {
      return await settleEvidence(caseId, language, events, simulated ? new SourceService(caseId, language, mockInstructionSources) : caseSourceService(stored), simulated ? mockInstructionArtifacts : caseArtifactStore);
    } catch (error) { throw fatalSourceFailure(error); }
  });
}

function collectionReader(caseId: string, language: string, simulated: boolean, stored: CaseRecord) {
  return simulated ? new SourceService(caseId, language, mockInstructionSources) : caseSourceService(stored);
}

// Native collection: a few proposed URLs per step, then one step that
// matches the quotes and files the evidence.
async function fetchProposals(caseId: string, language: string, urls: string[], simulated: boolean, batch?: number, batches?: number): Promise<FetchedUrl[]> {
  "use step";
  const batchAttributes: Record<string, number> = batch === undefined ? {} : { "sources.batch": batch, "sources.batches": batches! };
  return observeCaseStep(caseId, "fetch_proposals", { "sources.count": urls.length, ...batchAttributes }, async () => {
    const stored = await getCase(caseId);
    if (!stored) throw new Error("Shared case unavailable");
    try {
      const fetched = await fetchProposedUrls(collectionReader(caseId, language, simulated, stored), urls, undefined, (url, state, duration, errorCode) => {
        caseLog(caseId, state === "failed" || state === "error" ? "warn" : "info", `case.source.${state}`, {
          "source.url_hash": sha256(url), "duration.ms": duration,
          ...(errorCode && /^[\w.-]{1,80}$/.test(errorCode) ? { "error.code": errorCode } : {}),
        });
      });
      const failed = fetched.filter((item) => item.error).length;
      caseLog(caseId, failed ? "warn" : "info", "case.sources.fetched", { ...batchAttributes, "sources.count": fetched.length, "sources.failed": failed });
      return fetched;
    } catch (error) { throw fatalSourceFailure(error); }
  });
}

async function collectProposals(caseId: string, language: string, events: readonly RecordedEvent[], fetched: FetchedUrl[], simulated: boolean): Promise<CourtEvent[]> {
  "use step";
  return observeCaseStep(caseId, "file_proposals", { "sources.count": fetched.length }, async () => {
    const stored = await getCase(caseId);
    if (!stored) throw new Error("Shared case unavailable");
    const collected = await collectEvidence(events, fetched, collectionReader(caseId, language, simulated, stored));
    caseLog(caseId, collected.rejected.length ? "warn" : "info", "case.proposals.filed", { "proposals.rejected": collected.rejected.length, "evidence.filed": collected.events.filter((event) => event.type === "evidence_filed").length });
    if (!simulated) for (const proposal of collected.rejected) { const record = rejectionRecord(proposal); await saveCaseAuditRecord(caseId, record.id, record); }
    return collected.events;
  });
}

async function collectProposedEvidence(caseId: string, language: string, events: readonly RecordedEvent[], simulated: boolean, progress?: (event: Extract<CourtEvent, { type: "source_collection_started" | "source_batch_started" | "source_batch_completed" }>) => Promise<void>, showUrls = false): Promise<CourtEvent[]> {
  let fetched: FetchedUrl[];
  if (progress) fetched = await collectProposedBatches(events, (urls, batch, batches) => fetchProposals(caseId, language, urls, simulated, batch, batches), progress, showUrls);
  else {
    // Keep version 3's workflow step sequence unchanged for replay.
    const urls = proposedUrls(events);
    fetched = [];
    for (let start = 0; start < urls.length; start += COLLECTION_BATCH) fetched.push(...await fetchProposals(caseId, language, urls.slice(start, start + COLLECTION_BATCH), simulated));
  }
  return collectProposals(caseId, language, events, fetched, simulated);
}

async function revokeShared(caseId: string) {
  "use step";
  await observeCaseStep(caseId, "revoke_sandboxes", {}, () => revokeSandboxBindings(caseId));
}

// Case files are in storage by now; the VMs and their snapshots are not needed.
// Never fail a case over cleanup: snapshot retention and expiry bound the rest.
async function disposeSandboxes(caseId: string) {
  "use step";
  await observeCaseStep(caseId, "dispose_sandboxes", {}, async () => {
    try { await deleteCaseSandboxes(caseId); }
    catch (error) { caseLog(caseId, "warn", "case.sandboxes.cleanup_failed", errorFields(error)); }
  });
}

async function collect(caseId: string, submission: Submission, simulated: boolean, describer: CourtModel) {
  "use step";
  return observeCaseStep(caseId, "intake_collection", {}, async () => {
    const describe = !simulated && submission.kind === "image" ? imageDescriber(describer, submission.note, caseId) : undefined;
    return collectEvidenceBase(caseId, submission, simulated, describe);
  });
}

async function determineLanguage(caseId: string, submission: Submission, context: SubmissionContext | undefined, simulated: boolean, model: CourtModel): Promise<string> {
  "use step";
  return observeCaseStep(caseId, "detect_language", {}, async () => {
    const language = await resolveCaseLanguage(caseId, submission, context, simulated, undefined, model);
    if (!submission.resolvedLanguage) await saveCaseLanguage(caseId, language);
    return language;
  });
}

// Keep source processing separate from the paid court turn so a retry need not
// repeat the analyst's model call.
async function collectSources(caseId: string, events: CourtEvent[], language: string, translator: CourtModel): Promise<void> {
  "use step";
  await observeCaseStep(caseId, "collect_sources", {}, async () => {
    if (blobConfigured()) await saveContributedSources(caseId, events, language, liveContributionDeps(translator, caseId));
  });
}

async function translateContributions(caseId: string, outcome: TurnOutcome, language: string, translator: CourtModel): Promise<TurnOutcome> {
  "use step";
  return observeCaseStep(caseId, "translate_contributions", {}, async () => ({ ...outcome, events: await translateFiledEvidence(outcome.events, language, translatorFor(translator, caseId)) }));
}

// case.jsonl translates the prompts of the case into its language. A few new
// translations per step, saved in the database cache, so the archive step only
// reads them. Says whether some are still missing.
const PROMPT_TRANSLATIONS_PER_STEP = 8;
const MAX_PROMPT_TRANSLATION_STEPS = 50;

async function translatePrompts(caseId: string): Promise<boolean> {
  "use step";
  return observeCaseStep(caseId, "translate_prompts", {}, async () => {
    const stored = await getCase(caseId);
    if (!blobConfigured() || !stored) return false;
    const { language, cache, translate, modelId } = casePromptLocalization(stored);
    const { missing } = await cachePromptTranslations(await getCaseAuditRecords(caseId), language, cache, translate, modelId, PROMPT_TRANSLATIONS_PER_STEP);
    caseLog(caseId, "info", "case.prompt_translations.progress", { "translations.remaining": missing });
    return missing > 0;
  });
}

async function archive(caseId: string): Promise<void> {
  "use step";
  await observeCaseStep(caseId, "archive", {}, async () => { if (blobConfigured()) await archiveEvidence(caseId); });
}

// A missing cover never fails a case: the home page shows a placeholder instead.
async function illustrate(caseId: string, simulated: boolean, models: CoverModels): Promise<void> {
  "use step";
  if (simulated) return;
  await observeCaseStep(caseId, "cover", {}, async () => {
    try { await illustrateCase(caseId, liveCoverDeps(models, caseId)); }
    catch (err) { caseLog(caseId, "warn", "case.cover.failed", errorFields(err)); }
  });
}

async function play(
  caseId: string,
  docket: Docket,
  spec: TurnSpec,
  record: readonly CourtEvent[],
  attempt: number,
  evidence?: EvidenceStepResult
) {
  "use step";
  return observeCaseStep(caseId, "play_turn", { "turn.kind": spec.kind, "turn.seat": "counsel" in spec ? spec.counsel : "speaker" in spec ? spec.speaker : "judge", "turn.attempt": attempt }, async () => {
    const outcome = await playTurn(caseId, docket, spec, record, attempt, evidence);
    if (!outcome.done) caseLog(caseId, "warn", "case.turn.incomplete", { "turn.kind": spec.kind, "turn.attempt": attempt });
    return linkEvidenceRun(outcome, evidence?.runId, docket.simulated, docket.models);
  });
}

export function linkEvidenceRun(outcome: TurnOutcome, runId?: string, simulated = false, models: ModelConfig = DEFAULT_MODELS): TurnOutcome {
  return { ...outcome, events: outcome.events.map((event) => event.type === "statement" ? {
    ...event, modelId: simulated ? MOCK_MODEL_ID : seatModel(models, event.by).id, effort: simulated ? null : modelEffort(seatModel(models, event.by)), ...(runId ? { evidenceRunId: runId } : {}),
  } : event) };
}

function evidenceTask(spec: TurnSpec, targetLanguage: string): { seat: EvidenceSeat; stage: EvidenceStage; task: string } | undefined {
  const language = languageRule(targetLanguage) + "\n\n";
  if (spec.kind === "instruction") {
    return { seat: spec.counsel, stage: "exposicion", task: language + "Examine the base case file and produce neutral passages and a draft argument for the statement." };
  }
  if (spec.kind === "statement") {
    return { seat: spec.counsel, stage: spec.stage === "opening" ? "exposicion" : "objecion", task: language + "Prepare passages and a draft argument for this intervention, checking any passage from another seat against the original file." };
  }
  if (spec.kind === "objection") {
    return { seat: spec.counsel, stage: "objecion", task: language + "Review the base material and the passages of the other seats to find evidence that supports or refutes an objection." };
  }
  if (spec.kind === "closing") {
    return { seat: spec.counsel, stage: "conclusion", task: language + "Prepare a synthesis of the evidence and a draft conclusion, pointing out limits and contradictions." };
  }
}

async function prepareEvidence(caseId: string, spec: TurnSpec, simulated: boolean, language: string, models: ModelConfig): Promise<EvidenceStepResult | undefined> {
  const request = evidenceTask(spec, language);
  if (!request) return undefined;
  return runEvidenceStep(caseId, request.seat, request.stage, request.task, simulated, language, { seat: seatModel(models, request.seat), translator: models.translator });
}

// A Quick check: one step per generation, so a completed paid answer is not
// paid again when the workflow replays.
async function identifyQuick(caseId: string, submission: Submission, language: string, model: CourtModel, attempt: number, simulated: boolean) {
  "use step";
  return observeCaseStep(caseId, "quick_claims", { "turn.attempt": attempt }, async () => {
    const result = await quickIdentifyClaims(caseId, submission, language, model, attempt, simulated ? simulatedQuickDependencies("claims") : undefined);
    if ("error" in result) caseLog(caseId, "warn", "case.quick.failed", { "turn.kind": "claims", "turn.attempt": attempt });
    return result;
  });
}

async function answerQuick(caseId: string, submission: Submission, language: string, model: CourtModel, by: Counsel, attempt: number, simulated: boolean, claims?: readonly Claim[]) {
  "use step";
  return observeCaseStep(caseId, "quick_answer", { "turn.seat": by, "turn.attempt": attempt }, async () => {
    const result = await quickAnswer(caseId, submission, language, model, by, attempt, simulated ? simulatedQuickDependencies("answer") : undefined, claims);
    if ("error" in result) caseLog(caseId, "warn", "case.quick.failed", { "turn.kind": "answer", "turn.seat": by, "turn.attempt": attempt });
    return result;
  });
}

async function voteQuick(caseId: string, submission: Submission, language: string, model: CourtModel, by: Counsel, answer: QuickAnswer, attempt: number, retry: QuickFailure | undefined, simulated: boolean, claim?: Claim) {
  "use step";
  return observeCaseStep(caseId, "quick_vote", { "turn.seat": by, "turn.attempt": attempt }, async () => {
    const result = await quickVote(caseId, submission, language, model, by, answer, attempt, retry, simulated ? simulatedQuickDependencies("vote") : undefined, claim);
    if ("error" in result) caseLog(caseId, "warn", "case.quick.failed", { "turn.kind": "vote", "turn.seat": by, "turn.attempt": attempt });
    return result;
  });
}

async function tiebreakQuick(caseId: string, submission: Submission, language: string, model: CourtModel, entries: QuickEntry[], attempt: number, simulated: boolean, claim?: Claim) {
  "use step";
  return observeCaseStep(caseId, "quick_tiebreak", { "turn.attempt": attempt }, async () => {
    const result = await quickTiebreak(caseId, submission, language, model, entries, attempt, simulated ? simulatedQuickDependencies("tiebreak") : undefined, claim);
    if ("error" in result) caseLog(caseId, "warn", "case.quick.failed", { "turn.kind": "tiebreak", "turn.attempt": attempt });
    return result;
  });
}

async function summarizeQuick(caseId: string, language: string, model: CourtModel, majorities: QuickMajority[], attempt: number, simulated: boolean) {
  "use step";
  return observeCaseStep(caseId, "quick_summary", { "turn.attempt": attempt }, async () => {
    const result = await quickSummarize(caseId, language, model, majorities, attempt, simulated ? simulatedQuickDependencies("summary") : undefined);
    if ("error" in result) caseLog(caseId, "warn", "case.quick.failed", { "turn.kind": "summary", "turn.attempt": attempt });
    return result;
  });
}

function describeError(err: unknown): string {
  const message = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return message.slice(0, 500);
}

export async function courtSession(caseId: string, latestPipeline = false, quickMajoritySummary = false): Promise<void> {
  "use workflow";
  let shared = false;
  try {
    // Preserve the original step invocation for already-running workflows.
    const { submission, today, simulated, pipelineVersion } = latestPipeline ? await openCase(caseId, true) : await openCase(caseId);
    shared = sharedPipeline(pipelineVersion);
    const models = await configuredModels(caseId, shared);
    const counsel = counselModels(models);
    const effort = (model: CourtModel) => simulated ? null : modelEffort(model);
    const seats = {
      models: { judge: models.judge.id, counsel: { grok: counsel.grok.id, gemini: counsel.gemini.id, claude: counsel.claude.id, chatgpt: counsel.chatgpt.id } },
      efforts: { judge: effort(models.judge), counsel: { grok: effort(counsel.grok), gemini: effort(counsel.gemini), claude: effort(counsel.claude), chatgpt: effort(counsel.chatgpt) } },
    };
    if (checkType(submission) === "quick") {
      // Optional claim identification, but no instruction or sandbox (nothing
      // to revoke on failure): each analyst researches once and votes.
      shared = false;
      const language = await determineLanguage(caseId, submission, undefined, simulated, models.language);
      await holdQuickSession({
        submission, simulated, ...seats,
        identify: (attempt) => identifyQuick(caseId, submission, language, models.judge, attempt, simulated),
        answer: (by, attempt, claims) => submission.identifyClaims ? answerQuick(caseId, submission, language, counsel[by], by, attempt, simulated, claims) : answerQuick(caseId, submission, language, counsel[by], by, attempt, simulated),
        vote: (by, answer, attempt, retry, claim) => claim ? voteQuick(caseId, submission, language, counsel[by], by, answer, attempt, retry, simulated, claim) : voteQuick(caseId, submission, language, counsel[by], by, answer, attempt, retry, simulated),
        tiebreak: (entries, attempt, claim) => claim ? tiebreakQuick(caseId, submission, language, models.judge, entries, attempt, simulated, claim) : tiebreakQuick(caseId, submission, language, models.judge, entries, attempt, simulated),
        ...(quickMajoritySummary ? { summarize: (majorities: QuickMajority[], attempt: number) => summarizeQuick(caseId, language, models.judge, majorities, attempt, simulated) } : {}),
        commit: (events: readonly RecordedEvent[]) => saveEvents(caseId, [...events]),
      });
      await illustrate(caseId, simulated, models);
      if (!simulated) await archive(caseId);
      await closeCase(caseId, "resolved");
      return;
    }
    const collected = shared ? await collectShared(caseId, submission, simulated, models) : undefined;
    const submissionContext = collected?.context ?? (shared ? undefined : await collect(caseId, submission, simulated, models["image.description"]));
    const language = collected?.language ?? await determineLanguage(caseId, submission, submissionContext, simulated, models.language);
    const docket: Docket = { submission: collected?.submission ?? submission, today, simulated, language, models, ...(submissionContext ? { submissionContext } : {}) };
    await holdSession({
      submission,
      simulated,
      ...seats,
      play: async (spec, record, attempt) => {
        if (shared) return playShared(caseId, docket, spec, record, attempt);
        const evidence = await prepareEvidence(caseId, spec, simulated, language, models);
        let outcome = await play(caseId, docket, spec, record, attempt, evidence);
        if (!simulated && spec.kind === "instruction") {
          outcome = await translateContributions(caseId, outcome, language, models.translator);
          await collectSources(caseId, outcome.events, language, models.translator);
        }
        return outcome;
      },
      commit: (events: readonly RecordedEvent[]) => saveEvents(caseId, [...events]),
      ...(shared ? { settle: (events: readonly RecordedEvent[]) => settleShared(caseId, language, events, simulated) } : {}),
      ...(pipelineVersion === 3 || pipelineVersion === 4 || pipelineVersion === 5 ? { collect: (events: readonly RecordedEvent[], progress: (event: Extract<CourtEvent, { type: "source_collection_started" | "source_batch_started" | "source_batch_completed" }>) => Promise<void>) => collectProposedEvidence(caseId, language, events, simulated, pipelineVersion === 3 ? undefined : progress, pipelineVersion === 5) } : {}),
    });
    await illustrate(caseId, simulated, models);
    if (shared && !simulated) for (let step = 0; step < MAX_PROMPT_TRANSLATION_STEPS && await translatePrompts(caseId); step++);
    if (!shared || !simulated) await archive(caseId);
    if (shared) {
      await revokeShared(caseId);
      await disposeSandboxes(caseId);
    }
    await closeCase(caseId, "resolved");
  } catch (err) {
    if (shared) {
      try { await revokeShared(caseId); }
      catch { /* revokeShared logs its own error; cleanup must not hide the failure. */ }
      await disposeSandboxes(caseId);
    }
    await closeCase(caseId, "failed", describeError(err));
    throw err;
  }
}
