import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { continuationHash } from "../domain/continuation.ts";
import { RETRY_CONTRACT_VERSION, retryCreationHash, type RetryCreation } from "../domain/retry-contract.ts";
import type { RetryUnitSpec } from "../domain/retry-state.ts";
import { MemoryRetryRepository } from "./memory-repository.ts";
import { installRetrySchema, PgRetryRepository } from "./repository.ts";
import { executeRecordedUnit } from "./execute.ts";

const submission = {kind:"text",text:"synthetic",check:"quick"} as const;
function creation(): RetryCreation {
  const configuration: RetryCreation["configuration"]={check:"quick",pipelineVersion:5,submission,models:{judge:{id:"fixture"}},prompts:{judge:"synthetic"},tools:{},language:"es",today:"2026-11-07",budgets:{phase:1},automaticRetries:{workflow:0,ai:0,provider:0,broker:0,sandbox:0}};
  const result:RetryCreation={version:RETRY_CONTRACT_VERSION,creation:{caseId:"case",nonce:"nonce",at:"2026-11-07T12:00:00.000Z",snapshotHash:"0".repeat(64)},initialStart:{requestKey:"start"},configuration,configurationHash:continuationHash(configuration)};
  result.creation.snapshotHash=retryCreationHash(result); return result;
}
const binding={runId:"run",deploymentId:"deployment",world:"local"};
const spec:RetryUnitSpec={key:"effect",kind:"call",format:1,dependencies:[],input:{prompt:"synthetic"},effect:"external",estimatedCost:null};
async function active(repo=new MemoryRetryRepository()) {
  await repo.create(creation(),submission);
  assert.equal(await repo.claimStart("case","start"),true);
  await repo.registerStart("case","start",binding);
  await repo.observeStart("case","start",{state:"returned",runId:"run"});
  const fence=await repo.reconcileStart("case","start"); assert.ok(fence);
  return {repo,fence};
}

test("creation is exclusive, bound to submission and no historical enrollment",async()=>{
  const repo=new MemoryRetryRepository(["case"]);
  await assert.rejects(repo.create(creation(),submission));
  assert.equal(await repo.read("case"),null);
  await assert.rejects(new MemoryRetryRepository().create(creation(),{kind:"text",text:"other"}));
  const {repo:created}=await active();
  await assert.rejects(created.create(creation(),submission));
  const second=creation(); second.creation.caseId="other-case"; second.creation.snapshotHash=retryCreationHash(second);
  await created.create(second,submission); await created.claimStart("other-case","start");
  await assert.rejects(created.registerStart("other-case","start",binding));
});
test("start intent is one-shot and only the candidate and observation together authorize the same run",async()=>{
  const repo=new MemoryRetryRepository(); await repo.create(creation(),submission);
  assert.equal(await repo.claimStart("case","bad"),false);
  assert.deepEqual(await Promise.all([repo.claimStart("case","start"),repo.claimStart("case","start")]),[true,false]);
  await repo.observeStart("case","start",{state:"lost"});
  assert.equal(await repo.reconcileStart("case","start"),null);
  await repo.registerStart("case","start",binding);
  assert.deepEqual(await repo.reconcileStart("case","start"),{caseId:"case",runId:"run",attempt:0,epoch:0});
  await assert.rejects(repo.registerStart("case","start",{...binding,runId:"another"}));
  const other=new MemoryRetryRepository(); await other.create(creation(),submission); await other.claimStart("case","start");
  await other.registerStart("case","start",binding); await other.observeStart("case","start",{state:"returned",runId:"different"});
  assert.equal(await other.reconcileStart("case","start"),null);
});
test("the execution adapter reuses a complete result from the shared memory protocol",async()=>{
  const {repo,fence}=await active(); let calls=0;
  const perform=async()=>{calls++; return {answer:"complete"};};
  assert.equal((await executeRecordedUnit(repo,fence,spec,perform)).state,"complete");
  assert.deepEqual(await executeRecordedUnit(repo,fence,spec,perform),{state:"complete",key:"effect",result:{answer:"complete"},reused:true});
  assert.equal(calls,1);
});

