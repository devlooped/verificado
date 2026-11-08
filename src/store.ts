import { attachDatabasePool } from "@vercel/functions";
import { Pool, type PoolClient } from "pg";
import type { ModelSetting } from "./court/models.ts";
import { sharedPipeline, type CaseRecord, type CaseStatus, type CourtEvent, type ModelSnapshot, type PipelineVersion, type RecordedEvent, type Submission } from "./domain/court.ts";
import { newCaseId } from "./lib/case-id.ts";
import type { Operation, OperationClaim, OperationRepository } from "./instruction/source-store.ts";
import { randomUUID } from "node:crypto";
import { authorizeSandboxBinding, committedPhase, type SandboxBinding } from "./instruction/authorization.ts";
import { caseFailureMessage, type SnapshotHealth } from "./lib/admin-notifications.ts";
import { publicToolActivities, ToolActivitySchema, type ToolActivity } from "./domain/tool-activity.ts";
import type { PromptTranslationCache } from "./evidence/prompt-translation.ts";
import { stoppedRunSettled } from "./lib/stopped-run.ts";
import { assertSandboxCleanupSafe } from "./lib/sandbox-cleanup.ts";
import { continuationHash, continuationJson, requireContinuationEnabled, validateContinuationCheckpoint, type ContinuationCheckpoint, type ContinuationGeneration, type ContinuationReservation, type ContinuationStartOutcome, type ContinuationStartResult, type ContinuationWriter } from "./domain/continuation.ts";
import { QUICK_CONSENSUS_UNIT, validateQuickContentConsensusPublication } from "./court/quick-continuation.ts";
import { GenerationArtifactBlockedError, type StagedGenerationArtifact } from "./evidence/generation-artifacts.ts";
import { continuationPhaseWriter, continuationPhaseSnapshot, validateContinuationPhaseRecord, validateContinuationPhaseTransition, type ContinuationPhaseSnapshot } from "./domain/continuation-phase.ts";

export { newCaseId };

export interface StoredImage {
  mimeType: string;
  bytes: Buffer;
}

let pool: Pool | undefined;
let schema: Promise<void> | undefined;

// pg already treats prefer, require and verify-ca as verify-full, and warns on
// every cold start that the next major will weaken them to libpq semantics.
// Naming the mode it uses keeps today's verification and silences the warning;
// a URL that opts into uselibpqcompat keeps its own semantics.
export function pinSslMode(connectionString: string): string {
  if (/[?&]uselibpqcompat=/i.test(connectionString)) return connectionString;
  return connectionString.replace(/([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|#|$)/i, "$1verify-full");
}

function connect(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({ connectionString: pinSslMode(connectionString), max: 5 });
  attachDatabasePool(pool);
  return pool;
}

function migrateLegacySeat(value: unknown, field?: string): unknown {
  if (typeof value === "string") return value === "openai" && (field === "by" || field === "to") ? "chatgpt" : value;
  if (Array.isArray(value)) return value.map((child) => migrateLegacySeat(child));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key === "openai" ? "chatgpt" : key, migrateLegacySeat(child, key)]));
}

async function db(): Promise<Pool> {
  const p = connect();
  schema ??= p
    .query(
      `CREATE TABLE IF NOT EXISTS cases (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         status TEXT NOT NULL,
         submission JSONB NOT NULL,
         owner_id TEXT,
         error TEXT
       );
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS owner_id TEXT;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS models JSONB;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS pipeline_version INTEGER;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS workflow_run_id TEXT;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS stopped_workflow_run_id TEXT;
       ALTER TABLE cases ADD COLUMN IF NOT EXISTS continuation_generation INTEGER NOT NULL DEFAULT 0;
       CREATE TABLE IF NOT EXISTS case_continuation_generations (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         generation INTEGER NOT NULL CHECK (generation > 0),
         token TEXT NOT NULL UNIQUE,
         state TEXT NOT NULL CHECK (state IN ('blocked','reserved','starting','uncertain','running','finished')),
         run_id TEXT UNIQUE,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, generation)
       );
       CREATE TABLE IF NOT EXISTS case_continuation_checkpoints (
         case_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         unit TEXT NOT NULL,
         body JSONB NOT NULL,
         publication_hash TEXT,
         PRIMARY KEY (case_id, generation, unit),
         FOREIGN KEY (case_id, generation) REFERENCES case_continuation_generations(case_id, generation) ON DELETE CASCADE
       );
       ALTER TABLE case_continuation_checkpoints ADD COLUMN IF NOT EXISTS publication_hash TEXT;
       ALTER TABLE case_continuation_generations ADD COLUMN IF NOT EXISTS start_outcome JSONB;
       ALTER TABLE case_continuation_generations ADD COLUMN IF NOT EXISTS reconciled_run_id TEXT;
       CREATE TABLE IF NOT EXISTS case_continuation_audit (
         case_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         record_id TEXT NOT NULL,
         body JSONB NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (case_id, generation, record_id),
         FOREIGN KEY (case_id, generation) REFERENCES case_continuation_generations(case_id, generation) ON DELETE CASCADE
       );
       ALTER TABLE case_continuation_audit ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
       CREATE TABLE IF NOT EXISTS events (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         seq INTEGER NOT NULL,
         at TEXT NOT NULL,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, seq)
       );
       CREATE TABLE IF NOT EXISTS images (
         case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
         mime_type TEXT NOT NULL,
         bytes BYTEA NOT NULL
       );
       CREATE TABLE IF NOT EXISTS covers (
         case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
         mime_type TEXT NOT NULL,
         bytes BYTEA NOT NULL,
         source_url TEXT,
         generated BOOLEAN NOT NULL,
         saved_at TEXT
       );
       ALTER TABLE covers ADD COLUMN IF NOT EXISTS saved_at TEXT;
       CREATE TABLE IF NOT EXISTS case_aliases (
         old_id TEXT PRIMARY KEY,
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE
       );
       CREATE TABLE IF NOT EXISTS model_settings (
         role TEXT PRIMARY KEY,
         model_id TEXT NOT NULL,
         effort TEXT,
         updated_at TEXT NOT NULL,
         updated_by TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS admin_notifications (
         id BIGSERIAL PRIMARY KEY,
         created_at TEXT NOT NULL,
         title TEXT NOT NULL,
         message TEXT NOT NULL,
         case_id TEXT,
         read_at TEXT
       );
       CREATE TABLE IF NOT EXISTS admin_notification_conditions (
         condition_key TEXT PRIMARY KEY,
         state TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS case_source_operations (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         operation_key TEXT NOT NULL,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, operation_key)
       );
       CREATE TABLE IF NOT EXISTS case_source_aliases (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         url TEXT NOT NULL,
         source_id TEXT NOT NULL,
         PRIMARY KEY (case_id, url)
       );
       CREATE TABLE IF NOT EXISTS case_phase_sessions (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         session_key TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 0,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, session_key)
       );
       CREATE TABLE IF NOT EXISTS case_continuation_phase_states (
         case_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         session_key TEXT NOT NULL,
         run_id TEXT NOT NULL,
         revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
         body JSONB NOT NULL,
         body_hash TEXT NOT NULL,
         PRIMARY KEY (case_id, generation, session_key),
         FOREIGN KEY (case_id, generation) REFERENCES case_continuation_generations(case_id, generation) ON DELETE CASCADE
       );
       CREATE TABLE IF NOT EXISTS case_audit_records (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         record_id TEXT NOT NULL,
         body JSONB NOT NULL,
         PRIMARY KEY (case_id, record_id)
       );
       CREATE TABLE IF NOT EXISTS case_sandbox_bindings (
         case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
         sandbox_id TEXT PRIMARY KEY,
         body JSONB NOT NULL
       );
       CREATE TABLE IF NOT EXISTS prompt_translations (
         key TEXT PRIMARY KEY,
         language TEXT NOT NULL,
         source TEXT NOT NULL,
         translation TEXT NOT NULL,
         model_id TEXT NOT NULL,
         created_at TEXT NOT NULL
       );`
    )
    .then(async () => {
      const { rows } = await p.query<{ case_id: string; seq: number; body: unknown }>(
        `SELECT case_id, seq, body FROM events WHERE body::text LIKE '%"openai"%'`
      );
      for (const row of rows) {
        await p.query("WITH legacy AS (SELECT id FROM cases WHERE id = $2 AND continuation_generation = 0 FOR UPDATE) UPDATE events SET body = $1 WHERE case_id = $2 AND seq = $3 AND EXISTS (SELECT 1 FROM legacy)", [JSON.stringify(migrateLegacySeat(row.body)), row.case_id, row.seq]);
      }
    })
    .catch((err: unknown) => {
      schema = undefined;
      throw err;
    });
  await schema;
  return p;
}

type CaseRow = { id: string; created_at: string; status: CaseStatus; submission: Submission; owner_id: string | null; error: string | null; revision: number; models: ModelSnapshot | null; pipeline_version: PipelineVersion | null };

export type StoredCaseRecord = CaseRecord & { revision: number };

function toRecord(row: CaseRow): StoredCaseRecord {
  return { id: row.id, createdAt: row.created_at, status: row.status, submission: row.submission, ownerId: row.owner_id ?? undefined, error: row.error ?? undefined, revision: row.revision, ...(row.models ? { models: row.models } : {}), pipelineVersion: row.pipeline_version ?? 1 };
}

