import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNSEL, type ModelSnapshot, type RecordedEvent, type Verdict } from "../domain/court.ts";
import { continuationHash } from "../domain/continuation.ts";
import { holdQuickSession, type QuickBench } from "./quick.ts";
import { quickContentConsensusPublication, restoreQuickContentConsensusCursor, validateQuickContentConsensusPublication, type QuickConsensusContext } from "./quick-continuation.ts";

const at="2026-11-07T12:00:00.000Z";
async function fixture(verdicts:readonly Verdict[]=["falso","falso","falso","verdadero"]) {
  const models:ModelSnapshot={judge:{id:"fixture/judge",effort:null},...Object.fromEntries(COUNSEL.map(by=>[`counsel.${by}`,{id:`fixture/${by}`,effort:null}]))};
  const context:QuickConsensusContext={submission:{kind:"text",check:"quick",text:"Local pure Quick prefix."},pipeline:5,models,runId:"fixture-run"};
  const current:RecordedEvent[]=[];let calls=0;
  const bench:QuickBench={submission:context.submission,models:{judge:models.judge.id,counsel:Object.fromEntries(COUNSEL.map(by=>[by,models[`counsel.${by}`].id])) as QuickBench["models"]["counsel"]},
    answer:async(by)=>{calls++;return {text:`Answer ${by}`,sources:[],at};},
    vote:async(by)=>{calls++;return {verdict:verdicts[COUNSEL.indexOf(by)],rationale:"Complete fixture rationale.",at};},
    tiebreak:async()=>{throw new Error("No proved tiebreak route");},
    commit:async(events)=>{current.push(...events);if(events.some(e=>e.type==="content_vote")) throw new Error("stop after complete voting prefix");},
  };
  await assert.rejects(holdQuickSession(bench),/complete voting prefix/);
  return {context,current,calls};
}

test("real Quick orchestration prefix yields a deterministic atomic consensus cursor without repeating seats",async()=>{
  const {context,current,calls}=await fixture();assert.equal(calls,8);
  const publication=quickContentConsensusPublication(context,current);
  assert.deepEqual(publication.events.map(e=>e.seq),[10,11]);
  validateQuickContentConsensusPublication(context,current,publication.checkpoint,publication.events,publication.phase);
  assert.throws(()=>restoreQuickContentConsensusCursor(context,current,publication.checkpoint),/publication incomplete/);
  const committed=[...current,...publication.events];
  for(let i=0;i<3;i++) {
    assert.deepEqual(quickContentConsensusPublication(context,current),publication);
    assert.equal(restoreQuickContentConsensusCursor(context,committed,publication.checkpoint).nextSeq,12);
    validateQuickContentConsensusPublication(context,committed,publication.checkpoint,publication.events,publication.phase);
  }
  assert.equal(calls,8,"restoring a pure cursor invokes no bench/provider");
});

test("Quick consensus rejects unsupported routes, incomplete rounds, gaps and incompatible models/inputs",async()=>{
  const {context,current}=await fixture();
  for(const pipeline of [1,2,3,4] as const) assert.throws(()=>quickContentConsensusPublication({...context,pipeline},current),/route blocked/);
  assert.throws(()=>quickContentConsensusPublication({...context,submission:{...context.submission,identifyClaims:true}},current),/route blocked/);
  assert.throws(()=>quickContentConsensusPublication({...context,submission:{kind:"link",url:"https://fixture.invalid",check:"quick"}},current),/route blocked/);
  assert.throws(()=>quickContentConsensusPublication(context,current.slice(0,8)),/route blocked/);
  assert.throws(()=>quickContentConsensusPublication(context,current.map((e,i)=>i===2?{...e,seq:4}:e)),/prefix gap/);
  assert.throws(()=>quickContentConsensusPublication({...context,models:{...context.models,judge:{id:"changed",effort:null}}},current),/model mismatch/);
  assert.throws(()=>quickContentConsensusPublication({...context,models:{...context.models,"counsel.grok":{id:"fixture/grok",effort:"high"}}},current),/model mismatch/);
  const publication=quickContentConsensusPublication(context,current);
  assert.throws(()=>validateQuickContentConsensusPublication({...context,submission:{kind:"text",check:"quick",text:"changed input"}},current,publication.checkpoint,publication.events,publication.phase),/collision/);
});

test("Quick consensus blocks 2-2 ties, seat swaps and corrupt result/hash/phase/event suffixes",async()=>{
  const tie=await fixture(["falso","falso","verdadero","verdadero"]);
  assert.throws(()=>quickContentConsensusPublication(tie.context,tie.current),/tiebreak not proved/);
  const {context,current}=await fixture();const publication=quickContentConsensusPublication(context,current);
  const swapped=[...current];[swapped[1],swapped[2]]=[swapped[2],swapped[1]];
  assert.throws(()=>quickContentConsensusPublication(context,swapped),/seat\/model mismatch/);
  const {checkpoint,events,phase}=publication;
  for(const altered of [{...checkpoint,resultHash:"0".repeat(64)},{...checkpoint,result:{nextSeq:99},resultHash:continuationHash({nextSeq:99})},{...checkpoint,sourceRunId:"other-run"}])
    assert.throws(()=>validateQuickContentConsensusPublication(context,current,altered,events,phase),/collision/);
  assert.throws(()=>validateQuickContentConsensusPublication(context,current,checkpoint,events),/collision/);
  assert.throws(()=>validateQuickContentConsensusPublication(context,current,checkpoint,events,{...phase,revision:1}),/collision/);
  assert.throws(()=>restoreQuickContentConsensusCursor(context,[...current,...events.map(e=>({...e,at:"2026-11-07T13:00:00.000Z"}))],checkpoint),/suffix collision/);
  assert.throws(()=>restoreQuickContentConsensusCursor(context,[...current,...events,{type:"session_closed",seq:12,at}],checkpoint),/publication incomplete/);
});
