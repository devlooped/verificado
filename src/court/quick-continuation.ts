import { z } from "zod";
import { checkType, COUNSEL, majority, VERDICTS, type ModelSnapshot, type PipelineVersion, type RecordedEvent, type Submission } from "../domain/court.ts";
import { continuationHash, continuationJson, type ContinuationCheckpoint } from "../domain/continuation.ts";

export const QUICK_CONSENSUS_UNIT = "quick.content-consensus";
const stamp = { seq: z.number().int().positive(), at: z.iso.datetime() };
const counselModels = z.object({ grok:z.string().min(1), gemini:z.string().min(1), claude:z.string().min(1), chatgpt:z.string().min(1) }).strict();
const counselEfforts = z.object({ grok:z.string().nullable(), gemini:z.string().nullable(), claude:z.string().nullable(), chatgpt:z.string().nullable() }).strict();
const opening = z.object({ ...stamp, type:z.literal("session_opened"), judgeModel:z.string().min(1), counselModels, judgeEffort:z.string().nullable().optional(), counselEfforts:counselEfforts.optional(), simulated:z.boolean().optional() }).strict();
const answer = z.object({ ...stamp, type:z.literal("quick_response"), by:z.enum(COUNSEL), text:z.string().min(1), sources:z.array(z.object({url:z.string().url(),title:z.string().optional()}).strict()), modelId:z.string().optional(), effort:z.string().nullable().optional() }).strict();
const vote = z.object({ ...stamp, type:z.literal("content_vote"), by:z.enum(COUNSEL), verdict:z.enum(VERDICTS), rationale:z.string().trim().min(10) }).strict();

export type QuickConsensusContext = { submission:Submission; pipeline:PipelineVersion; models:ModelSnapshot; runId:string };
export type ContinuationPhasePublication = { key:string; revision:number; body:unknown };
export type QuickConsensusCursor = { schemaVersion:1; unit:typeof QUICK_CONSENSUS_UNIT; prefixHash:string; nextSeq:12; verdict:(typeof VERDICTS)[number] };

// One proved PURE unit only: four complete, ordered content votes with a
// three-vote majority, Quick 5 without identified claims. Not an importer or a
// proof that the analysts/artifacts are recoverable. No bench/provider is used.
export function quickContentConsensusPublication(context:QuickConsensusContext, prefix:readonly RecordedEvent[]) {
  if (context.pipeline !== 5 || context.submission.kind !== "text" || checkType(context.submission) !== "quick" || context.submission.identifyClaims || !context.runId.trim() || prefix.length !== 9) throw new Error("Quick consensus route blocked: exact supported prefix required");
  const opened = opening.parse(prefix[0]);
  if (context.models.judge?.id !== opened.judgeModel || context.models.judge.effort !== (opened.judgeEffort ?? null)) throw new Error("Quick consensus model mismatch");
  const votes = COUNSEL.map((by,index) => {
    const response = answer.parse(prefix[index+1]);
    const ballot = vote.parse(prefix[index+5]);
    const model = context.models[`counsel.${by}`];
    if (response.by !== by || ballot.by !== by || model?.id !== opened.counselModels[by] || model.effort !== (opened.counselEfforts?.[by] ?? null) ||
        (response.modelId !== undefined && (response.modelId !== model.id || (response.effort ?? null) !== model.effort))) throw new Error("Quick consensus seat/model mismatch");
    return ballot.verdict;
  });
  if (prefix.some((event,index)=>event.seq !== index+1)) throw new Error("Quick consensus prefix gap");
  const verdict = majority(votes);
  if (!verdict) throw new Error("Quick consensus route blocked: tiebreak not proved");
  const prefixHash = continuationHash(prefix);
  const result:QuickConsensusCursor = {schemaVersion:1,unit:QUICK_CONSENSUS_UNIT,prefixHash,nextSeq:12,verdict};
  const checkpoint:ContinuationCheckpoint = {unit:QUICK_CONSENSUS_UNIT,kind:QUICK_CONSENSUS_UNIT,pipeline:5,format:1,state:"ready",sourceRunId:context.runId,inputHash:continuationHash({submission:context.submission,models:context.models,pipeline:5,format:1,prefix}),result,resultHash:continuationHash(result)};
  // Stable timestamps are derived from the validated prefix, never the clock.
  const at = prefix[8].at;
  const events:RecordedEvent[] = [{type:"content_judgment",verdict,method:"consensus",reasoning:"",seq:10,at},{type:"session_closed",seq:11,at}];
  const phase:ContinuationPhasePublication = {key:QUICK_CONSENSUS_UNIT,revision:-1,body:result};
  return {checkpoint,events,phase};
}

// Restore only after the exact atomic suffix is durable; never synthesize a
// missing vote/response, restart the bench, or infer completion from counts.
export function restoreQuickContentConsensusCursor(context:QuickConsensusContext, current:readonly RecordedEvent[], checkpoint:ContinuationCheckpoint):QuickConsensusCursor {
  if (current.length !== 11) throw new Error("Quick consensus cursor blocked: publication incomplete");
  const expected = quickContentConsensusPublication(context,current.slice(0,9));
  validateQuickContentConsensusPublication(context,current,checkpoint,expected.events,expected.phase);
  return structuredClone(expected.checkpoint.result) as QuickConsensusCursor;
}

export function validateQuickContentConsensusPublication(context:QuickConsensusContext, current:readonly RecordedEvent[], checkpoint:ContinuationCheckpoint, events:readonly RecordedEvent[], phase?:ContinuationPhasePublication):void {
  const expected = quickContentConsensusPublication(context,current.slice(0,9));
  if (current.length !== 9 && (current.length !== 11 || continuationJson(current.slice(9)) !== continuationJson(expected.events))) throw new Error("Quick consensus prefix/suffix collision");
  if (continuationJson({checkpoint,events,phase:phase ?? null}) !== continuationJson(expected)) throw new Error("Quick consensus checkpoint/cursor collision");
}
