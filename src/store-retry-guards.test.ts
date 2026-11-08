import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { deleteCase, restartCase, startCaseWorkflow, stopCaseWorkflow, openSession, renameCase, recordEvents, sourceOperationRepository, withCaseWriteLock, consumeSandboxBinding, recordBlockedContinuationReservation } from "./store.ts";

test("legacy paths fence retry cases under the case lock, before callbacks or publications",async(t)=>{
  const previous=process.env.DATABASE_URL; process.env.DATABASE_URL="postgres://example.invalid/test";
  t.after(()=>{if(previous===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=previous;});
  const calls:string[]=[]; let status="queued";
  t.mock.method(Pool.prototype,"query",(async()=>({rows:[]})) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype,"connect",(async()=>({query:async(sql:string)=>{
    calls.push(sql);
    if(sql.startsWith("SELECT case_id,body FROM case_sandbox_bindings")) return {rows:[{case_id:"case",body:{}}]};
    if(sql.includes("FROM cases WHERE id = $1 FOR UPDATE")) return {rows:[{id:"case",status,continuation_generation:0,workflow_run_id:"run",stopped_workflow_run_id:null,retry_contract_version:"same-run-retry/1",revision:0,pipeline_version:5}]};
    return {rows:[]};
  },release:()=>{}})) as unknown as typeof Pool.prototype.connect);
  let external=0;
  await assert.rejects(startCaseWorkflow("case",async()=>{external++;return {runId:"other"};},async()=>{external++;}));
  assert.equal(await stopCaseWorkflow("case",async()=>{external++;}),"unavailable");
  await assert.rejects(openSession("case",()=>{external++;return 5;}));
  await assert.rejects(renameCase("case","new"));
  await assert.rejects(recordEvents("case",[]));
  await assert.rejects(withCaseWriteLock("case",async()=>{external++;}));
  await assert.rejects(sourceOperationRepository.claim("case","key","stage",1000));
  await assert.rejects(consumeSandboxBinding("sandbox"));
  status="failed";
  assert.equal(await deleteCase("case",async()=>{external++;}),"active");
  assert.equal(await restartCase("case",async()=>{external++;}),"active");
  await assert.rejects(recordBlockedContinuationReservation("case",{adminId:"admin",reason:"reason",expectedRevision:0,expectedRunId:"run",inputHash:"0".repeat(64)}));
  assert.equal(external,0);
  assert.ok(!calls.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)));
});