test("running and uncertain effects never acquire a second claim",async()=>{
  const {repo,fence}=await active(); const claim=await repo.claimUnit(fence,spec); assert.equal(claim.state,"claimed"); if(claim.state!=="claimed") return;
  assert.deepEqual(await repo.claimUnit(fence,spec),{state:"blocked",reason:"running"});
  await repo.failUnit(fence,spec.key,claim.owner,{state:"uncertain",reason:"lost response"});
  assert.deepEqual(await repo.claimUnit(fence,spec),{state:"blocked",reason:"uncertain"});
  const pause=await repo.beginPause(fence,spec.key,"lost response"); await repo.confirmPause(fence,pause.id,{runId:"run",hookId:"hook",eventId:"event"});
  await assert.rejects(repo.reserveRequest(fence,pause.id,"request","admin"));
  await assert.rejects(repo.completeUnit(fence,spec.key,claim.owner,{ok:true}));
});
test("proof, confirmed pause, persisted admin request and old fence authorize exactly one same-run retry",async()=>{
  const {repo,fence}=await active(); const claim=await repo.claimUnit(fence,spec); assert.equal(claim.state,"claimed"); if(claim.state!=="claimed") return;
  await assert.rejects(repo.failUnit(fence,spec.key,claim.owner,{state:"proven_failed",reason:"failed"}));
  await repo.failUnit(fence,spec.key,claim.owner,{state:"proven_failed",reason:"failed",inactivityProof:"provider-proof"});
  const pause=await repo.beginPause(fence,spec.key,"failed");
  await assert.rejects(repo.reserveRequest(fence,pause.id,"request","admin"));
  await repo.confirmPause(fence,pause.id,{runId:"run",hookId:"hook",eventId:"registration"});
  const req=await repo.reserveRequest(fence,pause.id,"request","admin");
  assert.deepEqual(await repo.reserveRequest(fence,pause.id,"request","admin"),req);
  await assert.rejects(repo.reserveRequest(fence,pause.id,"other","admin"));
  assert.equal(await repo.claimDispatch(fence,req.key),true); assert.equal(await repo.claimDispatch(fence,req.key),false);
  await repo.observeDispatch(fence,req.key,"uncertain");
  assert.equal(await repo.claimDispatch(fence,req.key),false);
  assert.equal(await repo.consumeRequest(fence,{...req.command,requestKey:"forged"}),null);
  const [next,duplicate]=await Promise.all([repo.consumeRequest(fence,req.command),repo.consumeRequest(fence,req.command)]);
  assert.deepEqual(next,{...fence,attempt:1,epoch:1}); assert.equal(duplicate,null); assert.ok(next);
  await repo.observeDispatch(fence,req.key,"delivered");
  await assert.rejects(repo.claimUnit(fence,spec));
  const retry=await repo.claimUnit(next,spec); assert.equal(retry.state,"claimed"); if(retry.state!=="claimed") return;
  const history=(await repo.read("case"))?.failureHistory;
  assert.equal(history?.[0].inactivityProof,"provider-proof");
  assert.equal(history?.[0].attempt,0);
  await assert.rejects(repo.completeUnit(next,spec.key,claim.owner,{answer:"old"}));
  await repo.completeUnit(next,spec.key,retry.owner,{answer:"complete"});
  await repo.completeUnit(next,spec.key,retry.owner,{answer:"complete"});
  await assert.rejects(repo.completeUnit(next,spec.key,retry.owner,{answer:"changed"}));
  const reused=await repo.claimUnit(next,spec); assert.equal(reused.state,"reused");
  if(reused.state==="reused") assert.deepEqual(reused.unit.result,{answer:"complete"});
});
test("one accepted pause authorizes only its failed unit; siblings need their own request",async()=>{
  const {repo,fence}=await active();
  const second:RetryUnitSpec={...spec,key:"sibling",input:{prompt:"different input"}};
  const complete:RetryUnitSpec={...spec,key:"already-complete",input:{prompt:"complete input"}};
  const firstClaim=await repo.claimUnit(fence,spec), secondClaim=await repo.claimUnit(fence,second), doneClaim=await repo.claimUnit(fence,complete);
  assert.equal(firstClaim.state,"claimed"); assert.equal(secondClaim.state,"claimed"); assert.equal(doneClaim.state,"claimed");
  if(firstClaim.state!=="claimed" || secondClaim.state!=="claimed" || doneClaim.state!=="claimed") throw new Error("fixture claims failed");
  await repo.completeUnit(fence,complete.key,doneClaim.owner,{answer:"retained"});
  await repo.failUnit(fence,spec.key,firstClaim.owner,{state:"proven_failed",reason:"first error",inactivityProof:"proof-a"});
  await repo.failUnit(fence,second.key,secondClaim.owner,{state:"proven_failed",reason:"second error",inactivityProof:"proof-b"});
  const pause=await repo.beginPause(fence,spec.key,"first error");
  await repo.confirmPause(fence,pause.id,{runId:"run",hookId:"hook-a",eventId:"event-a"});
  const request=await repo.reserveRequest(fence,pause.id,"request-a","admin");
  assert.equal(await repo.claimDispatch(fence,request.key),true);
  const next=await repo.consumeRequest(fence,request.command); assert.ok(next);
  assert.equal(await repo.consumeRequest(fence,request.command),null);
  assert.deepEqual(await repo.claimUnit(next,second),{state:"blocked",reason:"proven_failed"});
  await assert.rejects(repo.claimUnit(next,{...spec,input:second.input}));
  const retry=await repo.claimUnit(next,spec); assert.equal(retry.state,"claimed");
  if(retry.state!=="claimed") throw new Error("fixture retry failed");
  await assert.rejects(repo.completeUnit(next,spec.key,firstClaim.owner,{answer:"stale"}));
  await repo.completeUnit(next,spec.key,retry.owner,{answer:"first retry"});
  const pending:RetryUnitSpec={...spec,key:"first-time",input:{prompt:"new input"}};
  await assert.rejects(repo.claimUnit(fence,pending));
  const fresh=await repo.claimUnit(next,pending); assert.equal(fresh.state,"claimed");
  if(fresh.state!=="claimed") throw new Error("fixture fresh claim failed");
  assert.deepEqual(await repo.claimUnit(next,pending),{state:"blocked",reason:"running"});
  await repo.completeUnit(next,pending.key,fresh.owner,{answer:"new"});
  const secondPause=await repo.beginPause(next,second.key,"second error");
  await repo.confirmPause(next,secondPause.id,{runId:"run",hookId:"hook-b",eventId:"event-b"});
  const secondRequest=await repo.reserveRequest(next,secondPause.id,"request-b","admin");
  assert.equal(await repo.claimDispatch(next,secondRequest.key),true);
  const last=await repo.consumeRequest(next,secondRequest.command); assert.ok(last);
  const secondRetry=await repo.claimUnit(last,second); assert.equal(secondRetry.state,"claimed");
  if(secondRetry.state!=="claimed") throw new Error("fixture second retry failed");
  await repo.completeUnit(last,second.key,secondRetry.owner,{answer:"second retry"});
  const record=await repo.read("case"); assert.ok(record);
  assert.deepEqual(record.failureHistory.map(f=>[f.key,f.reason,f.inputHash]),[
    [spec.key,"first error",continuationHash(spec.input)],[second.key,"second error",continuationHash(second.input)],
  ]);
  assert.deepEqual(record.resultHistory.map(r=>[r.key,r.result]),[
    [complete.key,{answer:"retained"}],[spec.key,{answer:"first retry"}],
    [pending.key,{answer:"new"}],[second.key,{answer:"second retry"}],
  ]);
  assert.deepEqual(record.pauseHistory.map(p=>p.unitKey),[spec.key,second.key]);
});

