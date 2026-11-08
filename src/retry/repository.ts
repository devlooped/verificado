import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { continuationHash, continuationJson } from "../domain/continuation.ts";
import { parseRetryContract, parseRetryCreation, RETRY_CONTRACT_VERSION, retryCommandMatches, retryCommandSchema, type RetryContract, type RetryCreation, type RetryFence } from "../domain/retry-contract.ts";
import type { Submission, RecordedEvent } from "../domain/court.ts";
import type { RetryBoundary, RetryPause, RetryRecord, RetryRepository, RetryRequest, RetryStartObservation, RetryUnit, RetryUnitClaim, RetryUnitSpec } from "../domain/retry-state.ts";

// Explicit installation only. The caller must install the existing cases/events schema first.
// This DDL is also suitable for a disposable PostgreSQL fixture; read() never calls it.
export async function installRetrySchema(pool: Pool): Promise<void> {
  await pool.query(
    `ALTER TABLE cases ADD COLUMN IF NOT EXISTS retry_contract_version TEXT;
     CREATE TABLE IF NOT EXISTS case_retry_records (case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE RESTRICT, body JSONB NOT NULL);
     CREATE UNIQUE INDEX IF NOT EXISTS case_retry_start_run ON case_retry_records ((body->'record'->'startCandidate'->>'runId')) WHERE body->'record'->'startCandidate'->>'runId' IS NOT NULL;
     CREATE TABLE IF NOT EXISTS case_retry_audit (id BIGSERIAL PRIMARY KEY, case_id TEXT NOT NULL REFERENCES case_retry_records(case_id) ON DELETE RESTRICT, operation TEXT NOT NULL, body_hash TEXT NOT NULL, details JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
     ALTER TABLE case_retry_audit ADD COLUMN IF NOT EXISTS details JSONB;`
  );
}

const clone = <T>(value: T): T => JSON.parse(continuationJson(value)) as T;
const same = (a: unknown, b: unknown) => continuationJson(a) === continuationJson(b);
const required = (s: string) => typeof s === "string" && s.trim().length > 0 && s.length <= 256;
const fenceMatches = (a: RetryFence | null, b: RetryFence) => !!a && same(a, b);
function bad(): never { throw new Error("Retry protocol rejected transition"); }

export type RetryFailureRecord = { key: string; owner: string; attempt: number; epoch: number; inputHash: string; state: "proven_failed" | "uncertain"; reason: string; inactivityProof?: string };
export type RetryResultRecord = { key: string; owner: string; attempt: number; epoch: number; inputHash: string; result: unknown; resultHash: string };
type Stored = { record: RetryRecord; boundaries: Record<string, string>; failures: RetryFailureRecord[]; results: RetryResultRecord[]; pauses: RetryPause[]; blockReason?: string };
export type RetryMutation = { events: RecordedEvent[]; audit: unknown | null };

// The same transition implementation backs PostgreSQL and the offline double.
// A backend must commit the entire body, events and audit atomically under a case lock.
export abstract class RetryRepositoryBase implements RetryRepository {
  protected abstract insert(creation: RetryCreation, submission: Submission, ownerId?: string): Promise<void>;
  protected abstract load(caseId: string): Promise<Stored | null>;
  protected abstract mutate<T>(caseId: string, operation: string, fn: (data: Stored, mutation: RetryMutation) => T): Promise<T>;

