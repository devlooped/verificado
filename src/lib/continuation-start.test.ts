import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTINUATION_ENABLED, continuationHash, validateContinuationCheckpoint, type ContinuationGeneration } from "../domain/continuation.ts";
import { publishContinuationCheckpoint, reserveContinuationGeneration } from "../store.ts";
import { startCourtContinuation } from "./case-workflow.ts";
import { reconcileContinuationStart, type ContinuationStartRepository } from "./continuation-start.ts";

const token = {generation:1,token:"fixture-token"};
function fixture() {
  const state: ContinuationGeneration = {...token,state:"reserved",pipeline:5,adminId:"fixture-admin",reason:"local test only",inputHash:continuationHash("fixture"),at:"2026-11-07T00:00:00Z"};
  const repo: ContinuationStartRepository = {
    claim: async () => {if(state.state !== "reserved") return false; state.state="starting"; return true;},
    observe: async (_caseId,_token,outcome) => {state.startOutcome=outcome;state.state="uncertain";},
    reconcile: async () => {
      if (state.state === "running" && state.runId === state.reconciledRunId) return {state:"registered",runId:state.runId!};
      if (!state.startOutcome || !state.runId || (state.startOutcome.state === "returned" && state.startOutcome.runId !== state.runId)) return {state:"blocked"};
      state.state="running";state.reconciledRunId=state.runId;
      return {state:"registered",runId:state.runId};
    },
  };
  return {state,repo};
}
test("all live continuation entry points fail closed before storage or start", async () => {
  assert.equal(CONTINUATION_ENABLED,false);
  await assert.rejects(reserveContinuationGeneration("fixture"),/Continuation disabled/);
  await assert.rejects(startCourtContinuation("fixture"),/Continuation disabled/);
});
test("lost start response without first-step registration blocks and never starts again", async () => {
  const {state,repo}=fixture(); let starts=0;
  const start=async () => {starts++;throw new Error("lost response after effect");};
  for(let i=0;i<3;i++) assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"blocked"});
  assert.equal(starts,1); assert.equal(state.state,"uncertain");
});
test("first-step durable registration is sufficient to reconcile a lost response", async () => {
  const {state,repo}=fixture(); let starts=0;
  const start=async () => {starts++;state.runId="fixture-run";assert.equal(state.reconciledRunId,undefined);throw new Error("lost start response");};
  for(let i=0;i<2;i++) assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"registered",runId:"fixture-run"});
  assert.equal(starts,1);
});
test("a returned runId alone is not registration, and concurrent callers launch once", async () => {
  const {repo}=fixture(); let starts=0;
  const results=await Promise.all(Array.from({length:4},()=>reconcileContinuationStart("fixture",token,repo,async()=>{starts++;return {runId:"not-registered"};})));
  assert.ok(results.every(r=>r.state==="blocked"));assert.equal(starts,1);
});
test("conflicting run response blocks the registered generation too", async () => {
  const {state,repo}=fixture();
  assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,async()=>{state.runId="one";return {runId:"two"};}),{state:"blocked"});
  assert.equal(state.state,"uncertain");
});
test("returned response before a late CAS remains blocked until explicit reconciliation", async () => {
  const {state,repo}=fixture();let starts=0;
  const start=async()=>{starts++;return {runId:"late"};};
  assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"blocked"});
  state.runId="late";
  assert.equal(state.state,"uncertain");assert.equal(state.reconciledRunId,undefined);
  assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"registered",runId:"late"});
  assert.equal(starts,1);
});
test("late CAS after lost response must also await reconciliation, never a second start", async () => {
  const {state,repo}=fixture();let starts=0;
  const start=async()=>{starts++;throw new Error("lost");};
  assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"blocked"});
  state.runId="late";
  assert.equal(state.state,"uncertain");assert.equal(state.reconciledRunId,undefined);
  assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"registered",runId:"late"});
  assert.equal(starts,1);
});
test("observation storage failure and concurrent reconciliation cannot authorize registration alone", async () => {
  const {state,repo}=fixture();let starts=0;
  repo.observe=async()=>{throw new Error("observation storage failed");};
  await assert.rejects(reconcileContinuationStart("fixture",token,repo,async()=>{starts++;state.runId="candidate";return {runId:"candidate"};}),/storage failed/);
  for(let i=0;i<3;i++) assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,async()=>{starts++;return {runId:"duplicate"};}),{state:"blocked"});
  assert.equal(starts,1);assert.equal(state.reconciledRunId,undefined);
});
test("an in-flight start cannot be authorized by a concurrent caller before its observation", async () => {
  const {state,repo}=fixture();const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let starts=0;
  const start=async()=>{starts++;state.runId="candidate";entered.resolve();await release.promise;return {runId:"candidate"};};
  const first=reconcileContinuationStart("fixture",token,repo,start);
  await entered.promise;
  assert.deepEqual(await reconcileContinuationStart("fixture",token,repo,start),{state:"blocked"});
  assert.equal(state.reconciledRunId,undefined);
  release.resolve();assert.deepEqual(await first,{state:"registered",runId:"candidate"});assert.equal(starts,1);
});
test("checkpoint envelope rejects corrupt, non-JSON and unverified referenced results", () => {
  const checkpoint={unit:"fixture",kind:"fixture",inputHash:continuationHash({input:1}),pipeline:5 as const,format:1,state:"ready" as const,sourceRunId:"fixture-run",result:{output:1},resultHash:continuationHash({output:1})};
  validateContinuationCheckpoint(checkpoint);
  assert.equal(continuationHash({b:2,a:1}),continuationHash({a:1,b:2}));
  assert.throws(()=>validateContinuationCheckpoint({...checkpoint,resultHash:"0".repeat(64)}),/verified hash/);
  assert.throws(()=>validateContinuationCheckpoint({...checkpoint,resultRef:"unverified/path"}),/referenced checkpoints are blocked/);
  assert.throws(()=>continuationHash({undefined:undefined}),/canonical JSON/);
});

test("inline hash integrity never authorizes ready publication without unit validators", async () => {
  const result={synthetic:true};
  await assert.rejects(publishContinuationCheckpoint("fixture",{generation:1,runId:"fixture-run"},{unit:"fixture",kind:"fixture",inputHash:continuationHash("input"),pipeline:5,format:1,state:"ready",sourceRunId:"fixture-origin",result,resultHash:continuationHash(result)}),/unit validators not implemented/);
});