test("ordered boundary, cursor and events commit once, with collisions and unavailable dependencies rejected",async()=>{
  const {repo,fence}=await active(); const claim=await repo.claimUnit(fence,spec); assert.equal(claim.state,"claimed"); if(claim.state!=="claimed") return;
  await assert.rejects(repo.publishBoundary(fence,{key:"b",units:["effect"],expectedSeq:1,events:[],cursor:{step:1}}));
  assert.deepEqual(await repo.claimUnit(fence,{...spec,key:"dependent",dependencies:["effect"]}),{state:"blocked",reason:"dependency_unavailable"});
  await repo.completeUnit(fence,spec.key,claim.owner,{answer:"ok"});
  const boundary={key:"b",units:["effect"],expectedSeq:1,events:[{type:"instruction_opened" as const,seq:1,at:"2026-11-07T00:00:00Z"}],cursor:{step:1}};
  await repo.publishBoundary(fence,boundary); await repo.publishBoundary(fence,boundary);
  await assert.rejects(repo.publishBoundary(fence,{...boundary,cursor:{step:2}}));
  await assert.rejects(repo.publishBoundary(fence,{...boundary,key:"c"}));
  assert.equal((await repo.read("case"))?.nextSeq,2); assert.equal((await repo.readEvents("case")).length,1);
  await repo.block(fence,"manual investigation");
  assert.equal((await repo.read("case"))?.blockReason,"manual investigation");
  await assert.rejects(repo.claimUnit(fence,spec));
});