  async create(input: RetryCreation, submission: Submission, ownerId?: string): Promise<void> {
    const creation = parseRetryCreation(input);
    submission = clone(submission);
    if (!creation || !same(creation.configuration.submission, submission) || (ownerId !== undefined && !required(ownerId))) bad();
    // Images require a separate immutable input design; this API cannot store bytes.
    if (submission.kind === "image") bad();
    await this.insert(creation!, clone(submission), ownerId);
  }
  async read(caseId: string): Promise<(RetryRecord & {blockReason?: string; failureHistory: RetryFailureRecord[]; resultHistory: RetryResultRecord[]; pauseHistory: RetryPause[]}) | null> {
    const data = await this.load(caseId);
    return data ? clone({...data.record,failureHistory:data.failures,resultHistory:data.results,pauseHistory:data.pauses,...(data.blockReason ? {blockReason:data.blockReason} : {})}) : null;
  }
  async claimStart(caseId: string, requestKey: string): Promise<boolean> {
    return this.mutate(caseId, "start_claim", ({record:r}) => {
      if (requestKey !== r.creation.initialStart.requestKey || r.state !== "starting" || r.startClaimed) return false;
      r.startClaimed = true; return true;
    });
  }
  async registerStart(caseId: string, requestKey: string, binding: RetryContract["binding"]): Promise<void> {
    binding = clone(binding);
    return this.mutate(caseId, "start_candidate", ({record:r}) => {
      const contract = parseRetryContract({...r.creation, binding});
      if (!r.startClaimed || requestKey !== r.creation.initialStart.requestKey || !contract) bad();
      if (r.startCandidate) { if (!same(r.startCandidate, binding)) bad(); return; }
      if (r.state !== "starting") bad();
      r.startCandidate = clone(binding);
    });
  }
  async observeStart(caseId: string, requestKey: string, observation: RetryStartObservation): Promise<void> {
    observation = clone(observation);
    return this.mutate(caseId, "start_observation", ({record:r}) => {
      if (!r.startClaimed || requestKey !== r.creation.initialStart.requestKey || !observation ||
          !(same(observation, {state:"lost"}) || (observation.state === "returned" && required(observation.runId) && same(observation, {state:"returned", runId:observation.runId})))) bad();
      if (r.startObservation) { if (!same(r.startObservation, observation)) bad(); return; }
      if (r.state !== "starting") bad();
      r.startObservation = clone(observation);
    });
  }
  async reconcileStart(caseId: string, requestKey: string): Promise<RetryFence | null> {
    return this.mutate(caseId, "start_reconcile", ({record:r}) => {
      if (requestKey !== r.creation.initialStart.requestKey) bad();
      if (r.fence && r.state === "active") return clone(r.fence);
      if (r.state !== "starting" || !r.startClaimed || !r.startCandidate || !r.startObservation ||
          (r.startObservation.state === "returned" && r.startObservation.runId !== r.startCandidate.runId)) return null;
      const contract = parseRetryContract({...r.creation,binding:r.startCandidate});
      if (!contract) bad();
      r.contract = contract; r.fence = {caseId,runId:r.startCandidate.runId,attempt:0,epoch:0}; r.state = "active";
      return clone(r.fence);
    });
  }
  private check(r: RetryRecord, fence: RetryFence, states: RetryRecord["state"][]): void {
    if (!fenceMatches(r.fence, fence) || !r.contract || !parseRetryContract(r.contract) || !states.includes(r.state)) bad();
  }
  private spec(spec: RetryUnitSpec): string {
    continuationJson(spec);
    if (!same(Object.keys(spec).sort(),["dependencies","effect","estimatedCost","format","input","key","kind"]) || !required(spec.key) || !required(spec.kind) || !Number.isSafeInteger(spec.format) || spec.format < 1 ||
        !Array.isArray(spec.dependencies) || spec.dependencies.some(d => !required(d) || d === spec.key) ||
        new Set(spec.dependencies).size !== spec.dependencies.length || !["pure", "external"].includes(spec.effect) ||
        (spec.estimatedCost !== null && (!Number.isFinite(spec.estimatedCost) || spec.estimatedCost < 0))) bad();
    return continuationHash(spec.input);
  }
  private verifyUnit(unit: RetryUnit): void {
    if (unit.inputHash !== continuationHash(unit.input) || (unit.state === "ready" &&
        (unit.result === undefined || unit.resultHash !== continuationHash(unit.result)))) bad();
  }
  private failureProved(data: Stored, unit: RetryUnit): boolean {
    return unit.state === "proven_failed" && unit.inputHash === continuationHash(unit.input) && required(unit.inactivityProof ?? "") &&
      data.failures.some(f => f.key === unit.key && f.owner === unit.owner && f.attempt === unit.attempt && f.epoch === unit.epoch && f.inputHash === unit.inputHash && f.state === "proven_failed" && f.reason === unit.reason && f.inactivityProof === unit.inactivityProof);
  }
  async claimUnit(fence: RetryFence, spec: RetryUnitSpec): Promise<RetryUnitClaim> {
    fence=clone(fence); spec=clone(spec);
    const inputHash = this.spec(spec);
    return this.mutate(fence.caseId, "unit_claim", (data) => {
      const r=data.record;
      this.check(r,fence,["active"]);
      let unit = r.units.find(u => u.key === spec.key);
      if (unit) {
        this.verifyUnit(unit);
        const existing = {key:unit.key,kind:unit.kind,format:unit.format,dependencies:unit.dependencies,input:unit.input,effect:unit.effect,estimatedCost:unit.estimatedCost};
        if (!same(existing,spec) || unit.inputHash !== inputHash) bad();
        if (unit.state === "ready" || unit.state === "skipped") return {state:"reused",unit:clone(unit)};
        // A request is scoped to the durable pause it accepted, not its whole batch.
        const authorized = r.requests.some(req => {
          if (req.state !== "accepted" || !req.acceptedFence || !fenceMatches(req.acceptedFence, fence)) return false;
          const pause=data.pauses.find(p => p.id === req.pauseId);
          return !!pause && !!r.pause && same(pause,r.pause) && pause.unitKey === unit!.key &&
            pause.attempt + 1 === fence.attempt && pause.epoch + 1 === fence.epoch &&
            retryCommandMatches(req.command,{...fence,attempt:pause.attempt,epoch:pause.epoch});
        });
        if (!this.failureProved(data,unit) || unit.attempt >= fence.attempt || unit.epoch >= fence.epoch || !authorized)
          return {state:"blocked",reason:unit.state};
      }
      for (const dependency of spec.dependencies) {
        const dep = r.units.find(u => u.key === dependency);
        if (!dep || !["ready","skipped"].includes(dep.state)) return {state:"blocked",reason:"dependency_unavailable"};
        this.verifyUnit(dep);
      }
      const owner = randomUUID();
      if (!unit) { unit = {...clone(spec),inputHash,state:"running",owner,attempt:fence.attempt,epoch:fence.epoch}; r.units.push(unit); }
      else { unit.state="running"; unit.owner=owner; unit.attempt=fence.attempt; unit.epoch=fence.epoch; delete unit.reason; delete unit.inactivityProof; }
      return {state:"claimed",unit:clone(unit),owner};
    });
  }
  async completeUnit(fence: RetryFence, key: string, owner: string, result: unknown): Promise<void> {
    fence=clone(fence); result=clone(result);
    const resultHash = continuationHash(result);
    return this.mutate(fence.caseId, "unit_complete", (data,mutation) => {
      const r=data.record;
      this.check(r,fence,["active"]);
      const unit = r.units.find(u=>u.key===key);
      if (!unit || unit.attempt !== fence.attempt || unit.epoch !== fence.epoch || unit.owner !== owner) bad();
      if (unit.state === "ready") { if (unit.resultHash !== resultHash || !same(unit.result,result)) bad(); return; }
      if (unit.state !== "running") bad();
      this.verifyUnit(unit);
      unit.result=clone(result); unit.resultHash=resultHash; unit.state="ready";
      const entry: RetryResultRecord={key,owner,attempt:fence.attempt,epoch:fence.epoch,inputHash:unit.inputHash,result:clone(result),resultHash};
      data.results.push(entry); mutation.audit=entry;
    });
  }
  async failUnit(fence: RetryFence, key: string, owner: string, failure: {state:"proven_failed"|"uncertain";reason:string;inactivityProof?:string}): Promise<void> {
    fence=clone(fence); failure=clone(failure);
    if (!Object.keys(failure).every(key=>["state","reason","inactivityProof"].includes(key)) || !required(failure.reason) || !["proven_failed","uncertain"].includes(failure.state) || (failure.state === "proven_failed" && !required(failure.inactivityProof ?? ""))) bad();
    return this.mutate(fence.caseId, "unit_failure", (data,mutation) => {
      const r=data.record;
      this.check(r,fence,["active"]);
      const unit=r.units.find(u=>u.key===key);
      if (!unit || unit.attempt!==fence.attempt || unit.epoch!==fence.epoch || unit.owner!==owner || unit.state!=="running") bad();
      this.verifyUnit(unit);
      unit.state=failure.state; unit.reason=failure.reason;
      if (failure.inactivityProof) unit.inactivityProof=failure.inactivityProof;
      const entry: RetryFailureRecord={key,owner,attempt:fence.attempt,epoch:fence.epoch,inputHash:unit.inputHash,...failure};
      data.failures.push(entry); mutation.audit=entry;
    });
  }
  async skipUnit(fence: RetryFence, spec: RetryUnitSpec, reason: string): Promise<void> {
    fence=clone(fence); spec=clone(spec);
    const inputHash=this.spec(spec); if (!required(reason)) bad();
    return this.mutate(fence.caseId,"unit_skip",({record:r})=>{
      this.check(r,fence,["active"]);
      const unit=r.units.find(u=>u.key===spec.key);
      if (unit) { if (unit.state!=="skipped" || unit.reason!==reason || unit.inputHash!==inputHash || !same({key:unit.key,kind:unit.kind,format:unit.format,dependencies:unit.dependencies,input:unit.input,effect:unit.effect,estimatedCost:unit.estimatedCost},spec)) bad(); return; }
      for (const key of spec.dependencies) { const dep=r.units.find(u=>u.key===key); if (!dep || !["ready","skipped"].includes(dep.state)) bad(); this.verifyUnit(dep); }
      r.units.push({...clone(spec),inputHash,state:"skipped",owner:null,attempt:fence.attempt,epoch:fence.epoch,reason});
    });
  }
  async publishBoundary(fence: RetryFence, boundary: RetryBoundary): Promise<void> {
    fence=clone(fence); boundary=clone(boundary);
    if (!required(boundary.key) || !Number.isSafeInteger(boundary.expectedSeq) || boundary.expectedSeq < 1 || boundary.expectedSeq > 2147483647 ||
      !Array.isArray(boundary.units) || !boundary.units.length || new Set(boundary.units).size !== boundary.units.length || !Array.isArray(boundary.events)) bad();
    const hash=continuationHash(boundary);
    return this.mutate(fence.caseId,"boundary",(data,mutation)=>{
      const r=data.record; this.check(r,fence,["active"]);
      const boundaryId=continuationHash(boundary.key);
      if (Object.hasOwn(data.boundaries,boundaryId)) { if (data.boundaries[boundaryId]!==hash) bad(); return; }
      if (boundary.expectedSeq!==r.nextSeq || r.nextSeq + boundary.events.length > 2147483648) bad();
      for (const key of boundary.units) { const unit=r.units.find(u=>u.key===key); if (!unit || !["ready","skipped"].includes(unit.state)) bad(); this.verifyUnit(unit); }
      boundary.events.forEach((event,index)=>{ if (event.seq!==r.nextSeq+index || typeof event.at!=="string" || !Number.isFinite(Date.parse(event.at))) bad(); });
      mutation.events=clone(boundary.events); r.nextSeq+=boundary.events.length; r.cursor=clone(boundary.cursor); data.boundaries[boundaryId]=hash;
    });
  }
  async beginPause(fence: RetryFence, unitKey: string, reason: string): Promise<RetryPause> {
    fence=clone(fence);
    if (!required(unitKey) || !required(reason)) bad();
    return this.mutate(fence.caseId,"pause_begin",(data)=>{
      const r=data.record;
      this.check(r,fence,["active","pausing"]);
      if (r.state === "pausing") { if (!r.pause || r.pause.unitKey!==unitKey || r.pause.reason!==reason) bad(); return clone(r.pause); }
      if (!r.units.some(u=>u.key===unitKey)) bad();
      r.pause={id:randomUUID(),token:randomUUID(),unitKey,reason,attempt:fence.attempt,epoch:fence.epoch,hookId:null,registrationEventId:null}; r.state="pausing";
      data.pauses.push(clone(r.pause));
      return clone(r.pause);
    });
  }
  async confirmPause(fence: RetryFence, pauseId: string, registration: {runId:string;hookId:string;eventId:string}): Promise<void> {
    fence=clone(fence); registration=clone(registration);
    return this.mutate(fence.caseId,"pause_confirm",(data)=>{
      const r=data.record;
      this.check(r,fence,["pausing","paused"]);
      if (!r.pause || r.pause.id!==pauseId || registration.runId!==fence.runId || !required(registration.hookId) || !required(registration.eventId)) bad();
      if (r.state==="paused") { if (r.pause.hookId!==registration.hookId || r.pause.registrationEventId!==registration.eventId) bad(); return; }
      const saved=data.pauses.find(p=>p.id===pauseId); if (!saved) bad();
      r.pause.hookId=registration.hookId; r.pause.registrationEventId=registration.eventId;
      saved.hookId=registration.hookId; saved.registrationEventId=registration.eventId; r.state="paused";
    });
  }
  async reserveRequest(fence: RetryFence, pauseId: string, requestKey: string, adminId: string): Promise<RetryRequest> {
    fence=clone(fence);
    if (!required(requestKey) || !required(adminId)) bad();
    return this.mutate(fence.caseId,"request_reserve",(data)=>{
      const r=data.record;
      this.check(r,fence,["paused"]);
      if (!r.pause || r.pause.id!==pauseId || !r.pause.hookId || !r.pause.registrationEventId || r.pause.attempt!==fence.attempt || r.pause.epoch!==fence.epoch) bad();
      const existing=r.requests.find(req=>req.key===requestKey);
      if (existing) { if (existing.adminId!==adminId || existing.pauseId!==pauseId || !retryCommandMatches(existing.command,fence)) bad(); return clone(existing); }
      if (r.requests.some(req=>req.pauseId===pauseId) || r.units.some(u=>u.state==="running" || u.state==="uncertain" || (u.state==="proven_failed" && !this.failureProved(data,u)))) bad();
      const req: RetryRequest={key:requestKey,adminId,pauseId,command:{requestKey,version:RETRY_CONTRACT_VERSION,expectedAttempt:fence.attempt,expectedEpoch:fence.epoch},state:"reserved"}; r.requests.push(req); return clone(req);
    });
  }
  async claimDispatch(fence: RetryFence, requestKey: string): Promise<boolean> {
    fence=clone(fence);
    return this.mutate(fence.caseId,"dispatch_claim",({record:r})=>{
      this.check(r,fence,["paused"]); const req=r.requests.find(q=>q.key===requestKey);
      if (!req || req.pauseId!==r.pause?.id || req.state!=="reserved") return false;
      req.state="dispatching"; return true;
    });
  }
  async observeDispatch(fence: RetryFence, requestKey: string, state: "delivered"|"uncertain"|"blocked"): Promise<void> {
    fence=clone(fence);
    if (!["delivered","uncertain","blocked"].includes(state)) bad();
    return this.mutate(fence.caseId,"dispatch_observe",({record:r})=>{
      // A consumer may accept before the sender records the delivery observation.
      const req=r.requests.find(q=>q.key===requestKey);
      if (req?.state==="accepted" && req.acceptedFence && retryCommandMatches(req.command,fence) && fence.caseId===r.creation.creation.caseId && fence.runId===r.contract?.binding.runId) return;
      this.check(r,fence,["paused"]);
      if (!req || req.pauseId!==r.pause?.id || (req.state!=="dispatching" && req.state!==state)) bad();
      req.state=state;
    });
  }
  async consumeRequest(fence: RetryFence, command: unknown): Promise<RetryFence | null> {
    fence=clone(fence);
    const parsed=retryCommandSchema.safeParse(clone(command));
    if (!parsed.success || !retryCommandMatches(command,fence)) return null;
    return this.mutate(fence.caseId,"request_consume",(data)=>{
      const r=data.record;
      const req=r.requests.find(q=>q.key===parsed.data.requestKey);
      if (req?.state==="accepted") return null;
      if (!fenceMatches(r.fence,fence) || r.state!=="paused" || !r.pause || !req || req.pauseId!==r.pause.id || !required(req.adminId) ||
          !same(req.command,parsed.data) || !["dispatching","delivered","uncertain"].includes(req.state) ||
          !r.pause.hookId || !r.pause.registrationEventId || r.pause.attempt!==fence.attempt || r.pause.epoch!==fence.epoch ||
          r.units.some(u=>u.state==="running" || u.state==="uncertain" || (u.state==="proven_failed" && !this.failureProved(data,u))) ||
          !Number.isSafeInteger(fence.attempt+1) || !Number.isSafeInteger(fence.epoch+1)) return null;
      const next={...fence,attempt:fence.attempt+1,epoch:fence.epoch+1}; req.state="accepted"; req.acceptedFence=next; r.fence=next; r.state="active"; return clone(next);
    });
  }
  async block(fence: RetryFence, reason: string): Promise<void> {
    fence=clone(fence);
    if (!required(reason)) bad();
    return this.mutate(fence.caseId,"block",(data)=>{this.check(data.record,fence,["active","pausing","paused","blocked"]); data.record.state="blocked"; data.blockReason=reason;});
  }
  async finish(fence: RetryFence): Promise<void> {
    fence=clone(fence);
    return this.mutate(fence.caseId,"finish",({record:r})=>{this.check(r,fence,["active"]); if (r.units.some(u=>!["ready","skipped"].includes(u.state))) bad(); r.units.forEach(u=>this.verifyUnit(u)); r.state="finished";});
  }
}