export async function createCase(id: string, submission: Submission, image?: Buffer, ownerId?: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO cases (id, created_at, status, submission, owner_id) VALUES ($1, $2, 'queued', $3, $4)", [id, new Date().toISOString(), JSON.stringify(submission), ownerId ?? null]);
    if (image && submission.kind === "image") await client.query("INSERT INTO images (case_id, mime_type, bytes) VALUES ($1, $2, $3)", [id, submission.mimeType, image]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Random ids can collide; a taken id (or a retired alias) is retried with a new one.
export async function createNewCase(submission: Submission, image?: Buffer, ownerId?: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const id = newCaseId();
    const { rowCount } = await (await db()).query("SELECT 1 FROM case_aliases WHERE old_id = $1", [id]);
    if (rowCount) continue;
    try {
      await createCase(id, submission, image, ownerId);
      return id;
    } catch (err) {
      if (attempt >= 4 || (err as { code?: string }).code !== "23505") throw err;
    }
  }
}

// All updated case writers lock the case BEFORE subordinate rows. Generation 0
// is the legacy contract; it remains usable only while no reservation exists.
async function assertCaseWriter(client: PoolClient, caseId: string, writer?: ContinuationWriter): Promise<void> {
  const { rows } = await client.query<{ id: string; continuation_generation: number; workflow_run_id: string | null; status: string; stopped_workflow_run_id: string | null }>(
    "SELECT id, continuation_generation, workflow_run_id, status, stopped_workflow_run_id FROM cases WHERE id = $1 FOR UPDATE", [caseId]);
  const row = rows[0];
  if (!row) throw new Error("El caso ya no existe.");
  if (!writer) {
    if ((row.continuation_generation ?? 0) !== 0) throw new Error("Case writer fenced: continuation generation reserved");
    return;
  }
  if (!Number.isSafeInteger(writer.generation) || writer.generation < 1 || row.continuation_generation !== writer.generation || row.workflow_run_id !== writer.runId || row.status !== "in_session" || row.stopped_workflow_run_id) throw new Error("Case writer fenced: stale generation or run");
  const generation = await client.query<{ state: string; run_id: string | null; reconciled_run_id: string | null }>("SELECT state, run_id, reconciled_run_id FROM case_continuation_generations WHERE case_id = $1 AND generation = $2", [caseId, writer.generation]);
  if (generation.rows[0]?.state !== "running" || generation.rows[0].run_id !== writer.runId || generation.rows[0].reconciled_run_id !== writer.runId) throw new Error("Case writer fenced: start not reconciled");
}

async function withCaseMutation<T>(caseId: string, writer: ContinuationWriter | undefined, mutate: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await assertCaseWriter(client, caseId, writer);
    const result = await mutate(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

// Public reservation remains unreachable until preflight/retention are complete.
export async function reserveContinuationGeneration(_caseId: string): Promise<ContinuationReservation> {
  return requireContinuationEnabled();
}

// Store a BLOCKED diagnostic reservation, never a claim of historical safety.
// Server-side primitive; callers must authenticate an administrator themselves.
export async function recordBlockedContinuationReservation(caseId: string, input: { adminId: string; reason: string; expectedRevision: number; expectedRunId?: string; inputHash: string }): Promise<ContinuationReservation> {
  if (!input.adminId.trim() || !input.reason.trim() || !/^[a-f0-9]{64}$/.test(input.inputHash)) throw new Error("Continuation reservation requires administrator, reason and input hash");
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string; revision: number; workflow_run_id: string | null; continuation_generation: number; pipeline_version: number }>("SELECT status, revision, workflow_run_id, continuation_generation, pipeline_version FROM cases WHERE id = $1 FOR UPDATE", [caseId]);
    const row = rows[0];
    if (!row || row.status !== "failed" || row.revision !== input.expectedRevision || (row.workflow_run_id ?? undefined) !== input.expectedRunId || row.continuation_generation !== 0 || ![1,2,3,4,5].includes(row.pipeline_version)) throw new Error("Continuation reservation blocked: case changed or already reserved");
    const reservation = { generation: 1, token: randomUUID() };
    const body: ContinuationGeneration = { ...reservation, state: "blocked", pipeline: row.pipeline_version as PipelineVersion, adminId: input.adminId, reason: input.reason, inputHash: input.inputHash, at: new Date().toISOString(), ...(input.expectedRunId ? { sourceRunId: input.expectedRunId } : {}) };
    await client.query("INSERT INTO case_continuation_generations (case_id,generation,token,state,body) VALUES ($1,$2,$3,'blocked',$4)", [caseId,reservation.generation,reservation.token,JSON.stringify(body)]);
    await client.query("UPDATE cases SET continuation_generation = $2 WHERE id = $1", [caseId,reservation.generation]);
    await client.query("INSERT INTO case_continuation_audit (case_id,generation,record_id,body) VALUES ($1,$2,'reservation',$3)", [caseId,reservation.generation,JSON.stringify({ schemaVersion: 1, kind: "reservation_blocked", adminId: input.adminId, reason: input.reason, at: body.at, sourceRunId: row.workflow_run_id, inputHash: input.inputHash, blocker: "continuation_disabled_and_historical_inactivity_unverified" })]);
    await client.query("COMMIT");
    return reservation;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function withContinuationReservation<T>(caseId: string, reservation: ContinuationReservation, mutate: (client: PoolClient, body: ContinuationGeneration) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ continuation_generation: number }>("SELECT continuation_generation FROM cases WHERE id = $1 FOR UPDATE", [caseId]);
    const stored = await client.query<{ body: ContinuationGeneration; state: ContinuationGeneration["state"]; run_id: string | null; start_outcome: ContinuationStartOutcome | null; reconciled_run_id: string | null }>("SELECT body,state,run_id,start_outcome,reconciled_run_id FROM case_continuation_generations WHERE case_id = $1 AND generation = $2 AND token = $3 FOR UPDATE", [caseId,reservation.generation,reservation.token]);
    if (current.rows[0]?.continuation_generation !== reservation.generation || !stored.rows[0]) throw new Error("Continuation reservation fenced");
    const row = stored.rows[0];
    const result = await mutate(client,{...row.body,state:row.state,...(row.run_id ? {runId:row.run_id} : {}),...(row.start_outcome ? {startOutcome:row.start_outcome} : {}),...(row.reconciled_run_id ? {reconciledRunId:row.reconciled_run_id} : {})});
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function continuationAudit(client: PoolClient, caseId: string, generation: number, id: string, body: unknown): Promise<void> {
  const {rowCount} = await client.query("INSERT INTO case_continuation_audit (case_id,generation,record_id,body) VALUES ($1,$2,$3,$4) ON CONFLICT (case_id,generation,record_id) DO UPDATE SET record_id=EXCLUDED.record_id WHERE case_continuation_audit.body=EXCLUDED.body",[caseId,generation,id,continuationJson(body)]);
  if (rowCount !== 1) throw new Error("Continuation audit collision");
}

// No trusted remote provenance/retention exists. A staging receipt (including a
// genuine WeakSet receipt from an arbitrary transport) cannot authorize DB writes.
// Unconditional block: no flag, fixture hook, or alternate productive seam.
export async function publishGenerationArtifactReference(_receipt: StagedGenerationArtifact): Promise<void> {
  throw new GenerationArtifactBlockedError("generation_artifact_retention_unproved");
}

export const continuationStartRepository = {
  claim: (caseId: string, reservation: ContinuationReservation) => withContinuationReservation(caseId,reservation,async(client,body) => {
    if (body.state !== "reserved" || body.runId || body.startOutcome || body.reconciledRunId) return false;
    await client.query("UPDATE case_continuation_generations SET state='starting' WHERE case_id=$1 AND generation=$2",[caseId,reservation.generation]);
    await continuationAudit(client,caseId,reservation.generation,"start-intent",{schemaVersion:1,kind:"start_intent",generation:reservation.generation});
    return true;
  }),
  inspect: (caseId: string, reservation: ContinuationReservation) => withContinuationReservation(caseId,reservation,async(_client,body) => body),
  observe: (caseId: string, reservation: ContinuationReservation, outcome: ContinuationStartOutcome) => withContinuationReservation(caseId,reservation,async(client,body) => {
    if (outcome.state !== "lost" && (outcome.state !== "returned" || !outcome.runId?.trim())) throw new Error("Invalid start observation");
    if (body.startOutcome) {
      if (continuationJson(body.startOutcome) !== continuationJson(outcome)) throw new Error("Continuation start observation collision");
      return;
    }
    if (!["starting","uncertain"].includes(body.state)) throw new Error("Continuation start observation fenced");
    await client.query("UPDATE case_continuation_generations SET start_outcome=$3,state='uncertain' WHERE case_id=$1 AND generation=$2",[caseId,reservation.generation,continuationJson(outcome)]);
    await continuationAudit(client,caseId,reservation.generation,"start-observed",{schemaVersion:1,kind:"start_observed",outcome});
  }),
  reconcile: (caseId: string, reservation: ContinuationReservation): Promise<ContinuationStartResult> => withContinuationReservation(caseId,reservation,async(client,body) => {
    if (body.state === "running" && body.runId && body.reconciledRunId === body.runId) return {state:"registered",runId:body.runId};
    const matches = body.startOutcome && body.runId && (body.startOutcome.state === "lost" || body.startOutcome.runId === body.runId);
    if (!["starting","uncertain"].includes(body.state) || !matches) return {state:"blocked"};
    await client.query("UPDATE case_continuation_generations SET state='running',reconciled_run_id=$3 WHERE case_id=$1 AND generation=$2",[caseId,reservation.generation,body.runId]);
    await client.query("UPDATE cases SET workflow_run_id=$2 WHERE id=$1",[caseId,body.runId]);
    await continuationAudit(client,caseId,reservation.generation,"start-reconciled",{schemaVersion:1,kind:"start_reconciled",runId:body.runId,outcome:body.startOutcome});
    return {state:"registered",runId:body.runId!};
  }),
};

// First-step CAS records a candidate only. No effect may use it until the
// separate reconciliation transaction authorizes the exact same run.
export async function registerContinuationRun(caseId: string, reservation: ContinuationReservation, runId: string): Promise<void> {
  if (!runId.trim()) throw new Error("Continuation run ID required");
  await withContinuationReservation(caseId,reservation,async(client,body) => {
    if (body.runId === runId && ["starting","uncertain","running"].includes(body.state)) return;
    if (!["starting","uncertain"].includes(body.state) || body.runId) throw new Error("Continuation run registration fenced");
    await client.query("UPDATE case_continuation_generations SET run_id=$3 WHERE case_id=$1 AND generation=$2",[caseId,reservation.generation,runId]);
    await continuationAudit(client,caseId,reservation.generation,"run-registered",{schemaVersion:1,kind:"run_registered",generation:reservation.generation,runId});
  });
}

export async function publishContinuationCheckpoint(caseId: string, writer: ContinuationWriter, checkpoint: ContinuationCheckpoint, events: readonly RecordedEvent[] = [], phase?: {key:string;revision:number;body:unknown}): Promise<void> {
  validateContinuationCheckpoint(checkpoint);
  if (checkpoint.state === "ready" && checkpoint.kind !== QUICK_CONSENSUS_UNIT) throw new Error("Continuation ready publication blocked: unit validators not implemented");
  if (checkpoint.state === "uncertain" && (events.length || phase)) throw new Error("Uncertain checkpoints cannot publish events or advance a phase");
  if (events.length && !phase) throw new Error("Continuation events require atomic checkpoint and phase publication");
  if (phase && (!phase.key || !Number.isSafeInteger(phase.revision) || phase.revision < -1)) throw new Error("Invalid continuation phase CAS");
  const publicationHash = continuationHash({checkpoint,events,phase:phase ?? null});
  await withCaseMutation(caseId,writer,async(client) => {
    const pipeline = await client.query<{pipeline_version:PipelineVersion;submission:Submission;models:ModelSnapshot}>("SELECT pipeline_version,submission,models FROM cases WHERE id=$1",[caseId]);
    if (pipeline.rows[0]?.pipeline_version !== checkpoint.pipeline) throw new Error("Continuation pipeline mismatch");
    if (checkpoint.state === "ready") {
      const prefix = await client.query<{seq:number;at:string;body:CourtEvent}>("SELECT seq,at,body FROM events WHERE case_id=$1 ORDER BY seq",[caseId]);
      validateQuickContentConsensusPublication({pipeline:checkpoint.pipeline,submission:pipeline.rows[0].submission,models:pipeline.rows[0].models,runId:writer.runId},prefix.rows.map(({seq,at,body})=>({...body,seq,at})),checkpoint,events,phase);
    }
    const previous = await client.query<{publication_hash:string | null}>("SELECT publication_hash FROM case_continuation_checkpoints WHERE case_id=$1 AND generation=$2 AND unit=$3",[caseId,writer.generation,checkpoint.unit]);
    const {rowCount} = await client.query("INSERT INTO case_continuation_checkpoints (case_id,generation,unit,body,publication_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (case_id,generation,unit) DO UPDATE SET unit=EXCLUDED.unit WHERE case_continuation_checkpoints.body=EXCLUDED.body AND case_continuation_checkpoints.publication_hash=EXCLUDED.publication_hash",[caseId,writer.generation,checkpoint.unit,continuationJson(checkpoint),publicationHash]);
    if(rowCount !== 1) throw new Error("Continuation checkpoint collision");
    await recordContinuationEvents(client,caseId,events);
    // A proved identical publication already committed phase+events atomically.
    // Never rewind its cursor if a later unit advanced that phase meanwhile.
    if(phase && previous.rows[0]?.publication_hash !== publicationHash) {
      const key=`generation:${writer.generation}:${phase.key}`;
      const existing = await client.query<{revision:number;body:unknown}>("SELECT revision,body FROM case_phase_sessions WHERE case_id=$1 AND session_key=$2",[caseId,key]);
      const alreadyPublished = existing.rows[0]?.revision === phase.revision+1 && continuationJson(existing.rows[0].body) === continuationJson(phase.body);
      const changed = alreadyPublished ? {rowCount:1} : phase.revision === -1
        ? await client.query("INSERT INTO case_phase_sessions (case_id,session_key,body) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[caseId,key,continuationJson(phase.body)])
        : await client.query("UPDATE case_phase_sessions SET body=$4,revision=revision+1 WHERE case_id=$1 AND session_key=$2 AND revision=$3 AND (body->>'sandboxId' IS NULL OR body->>'sandboxId' = $4::jsonb->>'sandboxId') AND (body->>'id' IS NULL OR body->>'id' = $4::jsonb->>'id')",[caseId,key,phase.revision,continuationJson(phase.body)]);
      if(changed.rowCount !== 1) throw new Error("Continuation phase CAS collision");
    }
    await continuationAudit(client,caseId,writer.generation,`checkpoint:${checkpoint.unit}`,{schemaVersion:1,kind:"checkpoint_published",unit:checkpoint.unit,inputHash:checkpoint.inputHash,resultHash:checkpoint.resultHash ?? null,publicationHash,runId:writer.runId});
  });
}

async function recordContinuationEvents(client: PoolClient, caseId: string, events: readonly RecordedEvent[]): Promise<void> {
  for (const {seq,at,...body} of events) {
    if(!Number.isSafeInteger(seq) || seq < 1 || !Number.isFinite(Date.parse(at))) throw new Error("Invalid continuation event sequence or date");
    const existing = await client.query<{at:string;body:unknown}>("SELECT at,body FROM events WHERE case_id=$1 AND seq=$2",[caseId,seq]);
    if(existing.rows[0]) {
      if(existing.rows[0].at !== at || continuationJson(existing.rows[0].body) !== continuationJson(body)) throw new Error("Continuation event collision");
      continue;
    }
    const last = await client.query<{seq:number}>("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE case_id=$1",[caseId]);
    if(seq !== last.rows[0].seq+1) throw new Error("Continuation event prefix gap");
    await client.query("INSERT INTO events (case_id,seq,at,body) VALUES ($1,$2,$3,$4)",[caseId,seq,at,continuationJson(body)]);
  }
}

export async function loadContinuationCheckpoints(caseId: string, generation: number): Promise<ContinuationCheckpoint[]> {
  const {rows}=await (await db()).query<{body:ContinuationCheckpoint}>("SELECT body FROM case_continuation_checkpoints WHERE case_id=$1 AND generation=$2 ORDER BY unit",[caseId,generation]);
  return rows.map(row=>row.body);
}

// Serialize starting and stopping with the case row. The workflow can begin
// immediately, but its first database step waits until the run ID is saved.
export async function startCaseWorkflow(id: string, start: () => Promise<{ runId: string }>, cancel: (runId: string) => Promise<void>): Promise<void> {
  const client = await (await db()).connect();
  let runId: string | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: CaseStatus; workflow_run_id: string | null; continuation_generation: number }>("SELECT status, workflow_run_id, continuation_generation FROM cases WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0] || rows[0].status !== "queued" || rows[0].workflow_run_id || (rows[0].continuation_generation ?? 0) !== 0) throw new Error("El caso no está disponible para iniciar.");
    runId = (await start()).runId;
    await client.query("UPDATE cases SET workflow_run_id = $2 WHERE id = $1", [id, runId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (runId) {
      try { await cancel(runId); } catch (cancelError) { console.error("Could not cancel unrecorded workflow:", cancelError); }
    }
    throw error;
  } finally { client.release(); }
}

export async function stopCaseWorkflow(id: string, cancel: (runId: string) => Promise<void>): Promise<"stopped" | "missing" | "inactive" | "unavailable"> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: CaseStatus; workflow_run_id: string | null; continuation_generation: number }>("SELECT status, workflow_run_id, continuation_generation FROM cases WHERE id = $1 FOR UPDATE", [id]);
    const row = rows[0];
    if (row && (row.continuation_generation ?? 0) !== 0) { await client.query("ROLLBACK"); return "unavailable"; }
    if (!row || (row.status !== "queued" && row.status !== "in_session") || !row.workflow_run_id) {
      await client.query("ROLLBACK");
      return !row ? "missing" : row.status !== "queued" && row.status !== "in_session" ? "inactive" : "unavailable";
    }
    await cancel(row.workflow_run_id);
    await client.query("UPDATE cases SET status = 'failed', error = $2, stopped_workflow_run_id = workflow_run_id WHERE id = $1", [id, "El análisis fue detenido por un administrador."]);
    await client.query("COMMIT");
    return "stopped";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

// Persist the detection so retries reuse the same language as the first attempt.
export async function saveCaseLanguage(id: string, language: string, writer?: ContinuationWriter): Promise<void> {
  await withCaseMutation(id,writer,async(client) => {
    const result = await client.query("UPDATE cases SET submission = jsonb_set(submission, '{resolvedLanguage}', to_jsonb($2::text)) WHERE id = $1 AND ($3::boolean = false OR submission->>'resolvedLanguage' = $2)", [id,language,!!writer]);
    if(writer && result.rowCount !== 1) throw new Error("Continuation language cannot change");
  });
}

// The models configured when the session opened; a restarted session records its own.
export async function saveCaseModels(id: string, models: ModelSnapshot, writer?: ContinuationWriter): Promise<void> {
  await withCaseMutation(id,writer,async(client) => {
    const result = await client.query("UPDATE cases SET models = $2 WHERE id = $1 AND ($3::boolean = false OR models = $2::jsonb)",[id,JSON.stringify(models),!!writer]);
    if(writer && result.rowCount !== 1) throw new Error("Continuation models cannot change");
  });
}

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL ?? process.env.POSTGRES_URL);
}

// Admin overrides of the default model for each role; a missing row means the default.
export async function getModelSettings(): Promise<ModelSetting[]> {
  const { rows } = await (await db()).query<{ role: string; model_id: string; effort: string | null }>("SELECT role, model_id, effort FROM model_settings ORDER BY role");
  return rows.map((row) => ({ role: row.role, modelId: row.model_id, effort: row.effort }));
}

// A null setting restores the default by removing the override.
export async function saveModelSettings(changes: ReadonlyArray<{ role: string; setting: { modelId: string; effort: string | null } | null }>, updatedBy: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const now = new Date().toISOString();
    for (const { role, setting } of changes) {
      if (!setting) await client.query("DELETE FROM model_settings WHERE role = $1", [role]);
      else await client.query(
        `INSERT INTO model_settings (role, model_id, effort, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (role) DO UPDATE SET model_id = EXCLUDED.model_id, effort = EXCLUDED.effort, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [role, setting.modelId, setting.effort, now, updatedBy]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Existing Blob writers now fence under the same exclusive case row lock as
// reservation/deletion. Generation-isolated objects still require step 4.
export async function withCaseWriteLock<T>(id: string, write: () => Promise<T>, writer?: ContinuationWriter): Promise<T> {
  return withCaseMutation(id,writer,() => {
    if (writer) requireContinuationEnabled(); // Generation-isolated Blob writer is step 4.
    return write();
  });
}

// Keep the row locked while validating cleanup, before callbacks or cascades.
// HTTP checks and a no-op callback cannot authorize losing private references.
export async function deleteCase(id: string, deleteBlobs: (ids: string[]) => Promise<void>): Promise<"deleted" | "missing" | "active"> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: CaseStatus; stopped_workflow_run_id: string | null; continuation_generation: number }>("SELECT status, stopped_workflow_run_id, continuation_generation FROM cases WHERE id = $1 FOR UPDATE", [id]);
    if (!rows.length) {
      await client.query("ROLLBACK");
      return "missing";
    }
    if ((rows[0].continuation_generation ?? 0) !== 0 || (rows[0]!.status !== "resolved" && rows[0]!.status !== "failed")) {
      await client.query("ROLLBACK");
      return "active";
    }
    assertSandboxCleanupSafe();
    if (rows[0]!.stopped_workflow_run_id && !await stoppedRunSettled(rows[0]!.stopped_workflow_run_id)) {
      await client.query("ROLLBACK");
      return "active";
    }
    const aliases = await client.query<{ old_id: string }>("SELECT old_id FROM case_aliases WHERE case_id = $1", [id]);
    await deleteBlobs([id, ...aliases.rows.map((row) => row.old_id)]);
    await client.query("DELETE FROM cases WHERE id = $1", [id]);
    await client.query("COMMIT");
    return "deleted";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Reuse the public case id, but clear all data produced by the previous run.
// The original submission (including an uploaded image) remains the workflow input.
export async function restartCase(id: string, deleteBlobs: (ids: string[]) => Promise<void>, expectedStatus?: "failed"): Promise<"queued" | "missing" | "active" | "missing-image"> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: CaseStatus; stopped_workflow_run_id: string | null; continuation_generation: number }>("SELECT status, stopped_workflow_run_id, continuation_generation FROM cases WHERE id = $1 FOR UPDATE", [id]);
    if (!rows.length) {
      await client.query("ROLLBACK");
      return "missing";
    }
    if ((rows[0].continuation_generation ?? 0) !== 0 || (expectedStatus && rows[0]!.status !== expectedStatus) || (rows[0]!.status !== "resolved" && rows[0]!.status !== "failed")) {
      await client.query("ROLLBACK");
      return "active";
    }
    const input = await client.query<{ missing_image: boolean }>(
      "SELECT submission->>'kind' = 'image' AND NOT EXISTS (SELECT 1 FROM images WHERE case_id = $1) AS missing_image FROM cases WHERE id = $1", [id]
    );
    if (input.rows[0]!.missing_image) {
      await client.query("ROLLBACK");
      return "missing-image";
    }
    assertSandboxCleanupSafe();
    if (rows[0]!.stopped_workflow_run_id && !await stoppedRunSettled(rows[0]!.stopped_workflow_run_id)) {
      await client.query("ROLLBACK");
      return "active";
    }
    const aliases = await client.query<{ old_id: string }>("SELECT old_id FROM case_aliases WHERE case_id = $1", [id]);
    await deleteBlobs([id, ...aliases.rows.map((row) => row.old_id)]);
    await client.query("DELETE FROM events WHERE case_id = $1", [id]);
    await client.query("DELETE FROM covers WHERE case_id = $1", [id]);
    for (const table of ["case_source_operations", "case_source_aliases", "case_phase_sessions", "case_audit_records", "case_sandbox_bindings"]) {
      await client.query(`DELETE FROM ${table} WHERE case_id = $1`, [id]);
    }
    await client.query(
      "UPDATE cases SET created_at = $2, status = 'queued', submission = submission - 'resolvedLanguage', error = NULL, revision = revision + 1, models = NULL, pipeline_version = NULL, workflow_run_id = NULL, stopped_workflow_run_id = NULL WHERE id = $1",
      [id, new Date().toISOString()]
    );
    await client.query("COMMIT");
    return "queued";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Old ids keep resolving after a case is renamed, so shared links still work.
export async function findCaseAlias(oldId: string): Promise<string | undefined> {
  const { rows } = await (await db()).query<{ case_id: string }>("SELECT case_id FROM case_aliases WHERE old_id = $1", [oldId]);
  return rows[0]?.case_id;
}

export async function caseIdTaken(id: string): Promise<boolean> {
  const { rowCount } = await (await db()).query("SELECT 1 FROM cases WHERE id = $1 UNION ALL SELECT 1 FROM case_aliases WHERE old_id = $1", [id]);
  return Boolean(rowCount);
}

// Moves a case and its rows to a new id in one transaction and records the old id as an alias.
export async function renameCase(oldId: string, newId: string): Promise<void> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await assertCaseWriter(client,oldId);
    const { rowCount } = await client.query(
      "INSERT INTO cases (id, created_at, status, submission, owner_id, error, revision, models, pipeline_version, workflow_run_id, stopped_workflow_run_id) SELECT $2, created_at, status, submission, owner_id, error, revision, models, pipeline_version, workflow_run_id, stopped_workflow_run_id FROM cases WHERE id = $1",
      [oldId, newId]
    );
    if (rowCount !== 1) throw new Error("case " + oldId + " does not exist");
    await client.query("UPDATE events SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE images SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE covers SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    await client.query("UPDATE case_aliases SET case_id = $2 WHERE case_id = $1", [oldId, newId]);
    for (const table of ["case_source_operations", "case_source_aliases", "case_phase_sessions", "case_audit_records", "case_sandbox_bindings"]) {
      await client.query(`UPDATE ${table} SET case_id = $2 WHERE case_id = $1`, [oldId, newId]);
    }
    await client.query("DELETE FROM cases WHERE id = $1", [oldId]);
    await client.query("INSERT INTO case_aliases (old_id, case_id) VALUES ($1, $2)", [oldId, newId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getCase(id: string): Promise<StoredCaseRecord | undefined> {
  const { rows } = await (await db()).query<CaseRow>("SELECT * FROM cases WHERE id = $1", [id]);
  return rows[0] && toRecord(rows[0]);
}

export async function listCases(limit = 20): Promise<StoredCaseRecord[]> {
  const { rows } = await (await db()).query<CaseRow>("SELECT * FROM cases ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(toRecord);
}

export async function getImage(caseId: string): Promise<StoredImage | undefined> {
  const { rows } = await (await db()).query<{ mime_type: string; bytes: Buffer }>("SELECT mime_type, bytes FROM images WHERE case_id = $1", [caseId]);
  return rows[0] && { mimeType: rows[0].mime_type, bytes: rows[0].bytes };
}

export interface StoredCover extends StoredImage {
  sourceUrl?: string;
  generated: boolean;
}

// Idempotent: a retried step or a regenerated cover replaces the previous one.
export async function saveCover(caseId: string, cover: Omit<StoredCover, "bytes"> & { bytes: Uint8Array }, writer?: ContinuationWriter): Promise<void> {
  await withCaseMutation(caseId,writer,async(client) => {
    if (writer) requireContinuationEnabled(); // Preserve the original cover until versioned storage exists.
    await client.query(
    `INSERT INTO covers (case_id, mime_type, bytes, source_url, generated, saved_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (case_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, bytes = EXCLUDED.bytes, source_url = EXCLUDED.source_url, generated = EXCLUDED.generated, saved_at = EXCLUDED.saved_at`,
    [caseId, cover.mimeType, Buffer.from(cover.bytes), cover.sourceUrl ?? null, cover.generated, new Date().toISOString()]
  ); });
}

export async function getCover(caseId: string): Promise<StoredCover | undefined> {
  const { rows } = await (await db()).query<{ mime_type: string; bytes: Buffer; source_url: string | null; generated: boolean }>(
    "SELECT mime_type, bytes, source_url, generated FROM covers WHERE case_id = $1",
    [caseId]
  );
  return rows[0] && { mimeType: rows[0].mime_type, bytes: rows[0].bytes, sourceUrl: rows[0].source_url ?? undefined, generated: rows[0].generated };
}

// Case id -> cover version, so a regenerated cover gets a new URL and the old one can be cached forever.
export async function coverVersions(caseIds: readonly string[]): Promise<Map<string, string>> {
  if (!caseIds.length) return new Map();
  const { rows } = await (await db()).query<{ case_id: string; saved_at: string | null }>("SELECT case_id, saved_at FROM covers WHERE case_id = ANY($1)", [caseIds]);
  return new Map(rows.map((r) => [r.case_id, r.saved_at ? String(Date.parse(r.saved_at)) : "0"]));
}

export async function getEvents(caseId: string): Promise<RecordedEvent[]> {
  const { rows } = await (await db()).query<{ seq: number; at: string; body: object }>("SELECT seq, at, body FROM events WHERE case_id = $1 ORDER BY seq", [caseId]);
  return rows.map((r) => ({ ...r.body, seq: r.seq, at: r.at }) as RecordedEvent);
}

export type CaseProgress = { status: CaseStatus; revision: number; seq: number; activity?: number };

// One small snapshot for SSE, without loading submissions, model output or audit logs.
export async function getCaseProgress(caseId: string): Promise<CaseProgress | undefined> {
  const { rows } = await (await db()).query<CaseProgress>(
    "SELECT status, revision, COALESCE((SELECT MAX(seq) FROM events WHERE case_id = cases.id), 0) AS seq, " +
    "(SELECT COUNT(*)::int FROM case_audit_records WHERE case_id = cases.id AND record_id LIKE 'tool:%') AS activity FROM cases WHERE id = $1",
    [caseId]
  );
  return rows[0];
}

// Idempotent: a retried step re-inserts the same (case_id, seq) rows and they are ignored.
export async function recordEvents(caseId: string, events: readonly RecordedEvent[], writer?: ContinuationWriter): Promise<void> {
  if (writer) throw new Error("Continuation events require atomic checkpoint and phase publication");
  await withCaseMutation(caseId,writer,async(client) => {
  if (!events.length) return;
  const values: unknown[] = [caseId];
  const rows = events.map(({ seq, at, ...body }) => {
    values.push(seq, at, JSON.stringify(body));
    return "($1, $" + (values.length - 2) + ", $" + (values.length - 1) + ", $" + values.length + ")";
  });
  // If a closed case receives new events, invalidate its old revision atomically.
  await client.query(
    "WITH inserted AS (INSERT INTO events (case_id, seq, at, body) VALUES " + rows.join(", ") +
    " ON CONFLICT (case_id, seq) DO NOTHING RETURNING case_id) " +
    "UPDATE cases SET revision = revision + 1 WHERE id = $1 AND status = 'resolved' AND EXISTS (SELECT 1 FROM inserted)",
    values
  );
  });
}

// Select a pipeline only on first opening; shared retries retain their record.
export async function openSession(id: string, requestedPipeline: PipelineVersion | ((submission: Submission) => PipelineVersion | Promise<PipelineVersion>) = 1): Promise<CaseRecord> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await assertCaseWriter(client,id);
    let selected: PipelineVersion = 1;
    if (typeof requestedPipeline === "function") {
      const { rows } = await client.query<{ id: string; submission: Submission }>("SELECT id, submission FROM cases WHERE id = $1 AND pipeline_version IS NULL AND models IS NULL AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM events WHERE case_id = $1) FOR UPDATE", [id]);
      if (rows[0]) selected = await requestedPipeline(rows[0].submission);
    } else selected = requestedPipeline;
    if (sharedPipeline(selected)) await client.query("UPDATE cases SET pipeline_version = " + selected + " WHERE id = $1 AND pipeline_version IS NULL AND models IS NULL AND status = 'queued' AND NOT EXISTS (SELECT 1 FROM events WHERE case_id = $1)", [id]);
    const { rows } = await client.query<CaseRow>("UPDATE cases SET status = 'in_session', error = NULL, pipeline_version = COALESCE(pipeline_version, 1) WHERE id = $1 AND status IN ('queued', 'in_session') RETURNING *", [id]);
    if (!rows[0]) throw new Error("case " + id + " does not exist or is no longer active");
    if (!sharedPipeline(rows[0].pipeline_version)) await client.query("DELETE FROM events WHERE case_id = $1", [id]);
    await client.query("COMMIT");
    return toRecord(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// User retries are fresh reruns too. The same reset/row lock drops old generated
// state, and only one caller wins the failed -> queued transition.
export async function requeueCase(id: string, deleteBlobs: (ids: string[]) => Promise<void>): Promise<boolean> {
  return await restartCase(id, deleteBlobs, "failed") === "queued";
}

export async function finishCase(id: string, status: "resolved" | "failed", error?: string, writer?: ContinuationWriter): Promise<void> {
  await withCaseMutation(id,writer,async(client) => {
  if(writer && status === "resolved") requireContinuationEnabled();
  if(writer) {
    await client.query("UPDATE case_continuation_generations SET state='finished' WHERE case_id=$1 AND generation=$2",[id,writer.generation]);
    await continuationAudit(client,id,writer.generation,"finished",{schemaVersion:1,kind:"finished",status,runId:writer.runId});
  }
  if (status === "failed") {
    // The state change and alert commit together. Retried steps cannot duplicate it.
    await client.query(
      `WITH updated AS (UPDATE cases SET status = 'failed', error = $2 WHERE id = $1 AND status <> 'failed' AND stopped_workflow_run_id IS NULL RETURNING id)
       INSERT INTO admin_notifications (created_at, title, message, case_id)
       SELECT $3, 'Falló un caso', $4, id FROM updated`,
      [id, error ?? null, new Date().toISOString(), caseFailureMessage(error)]
    );
    return;
  }
  await client.query("UPDATE cases SET status = $1, error = $2, revision = revision + CASE WHEN $1 = 'resolved' AND status <> 'resolved' THEN 1 ELSE 0 END WHERE id = $3 AND stopped_workflow_run_id IS NULL", [status, error ?? null, id]);
  });
}

// A resolved case whose stored files are gone becomes a failed run that an admin can
// rerun. The revision guard keeps a concurrent rerun from being marked failed.
export async function failResolvedCase(id: string, revision: number, error: string): Promise<boolean> {
  return withCaseMutation(id,undefined,async(client) => {
  const { rowCount } = await client.query(
    `WITH updated AS (UPDATE cases SET status = 'failed', error = $3 WHERE id = $1 AND status = 'resolved' AND revision = $2 RETURNING id)
     INSERT INTO admin_notifications (created_at, title, message, case_id)
     SELECT $4, 'Falló un caso', $5, id FROM updated`,
    [id, revision, error, new Date().toISOString(), caseFailureMessage(error)]
  );
  return rowCount === 1;
  });
}

export type AdminNotification = { id: string; created_at: string; title: string; message: string; case_id: string | null; read_at: string | null };

const MAX_NOTIFICATION_ID = 9223372036854775807n;
const validNotificationId = (id: string) => /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= MAX_NOTIFICATION_ID;

export async function listAdminNotifications(before?: string): Promise<AdminNotification[]> {
  if (before && !validNotificationId(before)) before = undefined;
  const { rows } = await (await db()).query<AdminNotification>("SELECT id::text, created_at, title, message, case_id, read_at FROM admin_notifications WHERE ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT 101", [before ?? null]);
  return rows;
}

export async function hasUnreadAdminNotifications(): Promise<boolean> {
  const { rows } = await (await db()).query<{ unread: boolean }>("SELECT EXISTS (SELECT 1 FROM admin_notifications WHERE read_at IS NULL) AS unread");
  return rows[0]!.unread;
}

export async function markAdminNotificationsRead(throughId: string): Promise<void> {
  if (!validNotificationId(throughId)) throw new Error("Notificación inválida");
  await (await db()).query("UPDATE admin_notifications SET read_at = $1 WHERE read_at IS NULL AND id <= $2::bigint", [new Date().toISOString(), throughId]);
}

export async function deleteAdminNotification(id: string): Promise<boolean> {
  if (!validNotificationId(id)) throw new Error("Notificación inválida");
  const { rowCount } = await (await db()).query("DELETE FROM admin_notifications WHERE id = $1::bigint", [id]);
  return rowCount === 1;
}

export async function recordSnapshotHealth(health: SnapshotHealth): Promise<boolean> {
  // Only a state transition creates a log entry, including after a problem recurs.
  const { rows } = await (await db()).query(
    `WITH changed AS (
       INSERT INTO admin_notification_conditions (condition_key, state) VALUES ('snapshot', $1)
       ON CONFLICT (condition_key) DO UPDATE SET state = EXCLUDED.state
       WHERE admin_notification_conditions.state <> EXCLUDED.state RETURNING state
     )
     INSERT INTO admin_notifications (created_at, title, message)
     SELECT $2, $3, $4 FROM changed WHERE $5::boolean RETURNING id`,
    [health.state, new Date().toISOString(), health.title ?? "", health.message ?? "", !!health.title]
  );
  return rows.length > 0;
}

// Short row-locked ownership claims; no external I/O runs in this transaction.
function assertOperationWriter(operation: Operation, scopedKey: string, writer?: ContinuationWriter): void {
  if (!writer) return;
  if (scopedKey !== `generation:${writer.generation}:${operation.key}` ||
      operation.writer?.generation !== writer.generation || operation.writer.runId !== writer.runId) {
    throw new Error("Source operation writer or key mismatch");
  }
  if (typeof operation.inputJson !== "string" || !operation.inputHash) throw new Error("Continuation external intention incomplete");
  const input = JSON.parse(operation.inputJson);
  if (continuationJson(input) !== operation.inputJson || continuationHash(input) !== operation.inputHash) throw new Error("Source operation durable input mismatch");
  if (!["pending", "running", "failed", "uncertain"].includes(operation.status)) throw new Error("Continuation external result reuse blocked: complete result and artifacts are not verified");
  if (operation.status === "pending" && (operation.owner !== undefined || operation.expiresAt !== undefined)) throw new Error("Source operation pending ownership inconsistent");
  if (operation.status === "running" && (!operation.owner || !Number.isFinite(Date.parse(operation.expiresAt ?? "")))) throw new Error("Source operation ownership incomplete");
}

function assertOperationPredecessors(caseId: string, key: string, scopedKey: string, writer: ContinuationWriter, rows: Array<{ case_id: string; operation_key: string; body: Operation }>): void {
  try {
    for (const row of rows) {
      // Do not filter candidates by a possibly corrupt key/body. Every row must
      // have an unambiguous identity before it can be declared independent.
      continuationJson(row.body);
      const operation = row.body;
      if (row.case_id !== caseId || typeof row.operation_key !== "string" || !row.operation_key.trim() ||
          !operation || typeof operation.key !== "string" || !operation.key.trim() ||
          typeof operation.stage !== "string" || !operation.stage.trim() ||
          typeof operation.at !== "string" || !Number.isFinite(Date.parse(operation.at)) ||
          !Array.isArray(operation.recoveries) || !["pending", "running", "failed", "uncertain", "ready"].includes(operation.status)) throw new Error();
      if (operation.status === "pending") {
        if (operation.owner !== undefined || operation.expiresAt !== undefined || operation.result !== undefined) throw new Error();
      } else if (typeof operation.owner !== "string" || !operation.owner.trim() ||
                 typeof operation.expiresAt !== "string" || !Number.isFinite(Date.parse(operation.expiresAt))) throw new Error();
      if (operation.status === "ready" && operation.result === undefined) throw new Error();
      if (operation.writer !== undefined) {
        if (!operation.writer || !Number.isSafeInteger(operation.writer.generation) || operation.writer.generation < 1 ||
            operation.writer.generation > writer.generation || typeof operation.writer.runId !== "string" || !operation.writer.runId.trim() ||
            (operation.writer.generation === writer.generation && operation.writer.runId !== writer.runId)) throw new Error();
        // Exact reconstruction, not LIKE, suffix matching, numeric parsing or
        // stripping prefixes: logical keys may themselves contain generation:.
        assertOperationWriter(operation, row.operation_key, operation.writer);
      } else {
        // A legacy key in the reserved prefix can also name a generational
        // physical row with missing writer/key metadata. Never guess which.
        if (row.operation_key !== operation.key || row.operation_key.startsWith("generation:") || operation.inputJson !== undefined) throw new Error();
      }
      if (row.operation_key === scopedKey) assertOperationWriter(operation, scopedKey, writer);
      else if (operation.key === key) throw new Error();
    }
  } catch {
    throw new Error("Continuation external predecessor blocked: ambiguous inventory or unreconciled predecessor");
  }
}

async function changeOperation<T>(caseId: string, key: string, change: (operation: Operation) => T, initial?: Operation, writer?: ContinuationWriter): Promise<T> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    await assertCaseWriter(client,caseId,writer);
    if (initial && writer) {
      // A fresh namespace is not reconciliation of an older effect. Even a
      // predecessor called ready lacks the new result/artifact guarantees.
      const inventory = await client.query<{ case_id: string; operation_key: string; body: Operation }>("SELECT case_id, operation_key, body FROM case_source_operations WHERE case_id = $1 FOR UPDATE", [caseId]);
      assertOperationPredecessors(caseId, initial.key, key, writer, inventory.rows);
    }
    if (initial) await client.query("INSERT INTO case_source_operations (case_id, operation_key, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [caseId, key, JSON.stringify(initial)]);
    const { rows } = await client.query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 AND operation_key = $2 FOR UPDATE", [caseId, key]);
    const operation = rows[0]?.body;
    if (!operation) throw new Error("Source operation not found");
    assertOperationWriter(operation,key,writer);
    if (operation.status === "running" && Date.parse(operation.expiresAt!) <= Date.now()) {
      operation.status = "uncertain";
      operation.error = "Owner expired before checkpoint";
    }
    const value = change(operation);
    await client.query("UPDATE case_source_operations SET body = $3 WHERE case_id = $1 AND operation_key = $2", [caseId, key, JSON.stringify(operation)]);
    if(writer) await continuationAudit(client,caseId,writer.generation,`operation:${continuationHash(key)}:${operation.status}:${operation.owner ?? "none"}`,{schemaVersion:1,kind:"operation_state",operation:operation.key,stage:operation.stage,inputHash:operation.inputHash ?? null,state:operation.status,runId:writer.runId,owner:operation.owner ?? null});
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function requireOperationOwner(operation: Operation, owner: string): void {
  if (operation.status !== "running" || operation.owner !== owner) throw new Error("Operation ownership lost");
}

export function sourceOperationRepositoryFor(writer?: ContinuationWriter): OperationRepository {
  // Copy once, before any await. Caller mutation cannot change this scope
  // between key construction, row-lock validation, and audit/publication.
  if (writer) {
    continuationJson(writer);
    if (!Number.isSafeInteger(writer.generation) || writer.generation < 1 || typeof writer.runId !== "string" || !writer.runId.trim()) throw new Error("Invalid operation writer");
    writer = Object.freeze({ generation: writer.generation, runId: writer.runId });
  }
  const scoped = (key: string) => writer ? `generation:${writer.generation}:${key}` : key;
  return {
  ...(writer ? {writer} : {}),
  claim: async (caseId, key, stage, leaseMs, inputHash, input): Promise<OperationClaim> => {
    if(writer && (!inputHash || !/^[a-f0-9]{64}$/.test(inputHash))) throw new Error("Continuation external intention requires input hash");
    // Canonicalize/copy before the first await; caller objects are never retained.
    const inputJson = writer ? continuationJson(input) : undefined;
    if (writer && continuationHash(JSON.parse(inputJson!)) !== inputHash) throw new Error("Source operation input hash mismatch");
    if (writer && (!key.trim() || !stage.trim() || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isFinite(new Date(Date.now() + leaseMs).getTime()))) throw new Error("Invalid continuation operation claim");
    return changeOperation(caseId, scoped(key), (operation) => {
    if (operation.stage !== stage) throw new Error("Source operation stage mismatch");
    if(inputHash && operation.inputHash !== inputHash) throw new Error("Source operation input mismatch");
    if(writer && operation.inputJson !== inputJson) throw new Error("Source operation input mismatch");
    if (operation.status !== "pending") return { owned: false, operation };
    const owner = randomUUID();
    Object.assign(operation, { status: "running", owner, at: new Date().toISOString(), expiresAt: new Date(Date.now() + leaseMs).toISOString() });
    return { owned: true, operation, owner };
  }, { key, stage, status: "pending", at: new Date().toISOString(), recoveries: [], ...(inputHash ? {inputHash} : {}), ...(writer ? {writer,inputJson} : {}) },writer);
  },
  get: async (caseId, key) => {
    if (writer) {
      // A poll is an access to this generation, not an unfenced cache read.
      return withCaseMutation(caseId,writer,async (client) => {
        const { rows } = await client.query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 AND operation_key = $2 FOR UPDATE", [caseId, scoped(key)]);
        const operation = rows[0]?.body;
        if (!operation) return undefined;
        assertOperationWriter(operation,scoped(key),writer);
        if (operation.status === "running" && Date.parse(operation.expiresAt!) <= Date.now()) {
          operation.status = "uncertain";
          operation.error = "Owner expired before checkpoint";
          await client.query("UPDATE case_source_operations SET body = $3 WHERE case_id = $1 AND operation_key = $2", [caseId, scoped(key), JSON.stringify(operation)]);
          await continuationAudit(client,caseId,writer.generation,`operation:${continuationHash(scoped(key))}:uncertain:${operation.owner}`,{schemaVersion:1,kind:"operation_state",operation:operation.key,stage:operation.stage,inputHash:operation.inputHash,state:operation.status,runId:writer.runId,owner:operation.owner});
        }
        return operation;
      });
    }
    const { rows } = await (await db()).query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 AND operation_key = $2", [caseId, scoped(key)]);
    const operation = rows[0]?.body;
    if (operation?.status === "running" && Date.parse(operation.expiresAt!) <= Date.now()) return changeOperation(caseId, scoped(key), (current) => current,undefined,writer);
    return operation;
  },
  publish: async (caseId, key, owner, result) => {
    if(writer) throw new Error("Continuation external ready publication blocked: artifact/result validators not implemented");
    return changeOperation(caseId, scoped(key), (operation) => {
    requireOperationOwner(operation, owner);
    Object.assign(operation, { status: "ready", at: new Date().toISOString(), result });
  },undefined,writer);
  },
  fail: async (caseId, key, owner, error, uncertain) => changeOperation(caseId, scoped(key), (operation) => {
    requireOperationOwner(operation, owner);
    // New-path failures cannot establish that an external effect did not occur.
    Object.assign(operation, { status: uncertain || writer ? "uncertain" : "failed", at: new Date().toISOString(), error });
  },undefined,writer),
  defer: async (caseId, key, owner) => {
    if(writer) throw new Error("Continuation defer blocked: absence of external effects is not verified");
    return changeOperation(caseId, scoped(key), (operation) => {
    requireOperationOwner(operation, owner);
    if (operation.stage !== "canonical") throw new Error("External stages cannot be deferred");
    operation.status = "pending";
    delete operation.owner; delete operation.expiresAt;
  },undefined,writer);
  },
  recover: async (caseId, key, reason) => {
    if(writer) throw new Error("Continuation recovery blocked: administrator authorization and inactivity reconciliation required");
    if (!reason.trim()) throw new Error("Recovery requires an explicit reason");
    await changeOperation(caseId, scoped(key), (operation) => {
      if (!["failed", "uncertain"].includes(operation.status)) throw new Error("Only failed/uncertain operations can be recovered");
      operation.recoveries.push({ at: new Date().toISOString(), reason });
      operation.status = "pending";
      delete operation.owner; delete operation.error; delete operation.expiresAt;
    },undefined,writer);
  },
  alias: async (caseId, url, sourceId) => {
    return withCaseMutation(caseId,writer,async(client) => {
    const { rows } = await client.query<{ source_id: string }>(
      `INSERT INTO case_source_aliases (case_id, url, source_id) VALUES ($1, $2, $3)
       ON CONFLICT (case_id, url) DO UPDATE SET url = EXCLUDED.url RETURNING source_id`, [caseId, scoped(url), sourceId]);
    if(writer && rows[0]?.source_id !== sourceId) throw new Error("Continuation source alias collision");
    if(writer) await continuationAudit(client,caseId,writer.generation,`alias:${continuationHash(url)}`,{schemaVersion:1,kind:"source_alias",urlHash:continuationHash(url),sourceId,runId:writer.runId});
    return rows[0]!.source_id;
    });
  },
  resolve: async (caseId, url) => {
    if (writer) return withCaseMutation(caseId,writer,async (client) => {
      const { rows } = await client.query<{ source_id: string }>("SELECT source_id FROM case_source_aliases WHERE case_id = $1 AND url = $2", [caseId, scoped(url)]);
      return rows[0]?.source_id;
    });
    const { rows } = await (await db()).query<{ source_id: string }>("SELECT source_id FROM case_source_aliases WHERE case_id = $1 AND url = $2", [caseId, scoped(url)]);
    return rows[0]?.source_id;
  },
  };
}
export const sourceOperationRepository = sourceOperationRepositoryFor();

type RetainedPhaseRow = { case_id: string; generation: number; session_key: string; run_id: string; revision: number; body: unknown; body_hash: string };
function retainedPhaseRow(row: RetainedPhaseRow, caseId: string, key: string, writer: ContinuationWriter) {
  const snapshot = continuationPhaseSnapshot(row.body, caseId, writer);
  if (row.case_id !== caseId || row.generation !== writer.generation || row.run_id !== writer.runId || row.session_key !== key || snapshot.sessionKey !== key || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision >= 2147483647 || row.body_hash !== continuationHash(snapshot)) throw new Error("Continuation phase blocked: corrupt durable identity/hash/revision");
  return { revision: row.revision, snapshot };
}
async function retainedPhaseRecord(client: PoolClient, caseId: string, through: number): Promise<RecordedEvent[]> {
  const { rows } = await client.query<{ seq: number; at: string; body: CourtEvent }>("SELECT seq, at, body FROM events WHERE case_id = $1 AND seq <= $2 ORDER BY seq", [caseId, through]);
  return rows.map(({ seq, at, body }) => {
    continuationJson(body);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.type !== "string" || Object.hasOwn(body, "seq") || Object.hasOwn(body, "at") || !Number.isSafeInteger(seq) || seq < 1 || typeof at !== "string" || !Number.isFinite(Date.parse(at))) throw new Error("Continuation phase blocked: corrupt committed event columns/body");
    return { ...body, seq, at };
  });
}
function retainedPhaseAuditBody(snapshot: ContinuationPhaseSnapshot, revision: number) {
  return { kind: "phase_state_retained", status: "blocked", sessionKey: snapshot.sessionKey, revision, runId: snapshot.runId,
    bodyHash: continuationHash(snapshot), recordHash: snapshot.recordHash, cursor: snapshot.body.cursor };
}
async function verifyRetainedPhaseAudit(client: PoolClient, retained: { revision: number; snapshot: ContinuationPhaseSnapshot }): Promise<void> {
  const { snapshot, revision } = retained;
  const id = `phase-state:v1:${continuationHash(snapshot.sessionKey)}:${revision}`;
  const { rows } = await client.query<{ body: unknown }>("SELECT body FROM case_continuation_audit WHERE case_id=$1 AND generation=$2 AND record_id=$3", [snapshot.caseId, snapshot.generation, id]);
  if (rows.length !== 1 || continuationJson(rows[0].body) !== continuationJson(retainedPhaseAuditBody(snapshot, revision))) throw new Error("Continuation phase blocked: durable audit missing/corrupt");
}

// Real durable storage, permanently blocked. Deliberately NOT a PhaseRepository
// adapter: retaining a candidate never authorizes begin(), results or effects.
export async function retainContinuationPhaseSnapshot(caseId: string, writerInput: ContinuationWriter, expectedRevision: number, input: unknown): Promise<number> {
  const writer = continuationPhaseWriter(writerInput), snapshot = continuationPhaseSnapshot(input, caseId, writer);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < -1 || expectedRevision >= 2147483646) throw new Error("Invalid continuation phase CAS revision");
  const body = continuationJson(snapshot), bodyHash = continuationHash(snapshot);
  return withCaseMutation(caseId, writer, async client => {
    const { rows } = await client.query<RetainedPhaseRow>("SELECT case_id, generation, session_key, run_id, revision, body, body_hash FROM case_continuation_phase_states WHERE case_id = $1 AND generation = $2 AND session_key = $3 FOR UPDATE", [caseId, writer.generation, snapshot.sessionKey]);
    const previous = rows[0] ? retainedPhaseRow(rows[0], caseId, snapshot.sessionKey, writer) : undefined;
    const record = await retainedPhaseRecord(client, caseId, Math.max(snapshot.body.cursor, previous?.snapshot.body.cursor ?? 0));
    if (previous) {
      validateContinuationPhaseRecord(previous.snapshot, record.slice(0, previous.snapshot.body.cursor));
      await verifyRetainedPhaseAudit(client, previous);
    }
    validateContinuationPhaseRecord(snapshot, record.slice(0, snapshot.body.cursor));
    if (previous?.revision === expectedRevision + 1 && continuationJson(previous.snapshot) === body) return previous.revision; // Exact lost-COMMIT replay only.
    if ((previous?.revision ?? -1) !== expectedRevision) throw new Error("Concurrent continuation phase snapshot; reread durable state");
    if (previous) validateContinuationPhaseTransition(previous.snapshot, snapshot);
    const revision = expectedRevision + 1;
    const result = expectedRevision === -1
      ? await client.query("INSERT INTO case_continuation_phase_states (case_id,generation,session_key,run_id,revision,body,body_hash) VALUES ($1,$2,$3,$4,0,$5,$6) ON CONFLICT DO NOTHING", [caseId, writer.generation, snapshot.sessionKey, writer.runId, body, bodyHash])
      : await client.query("UPDATE case_continuation_phase_states SET revision=revision+1,body=$5,body_hash=$6 WHERE case_id=$1 AND generation=$2 AND session_key=$3 AND revision=$4", [caseId, writer.generation, snapshot.sessionKey, expectedRevision, body, bodyHash]);
    if (result.rowCount !== 1) throw new Error("Concurrent continuation phase snapshot; CAS lost");
    await continuationAudit(client, caseId, writer.generation, `phase-state:v1:${continuationHash(snapshot.sessionKey)}:${revision}`, retainedPhaseAuditBody(snapshot, revision));
    return revision;
  });
}
export async function loadContinuationPhaseSnapshot(caseId: string, writerInput: ContinuationWriter, key: string): Promise<{ revision: number; snapshot: ContinuationPhaseSnapshot } | undefined> {
  const writer = continuationPhaseWriter(writerInput);
  if (!/^(intake|instruction|criticism|debate):(judge|grok|gemini|claude|chatgpt):(preparation|decision)$/.test(key)) throw new Error("Continuation phase namespace blocked");
  return withCaseMutation(caseId, writer, async client => {
    const { rows } = await client.query<RetainedPhaseRow>("SELECT case_id, generation, session_key, run_id, revision, body, body_hash FROM case_continuation_phase_states WHERE case_id = $1 AND generation = $2 AND session_key = $3 FOR UPDATE", [caseId, writer.generation, key]);
    if (!rows[0]) return undefined;
    const retained = retainedPhaseRow(rows[0], caseId, key, writer);
    validateContinuationPhaseRecord(retained.snapshot, await retainedPhaseRecord(client, caseId, retained.snapshot.body.cursor));
    await verifyRetainedPhaseAudit(client, retained);
    return retained;
  });
}

export async function loadPhaseCheckpoint<T>(caseId: string, key: string, writer?: ContinuationWriter): Promise<{ revision: number; body: T } | undefined> {
  if (writer) {
    const owner = continuationPhaseWriter(writer);
    if (key.startsWith("generation:")) throw new Error("Continuation phase namespace blocked");
    return withCaseMutation(caseId, owner, async client => {
      const { rows } = await client.query<{ revision: number; body: T }>("SELECT revision, body FROM case_phase_sessions WHERE case_id = $1 AND session_key = $2", [caseId, `generation:${owner.generation}:${key}`]);
      return rows[0];
    });
  }
  if (key.startsWith("generation:")) throw new Error("Continuation phase writer required");
  const { rows } = await (await db()).query<{ revision: number; body: T }>("SELECT revision, body FROM case_phase_sessions WHERE case_id = $1 AND session_key = $2", [caseId,key]);
  return rows[0];
}

// expectedRevision=-1 creates a checkpoint; all further updates use CAS.
export async function savePhaseCheckpoint<T>(caseId: string, key: string, expectedRevision: number, body: T, writer?: ContinuationWriter): Promise<number> {
  if (writer) throw new Error("Continuation phase requires atomic checkpoint publication");
  if (key.startsWith("generation:")) throw new Error("Continuation phase writer required");
  return withCaseMutation(caseId,writer,async(client) => {
  // The case lock held by withCaseMutation serializes terminal transitions.
  // Late legacy writers cannot replace retained checkpoints after failure.
  const { rows } = await client.query<{status: string}>("SELECT status FROM cases WHERE id = $1", [caseId]);
  if (rows[0]?.status !== "in_session") throw new Error("Phase checkpoint writer blocked: case is not executing");
  const result = expectedRevision === -1
    ? await client.query("INSERT INTO case_phase_sessions (case_id, session_key, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [caseId, key, JSON.stringify(body)])
    : await client.query("UPDATE case_phase_sessions SET body = $4, revision = revision + 1 WHERE case_id = $1 AND session_key = $2 AND revision = $3 AND (body->>'sandboxId' IS NULL OR body->>'sandboxId' = $4::jsonb->>'sandboxId') AND (body->>'id' IS NULL OR body->>'id' = $4::jsonb->>'id')", [caseId, key, expectedRevision, JSON.stringify(body)]);
  if (result.rowCount !== 1) throw new Error("Concurrent phase-session checkpoint; retry from durable state");
  return expectedRevision + 1;
  });
}

export async function saveCaseAuditRecord(caseId: string, id: string, body: unknown, writer?: ContinuationWriter): Promise<void> {
  await withCaseMutation(caseId,writer,async(client) => {
  if(writer) id = `generation:${writer.generation}:${id}`;
  // The WHERE guard reports conflicts without replacing the first published record.
  const { rowCount } = await client.query(
    `INSERT INTO case_audit_records (case_id, record_id, body) VALUES ($1, $2, $3)
     ON CONFLICT (case_id, record_id) DO UPDATE SET record_id = EXCLUDED.record_id
     WHERE case_audit_records.body = EXCLUDED.body`, [caseId, id, JSON.stringify(body)]);
  if (rowCount !== 1) throw new Error("Public audit record changed on retry");
  });
}

export async function getCaseAuditRecords(caseId: string): Promise<unknown[]> {
  const { rows } = await (await db()).query<{ body: unknown }>("SELECT body FROM case_audit_records WHERE case_id = $1 ORDER BY record_id", [caseId]);
  return rows.map((row) => row.body);
}

// A replay keeps the original invocation time rather than publishing another item.
export async function recordCaseToolActivity(caseId: string, activity: ToolActivity, writer?: ContinuationWriter): Promise<void> {
  const record = ToolActivitySchema.parse(activity);
  await withCaseMutation(caseId,writer,async(client) => { await client.query(
    "INSERT INTO case_audit_records (case_id, record_id, body) VALUES ($1, $2, $3) ON CONFLICT (case_id, record_id) DO NOTHING",
    [caseId, writer ? `generation:${writer.generation}:${record.id}` : record.id, JSON.stringify(record)]
  ); });
}

export async function getCaseToolActivities(caseId: string): Promise<ToolActivity[]> {
  const { rows } = await (await db()).query<{ record_id: string; body: unknown }>(
    "SELECT record_id, body FROM case_audit_records WHERE case_id = $1 AND (record_id LIKE 'tool:%' OR record_id ~ '^generation:[1-9][0-9]*:tool:') ORDER BY body->>'at', record_id", [caseId]
  );
  return rows.flatMap(({record_id,body}) => publicToolActivities([body]).map(activity => {
    const generation = /^generation:([1-9][0-9]*):tool:/.exec(record_id);
    // Keep durable legacy bodies intact, but avoid duplicate timeline keys when
    // two generations replay the same logical invocation ID.
    return generation ? {...activity,id:`tool:generation:${generation[1]}:${activity.id.slice(5)}`} : activity;
  }));
}

// Translations of the English prompts for case.jsonl, shared by every case.
// The key hashes the source text and the language (see prompt-translation.ts).
export const promptTranslations: PromptTranslationCache = {
  get: async (keys) => {
    if (!keys.length) return new Map();
    const { rows } = await (await db()).query<{ key: string; translation: string }>("SELECT key, translation FROM prompt_translations WHERE key = ANY($1)", [[...keys]]);
    return new Map(rows.map((row) => [row.key, row.translation]));
  },
  save: async ({ key, language, source, translation, modelId }) => {
    await (await db()).query(
      "INSERT INTO prompt_translations (key, language, source, translation, model_id, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING",
      [key, language, source, translation, modelId, new Date().toISOString()]
    );
  },
};

export async function getSourceOperations(caseId: string): Promise<Operation[]> {
  const { rows } = await (await db()).query<{ body: Operation }>("SELECT body FROM case_source_operations WHERE case_id = $1 ORDER BY operation_key", [caseId]);
  return rows.map((row) => row.body);
}

export async function saveSandboxBinding(caseId: string, sandboxId: string, body: SandboxBinding, writer?: ContinuationWriter): Promise<void> {
  if(continuationJson(body.writer ?? null) !== continuationJson(writer ?? null)) throw new Error("Sandbox binding writer mismatch");
  await withCaseMutation(caseId,writer,async(client) => {
  const { rows } = await client.query<{status: string}>("SELECT status FROM cases WHERE id = $1", [caseId]);
  if (rows[0]?.status !== "in_session") throw new Error("Sandbox binding writer blocked: case is not executing");
  const { rowCount } = await client.query(
    `INSERT INTO case_sandbox_bindings (case_id, sandbox_id, body) VALUES ($1, $2, $3)
     ON CONFLICT (sandbox_id) DO UPDATE SET body = EXCLUDED.body
     WHERE case_sandbox_bindings.case_id = EXCLUDED.case_id
       AND case_sandbox_bindings.body->>'phaseSessionId' = EXCLUDED.body->>'phaseSessionId'
       AND case_sandbox_bindings.body->>'sessionKey' = EXCLUDED.body->>'sessionKey'
       AND COALESCE(case_sandbox_bindings.body->'writer', 'null'::jsonb) = COALESCE(EXCLUDED.body->'writer', 'null'::jsonb)
       AND case_sandbox_bindings.body->>'revoked' = 'false'`, [caseId, sandboxId, JSON.stringify(body)]);
  if (rowCount !== 1) throw new Error("Sandbox binding cannot be reassigned or unrevoked");
  });
}

export async function consumeSandboxBinding(sandboxId: string, caseId?: string): Promise<{ caseId: string; binding: SandboxBinding }> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query<{case_id:string;body:SandboxBinding}>("SELECT case_id,body FROM case_sandbox_bindings WHERE sandbox_id=$1",[sandboxId]);
    if(!owner.rows[0]) throw new Error("sandbox_forbidden");
    await assertCaseWriter(client,owner.rows[0].case_id,owner.rows[0].body.writer);
    const result = await client.query<{ case_id: string; body: SandboxBinding; status: string; pipeline_version: number; continuation_generation:number; workflow_run_id:string | null }>(
      `SELECT b.case_id, b.body, c.status, c.pipeline_version, c.continuation_generation, c.workflow_run_id FROM case_sandbox_bindings b
       JOIN cases c ON c.id = b.case_id WHERE b.sandbox_id = $1 FOR UPDATE OF b`, [sandboxId]);
    const row = result.rows[0];
    if (!row || (caseId && row.case_id !== caseId)) throw new Error("sandbox_forbidden");
    const events = await client.query<{ body: CourtEvent }>("SELECT body FROM events WHERE case_id = $1 ORDER BY seq", [row.case_id]);
    const session = await client.query<{ body: { id?: string; activeTurn?: { id?: string } } }>("SELECT body FROM case_phase_sessions WHERE case_id = $1 AND session_key = $2", [row.case_id, row.body.sessionKey]);
    authorizeSandboxBinding(row.body, { phase: committedPhase(events.rows.map((event) => event.body)), status: row.status, pipelineVersion: row.pipeline_version, generation:row.continuation_generation, runId:row.workflow_run_id ?? undefined, phaseSessionId: session.rows[0]?.body.id, activeTurnId: session.rows[0]?.body.activeTurn?.id });
    row.body.activeTurn!.remainingRequests--;
    await client.query("UPDATE case_sandbox_bindings SET body = $2 WHERE sandbox_id = $1", [sandboxId, JSON.stringify(row.body)]);
    await client.query("COMMIT");
    return { caseId: row.case_id, binding: row.body };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function caseSandboxNames(caseId: string): Promise<string[]> {
  const { rows } = await (await db()).query<{ sandbox_id: string }>("SELECT sandbox_id FROM case_sandbox_bindings WHERE case_id = $1", [caseId]);
  return rows.map((row) => row.sandbox_id);
}

export async function revokeSandboxBindings(caseId: string, phase?: string, writer?: ContinuationWriter): Promise<void> {
  await withCaseMutation(caseId,writer,async(client) => { await client.query("UPDATE case_sandbox_bindings SET body = jsonb_set(body - 'activeTurn', '{revoked}', 'true'::jsonb) WHERE case_id = $1 AND ($2::text IS NULL OR body->>'phase' = $2) AND ($3::integer IS NULL OR (body->'writer'->>'generation')::integer=$3)", [caseId, phase ?? null,writer?.generation ?? null]); });
}