test("a mismatched durable audit hash blocks read and mutations",async()=>{
  const body={record:{},boundaries:{}}; const calls:string[]=[];
  const response={rows:[{body,body_hash:"wrong"}]};
  const pool={query:async()=>response,connect:async()=>({query:async(sql:string)=>{calls.push(sql); return sql.startsWith("SELECT retry_contract_version") ? {rows:[{retry_contract_version:RETRY_CONTRACT_VERSION}]} : response;},release:()=>{}})} as unknown as Pool;
  const repo=new PgRetryRepository(pool);
  await assert.rejects(repo.read("case"),/Retry protocol/);
  await assert.rejects(repo.claimStart("case","start"),/Retry protocol/);
  assert.ok(calls.includes("ROLLBACK"));
});

test("PG adapter uses explicit install, read-only select, case-first transaction and rollback",async()=>{
  const calls:string[]=[]; const auditDetails: {operation:unknown; details:unknown}[]=[];
  let body:unknown, bodyHash:unknown, staged:unknown, stagedHash:unknown; let failAudit=false;
  const client={query:async(sql:string,params?:unknown[])=>{calls.push(sql);
    if(sql==="BEGIN") { staged=body; stagedHash=bodyHash; }
    if(sql==="COMMIT") { body=staged; bodyHash=stagedHash; }
    if(sql.startsWith("SELECT retry_contract_version")) return {rows:[{retry_contract_version:RETRY_CONTRACT_VERSION}]};
    if(sql.startsWith("SELECT body,")) return {rows:staged ? [{body:staged,body_hash:stagedHash}] : []};
    if(sql.startsWith("INSERT INTO case_retry_records") || sql.startsWith("UPDATE case_retry_records")) staged=JSON.parse(params![1] as string);
    if(sql.startsWith("INSERT INTO case_retry_audit")) { if(failAudit) throw new Error("injected audit failure"); stagedHash=params![2]; if(params![3]) auditDetails.push({operation:params![1],details:JSON.parse(params![3] as string)}); }
    return {rows:[],rowCount:0}; },release:()=>calls.push("release")};
  const pool={query:async(sql:string)=>{calls.push(sql); return {rows:body ? [{body,body_hash:bodyHash}] : []};},connect:async()=>client} as unknown as Pool;
  const repo=new PgRetryRepository(pool);
  assert.equal(await repo.read("missing"),null); assert.equal(calls.length,1); assert.match(calls[0],/^SELECT/);
  calls.length=0; await installRetrySchema(pool); assert.match(calls[0],/CREATE TABLE IF NOT EXISTS case_retry_records/);
  calls.length=0; await repo.create(creation(),submission); assert.ok(calls.indexOf("COMMIT")>calls.findIndex(s=>s.startsWith("INSERT INTO case_retry_audit")));
  calls.length=0; await repo.claimStart("case","start");
  assert.ok(calls.findIndex(s=>s.startsWith("SELECT retry_contract_version")) < calls.findIndex(s=>s.startsWith("SELECT body,")));
  assert.equal(calls.at(-2),"COMMIT");
  calls.length=0; failAudit=true; await assert.rejects(repo.registerStart("case","start",binding),/injected/); assert.ok(calls.includes("ROLLBACK")); assert.ok(!calls.includes("COMMIT"));
  assert.equal((await repo.read("case"))?.startCandidate,null);
  failAudit=false;
  await repo.registerStart("case","start",binding); await repo.observeStart("case","start",{state:"returned",runId:"run"});
  const fence=await repo.reconcileStart("case","start"); assert.ok(fence);
  const failed=await repo.claimUnit(fence,spec); assert.equal(failed.state,"claimed"); if(failed.state!=="claimed") throw new Error("fixture claim failed");
  await repo.failUnit(fence,spec.key,failed.owner,{state:"proven_failed",reason:"proof failure",inactivityProof:"proof"});
  const other={...spec,key:"complete"}; const complete=await repo.claimUnit(fence,other); assert.equal(complete.state,"claimed"); if(complete.state!=="claimed") throw new Error("fixture claim failed");
  await repo.completeUnit(fence,other.key,complete.owner,{answer:"retained"});
  assert.deepEqual(auditDetails.map(a=>a.operation),["unit_failure","unit_complete"]);
  assert.deepEqual(auditDetails[0].details,{key:spec.key,owner:failed.owner,attempt:0,epoch:0,inputHash:continuationHash(spec.input),state:"proven_failed",reason:"proof failure",inactivityProof:"proof"});
  assert.deepEqual(auditDetails[1].details,{key:other.key,owner:complete.owner,attempt:0,epoch:0,inputHash:continuationHash(other.input),result:{answer:"retained"},resultHash:continuationHash({answer:"retained"})});
});