export function initialRetryStored(creation: RetryCreation): Stored {
  return {record:{creation:clone(creation),contract:null,state:"starting",fence:null,startCandidate:null,startObservation:null,startClaimed:false,nextSeq:1,cursor:null,pause:null,units:[],requests:[]},boundaries:{},failures:[],results:[],pauses:[]};
}

export class PgRetryRepository extends RetryRepositoryBase {
  constructor(private readonly pool: Pool) { super(); }
  protected async insert(creation: RetryCreation, submission: Submission, ownerId?: string): Promise<void> {
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      // INSERT, never an update/enrollment: an existing case (or alias) is rejected.
      const alias=await client.query("SELECT 1 FROM case_aliases WHERE old_id=$1",[creation.creation.caseId]);
      if (alias.rowCount) bad();
      await client.query("INSERT INTO cases (id,created_at,status,submission,owner_id,pipeline_version,retry_contract_version) VALUES ($1,$2,'queued',$3,$4,5,$5)",[creation.creation.caseId,creation.creation.at,continuationJson(submission),ownerId ?? null,RETRY_CONTRACT_VERSION]);
      const body=initialRetryStored(creation);
      await client.query("INSERT INTO case_retry_records (case_id,body) VALUES ($1,$2)",[creation.creation.caseId,continuationJson(body)]);
      await client.query("INSERT INTO case_retry_audit (case_id,operation,body_hash) VALUES ($1,$2,$3)",[creation.creation.caseId,"create",continuationHash(body)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  protected async load(caseId: string): Promise<Stored | null> {
    const {rows}=await this.pool.query<{body:Stored; body_hash:string|null}>("SELECT body,(SELECT body_hash FROM case_retry_audit WHERE case_id=case_retry_records.case_id ORDER BY id DESC LIMIT 1) AS body_hash FROM case_retry_records WHERE case_id=$1",[caseId]);
    if (!rows[0]) return null;
    if (rows[0].body_hash !== continuationHash(rows[0].body)) bad();
    return clone(rows[0].body);
  }
  protected async mutate<T>(caseId: string, operation: string, fn: (data: Stored, mutation: RetryMutation) => T): Promise<T> {
    const client: PoolClient=await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current=await client.query<{retry_contract_version:string|null}>("SELECT retry_contract_version FROM cases WHERE id=$1 FOR UPDATE",[caseId]);
      if (current.rows[0]?.retry_contract_version!==RETRY_CONTRACT_VERSION) bad();
      const stored=await client.query<{body:Stored; body_hash:string|null}>("SELECT body,(SELECT body_hash FROM case_retry_audit WHERE case_id=case_retry_records.case_id ORDER BY id DESC LIMIT 1) AS body_hash FROM case_retry_records WHERE case_id=$1 FOR UPDATE",[caseId]);
      if (!stored.rows[0] || stored.rows[0].body_hash !== continuationHash(stored.rows[0].body)) bad();
      const data=clone(stored.rows[0].body), mutation:RetryMutation={events:[],audit:null};
      const value=fn(data,mutation);
      for (const {seq,at,...body} of mutation.events) await client.query("INSERT INTO events (case_id,seq,at,body) VALUES ($1,$2,$3,$4)",[caseId,seq,at,continuationJson(body)]);
      await client.query("UPDATE case_retry_records SET body=$2 WHERE case_id=$1",[caseId,continuationJson(data)]);
      if (data.record.fence) await client.query("UPDATE cases SET workflow_run_id=$2 WHERE id=$1",[caseId,data.record.fence.runId]);
      await client.query("INSERT INTO case_retry_audit (case_id,operation,body_hash,details) VALUES ($1,$2,$3,$4)",[caseId,operation,continuationHash(data),mutation.audit === null ? null : continuationJson(mutation.audit)]);
      await client.query("COMMIT"); return value;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
