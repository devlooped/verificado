import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { Pool } from "pg";
import { requireLocalDatabase } from "../src/lib/local-database.ts";
import { continuationHash, type ContinuationGeneration, type ContinuationWriter } from "../src/domain/continuation.ts";
import { reconcileContinuationStart } from "../src/lib/continuation-start.ts";
import { COUNSEL, type ModelSnapshot, type RecordedEvent } from "../src/domain/court.ts";
import { QUICK_CONSENSUS_UNIT, quickContentConsensusPublication, restoreQuickContentConsensusCursor } from "../src/court/quick-continuation.ts";

nextEnv.loadEnvConfig(process.cwd(),true);
const connectionString=requireLocalDatabase(); // Before importing/calling store.
const sql=new Pool({connectionString,max:4});
const store=await import("../src/store.ts");
const id=`fixture-continuation-${randomUUID()}`;
const at="2026-11-07T00:00:00.000Z";
const result={synthetic:true};
const checkpoint={unit:"fixture",kind:"fixture",inputHash:continuationHash("input"),pipeline:5 as const,format:1,state:"uncertain" as const,sourceRunId:"fixture-origin",result,resultHash:continuationHash(result)};
let created=false;
const additionalIds:string[]=[];
// Synthetic protocol states are confined to UUID cases owned by this fixture.
// No API promotion, historical safety inference, real SDK or provider calls.
async function protocolFixture() {
  const caseId=`fixture-continuation-${randomUUID()}`;
  await store.createCase(caseId,{kind:"text",text:"Isolated local startup protocol fixture."});additionalIds.push(caseId);
  const reservation={generation:1,token:randomUUID()};const runId=`fixture-run-${randomUUID()}`;
  const body:ContinuationGeneration={...reservation,state:"reserved",pipeline:5,adminId:"fixture-admin",reason:"Synthetic local race only",at,inputHash:continuationHash("fixture")};
  await sql.query("UPDATE cases SET status='in_session',pipeline_version=5,continuation_generation=1,workflow_run_id=$2 WHERE id=$1",[caseId,runId]);
  await sql.query("INSERT INTO case_continuation_generations (case_id,generation,token,state,body) VALUES ($1,1,$2,'reserved',$3)",[caseId,reservation.token,JSON.stringify(body)]);
  const writer={generation:1,runId};
  const blocked=()=>assert.rejects(store.saveCaseAuditRecord(caseId,"effect-probe",{probe:true},writer),/fenced/);
  return {caseId,reservation,writer,blocked};
}
try {
  await store.createCase(id,{kind:"text",text:"Local continuation storage fixture, no external providers."});created=true;
  await sql.query("UPDATE cases SET status='failed',pipeline_version=5,workflow_run_id='fixture-old',models=$2,submission=submission || '{\"resolvedLanguage\":\"es\"}'::jsonb WHERE id=$1",[id,JSON.stringify({judge:{id:"fixture/model",effort:null}})]);
  await store.recordEvents(id,[{type:"session_opened",judgeModel:"fixture",counselModels:{grok:"fixture",gemini:"fixture",claude:"fixture",chatgpt:"fixture"},seq:1,at}]);
  const oldClaim=await store.sourceOperationRepository.claim(id,"old-operation","acquisition",300000);
  await sql.query("UPDATE cases SET status='in_session' WHERE id=$1", [id]);
  await store.savePhaseCheckpoint(id,"intake:grok:preparation",-1,{id:"old-session",activeTurn:{id:"old-turn"}});
  await store.saveSandboxBinding(id,`${id}-old-sandbox`,{phase:"intake",seat:"grok",sessionKey:"intake:grok:preparation",phaseSessionId:"old-session",expiresAt:"2099-01-01T00:00:00Z",revoked:false,model:{id:"fixture/model"},gatewayTools:[],activeTurn:{id:"old-turn",expiresAt:"2099-01-01T00:00:00Z",remainingRequests:10}});
  // Resource writers require an executing case; failure retains their last state.
  await sql.query("UPDATE cases SET status='failed' WHERE id=$1", [id]);
  const before=await store.getCase(id);
  const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const order:string[]=[];
  const inFlight=store.withCaseWriteLock(id,async()=>{order.push("writer");entered.resolve();await release.promise;order.push("writer-finished");});
  await entered.promise;
  // Deterministic lock proof from a different local connection: no timing poll.
  try {
    await assert.rejects(sql.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE NOWAIT",[id]),error=>(error as {code?:string}).code === "55P03");
  } catch (error) {
    release.resolve(); await inFlight; throw error;
  }
  const reserving=Promise.allSettled(Array.from({length:2},()=>store.recordBlockedContinuationReservation(id,{adminId:"fixture-admin",reason:"Blocked diagnostic fixture; not safety evidence",expectedRevision:before!.revision,expectedRunId:"fixture-old",inputHash:continuationHash("input")}).then(value=>{order.push("reserved");return value;})));
  release.resolve();await inFlight;
  const reservations=await reserving;
  assert.deepEqual(order,["writer","writer-finished","reserved"]);
  assert.equal(reservations.filter(r=>r.status==="fulfilled").length,1);
  const reservation=(reservations.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<{generation:number;token:string}>).value;
  assert.equal((await store.continuationStartRepository.inspect(id,reservation)).state,"blocked");
  assert.equal(await store.continuationStartRepository.claim(id,reservation),false);
  await assert.rejects(store.registerContinuationRun(id,reservation,"never-started"),/registration fenced/);
  const preserved=await store.getCase(id);assert.equal(preserved?.createdAt,before?.createdAt);assert.deepEqual(preserved?.submission,before?.submission);assert.deepEqual(preserved?.models,before?.models);
  let external=0;
  assert.equal(await store.restartCase(id,async()=>{external++;}),"active");
  assert.equal(await store.deleteCase(id,async()=>{external++;}),"active");
  assert.equal(await store.stopCaseWorkflow(id,async()=>{external++;}),"unavailable");
  await assert.rejects(store.startCaseWorkflow(id,async()=>{external++;return {runId:"bad"};},async()=>{external++;}),/no está disponible/);
  await assert.rejects(store.renameCase(id,`${id}-renamed`),/fenced/);
  const forbidden=[
    ()=>store.recordEvents(id,[]),()=>store.saveCaseLanguage(id,"en"),()=>store.saveCaseModels(id,{}),()=>store.saveCover(id,{mimeType:"image/png",bytes:Uint8Array.of(1),generated:true}),
    ()=>store.savePhaseCheckpoint(id,"old",-1,{}),()=>store.saveCaseAuditRecord(id,"old",{}),()=>store.finishCase(id,"resolved"),()=>store.openSession(id,5),
    ()=>store.revokeSandboxBindings(id),()=>store.withCaseWriteLock(id,async()=>{external++;}),()=>store.sourceOperationRepository.alias(id,"https://fixture.invalid","src_old"),
  ];
  for(const operation of forbidden) await assert.rejects(operation(),/fenced/);
  await assert.rejects(store.consumeSandboxBinding(`${id}-old-sandbox`,id),/fenced/);
  if(oldClaim.owned) await assert.rejects(store.sourceOperationRepository.publish(id,"old-operation",oldClaim.owner,{}),/fenced/);
  assert.equal(external,0);
  // Explicit synthetic state seeding ONLY in this guarded local fixture. Public
  // APIs cannot promote blocked reservations; no production workflow is launched.
  await sql.query("UPDATE case_continuation_generations SET state='reserved' WHERE case_id=$1",[id]);
  let starts=0;
  assert.deepEqual(await reconcileContinuationStart(id,reservation,store.continuationStartRepository,async()=>{starts++;throw new Error("lost response");}),{state:"blocked"});
  assert.deepEqual(await reconcileContinuationStart(id,reservation,store.continuationStartRepository,async()=>{starts++;return {runId:"duplicate"};}),{state:"blocked"});assert.equal(starts,1);
  await store.registerContinuationRun(id,reservation,`fixture-run-${id}`);
  const writer:ContinuationWriter={generation:reservation.generation,runId:`fixture-run-${id}`};
  await store.registerContinuationRun(id,reservation,writer.runId);
  assert.equal((await store.continuationStartRepository.inspect(id,reservation)).state,"uncertain","late CAS is not authorization");
  assert.equal((await sql.query("SELECT workflow_run_id FROM cases WHERE id=$1",[id])).rows[0].workflow_run_id,"fixture-old","registration must not replace the case run");
  await assert.rejects(store.registerContinuationRun(id,reservation,"other"),/fenced/);
  await assert.rejects(store.registerContinuationRun(id,{...reservation,token:"wrong"},writer.runId),/fenced/);
  await sql.query("UPDATE cases SET status='in_session' WHERE id=$1",[id]);
  await assert.rejects(store.saveCaseAuditRecord(id,"before-reconcile",{},writer),/fenced/);
  assert.deepEqual(await store.continuationStartRepository.reconcile(id,reservation),{state:"registered",runId:writer.runId});
  await assert.rejects(store.publishContinuationCheckpoint(id,writer,{...checkpoint,state:"ready"}),/unit validators not implemented/);
  await store.publishContinuationCheckpoint(id,writer,checkpoint);
  await store.publishContinuationCheckpoint(id,writer,checkpoint);
  await assert.rejects(store.publishContinuationCheckpoint(id,writer,checkpoint,[{type:"instruction_opened",seq:2,at}],{key:"fixture-phase",revision:-1,body:{cursor:2}}),/Uncertain checkpoints cannot publish/);
  assert.deepEqual((await store.loadContinuationCheckpoints(id,writer.generation)).map(c=>c.unit),["fixture"]);
  assert.equal((await store.getEvents(id)).length,1);
  await assert.rejects(store.recordEvents(id,[{type:"instruction_closed",seq:2,at}],writer),/atomic checkpoint and phase/);
  await assert.rejects(store.recordEvents(id,[],writer),/atomic checkpoint and phase/);
  await assert.rejects(store.savePhaseCheckpoint(id,"fixture-phase",-1,{cursor:2},writer),/atomic checkpoint/);
  await assert.rejects(store.saveCaseLanguage(id,"en",writer),/cannot change/);
  await assert.rejects(store.saveCaseModels(id,{},writer),/cannot change/);
  await assert.rejects(store.withCaseWriteLock(id,async()=>{external++;},writer),/Continuation disabled/);
  await assert.rejects(store.saveCover(id,{mimeType:"image/png",bytes:Uint8Array.of(1),generated:true},writer),/Continuation disabled/);
  const ops=store.sourceOperationRepositoryFor(writer);
  await assert.rejects(ops.claim(id,"pending","acquisition",300000),/input hash/);
  const claimed=await ops.claim(id,"pending","acquisition",300000,continuationHash("request"));assert.equal(claimed.owned,true);
  await assert.rejects(ops.claim(id,"pending","acquisition",300000,continuationHash("other")),/input mismatch/);
  if(claimed.owned) await assert.rejects(ops.publish(id,"pending",claimed.owner,{}),/validators not implemented/);
  await sql.query("UPDATE case_source_operations SET body=jsonb_set(body,'{expiresAt}',to_jsonb($2::text)) WHERE case_id=$1 AND operation_key LIKE 'generation:%'",[id,at]);
  assert.equal((await ops.claim(id,"pending","acquisition",300000,continuationHash("request"))).operation.status,"uncertain");
  await assert.rejects(ops.recover(id,"pending","fixture reason"),/authorization and inactivity/);
  // A later generation/run change under the same lock rejects old writers.
  await sql.query("UPDATE cases SET continuation_generation=2 WHERE id=$1",[id]);
  await assert.rejects(store.saveCaseAuditRecord(id,"stale",{},writer),/fenced/);
  await assert.rejects(store.withCaseWriteLock(id,async()=>{external++;},writer),/fenced/);
  assert.equal(external,0);

  // Every startup order uses real PostgreSQL CAS and a writer probe with the
  // matching case run already seeded: the reconciliation fence itself is tested.
  for(const lost of [false,true]) {
    for(const earlyRegistration of [false,true]) {
      const f=await protocolFixture();let launches=0;
      const start=async()=>{launches++;if(earlyRegistration) {await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);await f.blocked();}
        if(lost) throw new Error("lost response");return {runId:f.writer.runId};};
      const first=await reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start);
      if(!earlyRegistration) {
        assert.deepEqual(first,{state:"blocked"});await f.blocked();
        await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);await f.blocked();
        const candidate=await store.continuationStartRepository.inspect(f.caseId,f.reservation);
        assert.equal(candidate.state,"uncertain");assert.equal(candidate.reconciledRunId,undefined);
      } else assert.deepEqual(first,{state:"registered",runId:f.writer.runId});
      assert.deepEqual(await reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start),{state:"registered",runId:f.writer.runId});
      assert.equal(launches,1);await store.saveCaseAuditRecord(f.caseId,"authorized-probe",{probe:true},f.writer);
      await assert.rejects(store.registerContinuationRun(f.caseId,f.reservation,"other-run"),/fenced/);
      await assert.rejects(store.registerContinuationRun(f.caseId,{...f.reservation,token:"wrong"},f.writer.runId),/fenced/);
    }
  }
  {
    const f=await protocolFixture();const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let launches=0;
    const start=async()=>{launches++;await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);entered.resolve();await release.promise;return {runId:f.writer.runId};};
    const first=reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start);await entered.promise;
    try {
      const competing=await Promise.all(Array.from({length:3},()=>reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start)));
      assert.ok(competing.every(r=>r.state==="blocked"));await f.blocked();
    } finally {release.resolve();}
    assert.deepEqual(await first,{state:"registered",runId:f.writer.runId});assert.equal(launches,1);
  }
  for(const earlyRegistration of [false,true]) {
    const f=await protocolFixture();let launches=0;
    const start=async()=>{launches++;if(earlyRegistration) await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);return {runId:"wrong-response-run"};};
    assert.deepEqual(await reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start),{state:"blocked"});
    if(!earlyRegistration) await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);
    for(let attempt=0;attempt<3;attempt++) assert.deepEqual(await reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start),{state:"blocked"});
    assert.equal(launches,1);await f.blocked();
    await assert.rejects(store.continuationStartRepository.observe(f.caseId,f.reservation,{state:"returned",runId:f.writer.runId}),/observation collision/);
    await f.blocked();
  }
  {
    const f=await protocolFixture();let launches=0;
    const repo={...store.continuationStartRepository,observe:async()=>{throw new Error("observation storage failed");}};
    const start=async()=>{launches++;await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);return {runId:f.writer.runId};};
    await assert.rejects(reconcileContinuationStart(f.caseId,f.reservation,repo,start),/storage failed/);
    assert.deepEqual(await reconcileContinuationStart(f.caseId,f.reservation,store.continuationStartRepository,start),{state:"blocked"});
    await f.blocked();assert.equal(launches,1);
  }
  console.log("PASS: PostgreSQL startup response/CAS in both orders, lost responses, concurrent callers, conflicting IDs and observation failure; registration alone cannot authorize writes");
  {
    const f=await protocolFixture();
    assert.equal(await store.continuationStartRepository.claim(f.caseId,f.reservation),true);
    await store.continuationStartRepository.observe(f.caseId,f.reservation,{state:"returned",runId:f.writer.runId});
    await store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId);
    await sql.query("INSERT INTO case_continuation_audit (case_id,generation,record_id,body) VALUES ($1,1,'start-reconciled',$2)",[f.caseId,JSON.stringify({conflict:true})]);
    await assert.rejects(store.continuationStartRepository.reconcile(f.caseId,f.reservation),/audit collision/);
    const candidate=await store.continuationStartRepository.inspect(f.caseId,f.reservation);
    assert.equal(candidate.state,"uncertain");assert.equal(candidate.reconciledRunId,undefined);await f.blocked();
    await sql.query("DELETE FROM case_continuation_audit WHERE case_id=$1 AND record_id='start-reconciled'",[f.caseId]);
    assert.deepEqual(await store.continuationStartRepository.reconcile(f.caseId,f.reservation),{state:"registered",runId:f.writer.runId});
    await sql.query("UPDATE cases SET stopped_workflow_run_id=$2 WHERE id=$1",[f.caseId,f.writer.runId]);await f.blocked();
    await sql.query("UPDATE cases SET stopped_workflow_run_id=NULL,continuation_generation=2 WHERE id=$1",[f.caseId]);
    await assert.rejects(store.registerContinuationRun(f.caseId,f.reservation,f.writer.runId),/fenced/);
    await assert.rejects(store.continuationStartRepository.reconcile(f.caseId,f.reservation),/fenced/);await f.blocked();
    console.log("PASS: reconciliation audit failure rolls back authorization; cancellation and generation changes fence late writers");
  }

  // Real stored cursor for ONE pure unit only. Analyst turns, artifacts, imports,
  // tie breaks and the public Quick workflow remain disabled/unproved.
  const q=await protocolFixture();
  const models:ModelSnapshot={judge:{id:"fixture/judge",effort:null},...Object.fromEntries(COUNSEL.map(by=>[`counsel.${by}`,{id:`fixture/${by}`,effort:null}]))};
  const submission={kind:"text" as const,check:"quick" as const,text:"Pure local Quick consensus fixture."};
  await sql.query("UPDATE cases SET submission=$2,models=$3 WHERE id=$1",[q.caseId,JSON.stringify(submission),JSON.stringify(models)]);
  const prefix:RecordedEvent[]=[{type:"session_opened",judgeModel:models.judge.id,counselModels:Object.fromEntries(COUNSEL.map(by=>[by,models[`counsel.${by}`].id])) as Record<(typeof COUNSEL)[number],string>,seq:1,at},
    ...COUNSEL.map((by,i)=>({type:"quick_response" as const,by,text:`Complete response ${by}`,sources:[],seq:i+2,at})),
    ...COUNSEL.map((by,i)=>({type:"content_vote" as const,by,verdict:"falso" as const,rationale:"Complete synthetic rationale.",seq:i+6,at}))];
  for(const {seq,at,...body} of prefix) await sql.query("INSERT INTO events (case_id,seq,at,body) VALUES ($1,$2,$3,$4)",[q.caseId,seq,at,JSON.stringify(body)]);
  await reconcileContinuationStart(q.caseId,q.reservation,store.continuationStartRepository,async()=>{await store.registerContinuationRun(q.caseId,q.reservation,q.writer.runId);return {runId:q.writer.runId};});
  const context={submission,models,pipeline:5 as const,runId:q.writer.runId};
  const publication=quickContentConsensusPublication(context,prefix);const {checkpoint:ready,events,phase}=publication;
  const publish=()=>store.publishContinuationCheckpoint(q.caseId,q.writer,ready,events,phase);
  const unchanged=async()=>{assert.deepEqual(await store.getEvents(q.caseId),prefix);assert.deepEqual(await store.loadContinuationCheckpoints(q.caseId,1),[]);
    assert.equal((await sql.query("SELECT record_id FROM case_continuation_audit WHERE case_id=$1 AND record_id=$2",[q.caseId,`checkpoint:${QUICK_CONSENSUS_UNIT}`])).rowCount,0);};
  await assert.rejects(store.recordEvents(q.caseId,events,q.writer),/atomic checkpoint and phase/);
  await assert.rejects(store.recordEvents(q.caseId,events),/fenced/);
  await assert.rejects(store.publishContinuationCheckpoint(q.caseId,q.writer,ready,events),/atomic checkpoint and phase/);await unchanged();
  const phaseKey=`generation:1:${phase.key}`;
  await sql.query("INSERT INTO case_phase_sessions (case_id,session_key,body) VALUES ($1,$2,'{\"conflict\":true}')",[q.caseId,phaseKey]);
  await assert.rejects(publish(),/phase CAS collision/);await unchanged();
  await sql.query("DELETE FROM case_phase_sessions WHERE case_id=$1 AND session_key=$2",[q.caseId,phaseKey]);
  // Fail at the LAST write: events, checkpoint and phase must all roll back.
  await sql.query("INSERT INTO case_continuation_audit (case_id,generation,record_id,body) VALUES ($1,1,$2,'{\"conflict\":true}')",[q.caseId,`checkpoint:${QUICK_CONSENSUS_UNIT}`]);
  await assert.rejects(publish(),/audit collision/);
  assert.deepEqual(await store.getEvents(q.caseId),prefix);assert.deepEqual(await store.loadContinuationCheckpoints(q.caseId,1),[]);
  assert.equal(await store.loadPhaseCheckpoint(q.caseId,phase.key,q.writer),undefined);
  await sql.query("DELETE FROM case_continuation_audit WHERE case_id=$1 AND record_id=$2",[q.caseId,`checkpoint:${QUICK_CONSENSUS_UNIT}`]);
  await Promise.all([publish(),publish()]);await publish();
  assert.deepEqual(await store.getEvents(q.caseId),[...prefix,...events]);
  assert.deepEqual((await store.loadPhaseCheckpoint(q.caseId,phase.key,q.writer))?.body,ready.result);
  assert.equal(restoreQuickContentConsensusCursor(context,await store.getEvents(q.caseId),(await store.loadContinuationCheckpoints(q.caseId,1))[0]).nextSeq,12);
  // A future phase advance is seeded locally, not authorized as a proved unit.
  await sql.query("UPDATE case_phase_sessions SET revision=revision+1,body='{\"futureCursor\":true}' WHERE case_id=$1 AND session_key=$2",[q.caseId,phaseKey]);
  const advanced=await store.loadPhaseCheckpoint(q.caseId,phase.key,q.writer);await publish();
  assert.deepEqual(await store.loadPhaseCheckpoint(q.caseId,phase.key,q.writer),advanced,"retry must not regress advanced phase");
  await assert.rejects(store.publishContinuationCheckpoint(q.caseId,q.writer,{...ready,result:{corrupt:true},resultHash:continuationHash({corrupt:true})},events,phase),/collision/);
  assert.equal((await store.loadContinuationCheckpoints(q.caseId,1)).length,1);

  const activity={schemaVersion:2 as const,id:"tool:same-logical-id",kind:"tool_call" as const,at,seat:"grok" as const,data:{tool:"x_search" as const,query:"public fixture query"}};
  await store.recordCaseToolActivity(q.caseId,activity,q.writer);
  await store.recordCaseToolActivity(q.caseId,{...activity,at:"2026-11-07T01:00:00.000Z"},q.writer);
  await sql.query("INSERT INTO case_audit_records (case_id,record_id,body) VALUES ($1,$2,$3),($1,$4,$3),($1,$5,$6)",[q.caseId,activity.id,JSON.stringify(activity),`generation:2:${activity.id}`,"generation:1:tool:private",JSON.stringify({kind:"model_step",messages:"PRIVATE CHECKPOINT"})]);
  assert.deepEqual((await store.getCaseToolActivities(q.caseId)).map(a=>a.id),["tool:generation:1:same-logical-id","tool:generation:2:same-logical-id",activity.id],"stable SQL order across generation and legacy records");
  assert.ok((await store.getCaseToolActivities(q.caseId)).every(a=>a.at===at));
  assert.deepEqual(await store.getCaseToolActivities(id),[],"other cases stay isolated");
  assert.equal(external,0);
  console.log("PASS: PostgreSQL atomic Quick consensus cursor, late-write rollback, CAS failure, concurrent/idempotent publication, no phase rewind and visible isolated generational tool activity; zero providers/Blob/workflows invoked");
} finally {
  for(const caseId of additionalIds) {await sql.query("DELETE FROM admin_notifications WHERE case_id=$1",[caseId]);await sql.query("DELETE FROM cases WHERE id=$1",[caseId]);}
  if(created) {await sql.query("DELETE FROM admin_notifications WHERE case_id=$1",[id]);await sql.query("DELETE FROM cases WHERE id=$1",[id]);}
  await sql.end();
}
