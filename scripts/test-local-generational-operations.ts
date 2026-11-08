// Real PostgreSQL fixture. No env loader, existing database or production seam.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { continuationHash, continuationJson, type ContinuationWriter } from "../src/domain/continuation.ts";
import type { Operation } from "../src/instruction/source-store.ts";

const label = "io.grokeado.generational-fixture";
const dataPath = "/var/lib/postgresql/data";
const file = fileURLToPath(import.meta.url);
type Ownership = { context: string; nonce: string; name: string; image: string; network: string; networkId: string; containerId: string; started: number; parentPid: number };
type Descriptor = Ownership & { user: string; database: string; password: string };
export type ContainerProof = {
  id: string; name: string; image: string; labels: Record<string, string>; running: boolean; startedAt: string; observedAt: string;
  mounts: Array<{ Type: string; Destination: string }>; tmpfs: Record<string, string>; privileged: boolean; readonly: boolean; binds: unknown;
  networkMode: string; ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  networks: Record<string, { IPAddress: string }>;
};

export function assertLocalDockerEndpoint(endpoint: string): void {
  assert.ok(/^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_-]+$/.test(endpoint) || endpoint === "unix:///var/run/docker.sock", "Non-local Docker endpoint blocked");
}

export function assertDedicatedContainer(info: ContainerProof, own: Ownership): { port: number; address: string } {
  assert.equal(info.id, own.containerId); assert.equal(info.name, "/" + own.name);
  assert.equal(info.image, own.image); assert.equal(info.labels[label], own.nonce);
  assert.equal(info.running, true); assert.equal(info.privileged, false); assert.equal(info.readonly, true);
  assert.ok(info.binds === null || (Array.isArray(info.binds) && info.binds.length === 0));
  const paths = [dataPath, "/var/run/postgresql", "/tmp"];
  assert.deepEqual(Object.keys(info.tmpfs).sort(), paths.sort());
  assert.ok(info.mounts.every(m => m.Type === "tmpfs" && paths.includes(m.Destination)));
  // Bound StartedAt by samples of the SAME local daemon's clock. Docker Desktop
  // runs in a VM: comparing its timestamp to the host clock can reject a newly
  // created container. Invalid/backward daemon time still fails closed.
  const startedAt = Date.parse(info.startedAt), observedAt = Date.parse(info.observedAt);
  assert.ok(Number.isFinite(own.started) && Number.isFinite(startedAt) && Number.isFinite(observedAt) &&
    observedAt >= own.started && startedAt >= own.started - 1000 && startedAt <= observedAt, "Container start outside this execution's daemon-time window");
  assert.equal(info.networkMode, own.network);
  assert.deepEqual(Object.keys(info.networks), [own.network]);
  assert.deepEqual(Object.keys(info.ports), ["5432/tcp"]);
  const bindings = info.ports["5432/tcp"]!;
  assert.equal(bindings.length, 1, "Dedicated loopback port was not materialized"); assert.equal(bindings[0].HostIp, "127.0.0.1");
  assert.ok(/^[1-9][0-9]*$/.test(bindings[0].HostPort));
  const port = Number(bindings[0].HostPort);
  assert.ok(port > 0 && port <= 65535);
  const address = info.networks[own.network].IPAddress;
  const octets = address.split(".").map(Number);
  assert.ok(octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)), "Private container address required");
  return { port, address };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  // OS/runtime only. Never inherit app DB/provider variables or load .env files.
  const result: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}
function docker(context: string, args: string[], env = cleanEnvironment()): string {
  try { return execFileSync("docker", ["--context", context, ...args], { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { throw new Error("Docker command failed (details suppressed to protect credentials)"); }
}
function localContext(context: string): void {
  assert.ok(/^[a-zA-Z0-9_.-]+$/.test(context));
  assertLocalDockerEndpoint(docker(context, ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]));
  assert.equal(docker(context, ["info", "--format", "{{.OSType}}"]), "linux");
}
function containerInfo(own: Ownership): ContainerProof {
  // Projection deliberately excludes Config.Env and all credentials.
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"privileged":{{json .HostConfig.Privileged}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"binds":{{json .HostConfig.Binds}},"networkMode":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}}}';
  const info = JSON.parse(docker(own.context, ["container", "inspect", own.containerId, "--format", format]));
  return { ...info, observedAt: docker(own.context, ["info", "--format", "{{.SystemTime}}"]) };
}
function checkNetwork(own: Ownership, requireEmpty = false, verifyConfiguration = true): void {
  const n = JSON.parse(docker(own.context, ["network", "inspect", own.networkId, "--format", '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}},"driver":{{json .Driver}},"internal":{{json .Internal}},"ipv6":{{json .EnableIPv6}},"options":{{json .Options}},"containers":{{json .Containers}}}']));
  assert.equal(n.id, own.networkId); assert.equal(n.name, own.network); assert.equal(n.labels[label], own.nonce);
  if (verifyConfiguration) {
    assert.equal(n.driver, "bridge"); assert.equal(n.internal, false); assert.equal(n.ipv6, false);
    assert.equal(n.options["com.docker.network.bridge.enable_icc"], "false");
    assert.equal(n.options["com.docker.network.bridge.gateway_mode_ipv4"], "nat");
  }
  assert.deepEqual(Object.keys(n.containers), requireEmpty ? [] : [own.containerId]);
}

let workerStage = "Docker/SQL identity and schema bootstrap";
type FixtureMode = "--retry" | "--rerun" | undefined;
async function realDatabase(d: Descriptor, mode?: FixtureMode): Promise<{ passed: string[]; version: string; isolation: string; external: number }> {
  workerStage = "ephemeral worker descriptor and parent identity";
  assert.equal(d.parentPid, process.ppid); assert.ok(process.connected);
  assert.ok(/^[0-9a-f-]{36}$/.test(d.nonce) && /^[0-9a-f]{64}$/.test(d.containerId) && /^[0-9a-f]{64}$/.test(d.networkId));
  assert.ok(/^u_[0-9a-f]{32}$/.test(d.user) && /^db_[0-9a-f]{32}$/.test(d.database) && /^[0-9a-f]{64}$/.test(d.password));
  workerStage = "worker revalidation of local Docker context and dedicated network";
  localContext(d.context); checkNetwork(d);
  workerStage = "worker revalidation of container ownership, tmpfs and loopback port";
  const { port, address } = assertDedicatedContainer(containerInfo(d), d);
  const url = new URL(`postgresql://127.0.0.1:${port}/${d.database}`);
  url.username = d.user; url.password = d.password;
  const application = "fixture_store_" + d.nonce;
  url.searchParams.set("application_name", application);
  // Only this clean, disposable child receives the generated connection string.
  process.env.DATABASE_URL = url.href;
  let external = 0;
  const fetch = globalThis.fetch, connect = Socket.prototype.connect;
  globalThis.fetch = async () => { external++; throw new Error("External fixture effect blocked"); };
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    const first = args[0];
    const options = typeof first === "object" && first !== null ? (Array.isArray(first) ? first[0] : first) as { port?: unknown; host?: unknown; path?: unknown } : undefined;
    const targetPort = options ? options.port : first, host = options ? options.host : args[1];
    if (options?.path !== undefined || host !== "127.0.0.1" || Number(targetPort) !== port) { external++; throw new Error("Non-fixture socket blocked"); }
    return Reflect.apply(connect, this, args);
  } as typeof Socket.prototype.connect;
  const probeUrl = new URL(url.href); probeUrl.searchParams.set("application_name", "fixture_probe_" + d.nonce);
  const sql = new Pool({ connectionString: probeUrl.href, max: 6, connectionTimeoutMillis: 1000, query_timeout: 10_000 });
  const passed: string[] = [];
  const check = async (name: string, body: () => Promise<void>) => { workerStage = name; await body(); passed.push(name); };
  let pending: Array<Promise<unknown>> = [];
  try {
    const until = async (predicate: () => Promise<boolean>, ms = 8000) => {
      const end = Date.now() + ms;
      while (!await predicate()) { assert.ok(Date.now() < end, "PostgreSQL barrier deadline exceeded"); await delay(25); }
    };
    workerStage = "real PostgreSQL readiness through guarded loopback socket";
    await until(async () => { try { await sql.query("SELECT 1"); return true; } catch { return false; } }, 30_000);
    workerStage = "real PostgreSQL database identity";
    const identity = (await sql.query("SELECT current_database() AS db, current_user AS usr, host(inet_server_addr()) AS addr, inet_server_port() AS port, current_setting('server_version') AS version, current_setting('transaction_isolation') AS isolation")).rows[0];
    assert.equal(identity.db, d.database); workerStage = "real PostgreSQL role identity";
    assert.equal(identity.usr, d.user); workerStage = "real PostgreSQL server address/port identity";
    assert.equal(identity.addr, address); assert.equal(identity.port, 5432); workerStage = "real PostgreSQL isolation and fresh database proof";
    assert.equal(identity.isolation, "read committed");
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0, "Dedicated database must be fresh");
    await sql.query("CREATE TABLE fixture_identity (nonce text PRIMARY KEY)");
    await sql.query("INSERT INTO fixture_identity VALUES ($1)", [d.nonce]);
    await sql.query(`ALTER ROLE "${d.user}" SET statement_timeout='15s'; ALTER ROLE "${d.user}" SET lock_timeout='10s'`);
    workerStage = "store import after identity proof and fresh schema bootstrap";
    const store = await import("../src/store.ts"); // First import only after Docker and SQL identity proof.
    await store.createCase("fixture-schema-" + randomUUID(), { kind: "text", text: "Fresh disposable schema bootstrap only." });
    if (mode) {
      if (mode === "--retry") {
        const { runRetryPostgresChecks } = await import("./retry-postgres-checks.ts");
        await runRetryPostgresChecks(sql, check);
      } else {
        const { runRerunPostgresChecks } = await import("./rerun-postgres-checks.ts");
        await runRerunPostgresChecks(sql, check);
      }
      assert.equal(external, 0); assert.equal((await sql.query("SELECT nonce FROM fixture_identity")).rows[0].nonce, d.nonce);
      return { passed, version: identity.version, isolation: identity.isolation, external };
    }
    const input = { fixture: true, model: "fixture/model", prompt: "Synthetic only", maxRetries: 0 };
    const hash = continuationHash(input);
    const fixture = async () => {
      const id = "fixture-operations-" + randomUUID(), runId = "fixture-run-" + randomUUID();
      await store.createCase(id, { kind: "text", text: "Dedicated ephemeral PostgreSQL protocol fixture." });
      const writer: ContinuationWriter = { generation: 1, runId };
      await sql.query("UPDATE cases SET continuation_generation=1,status='in_session',workflow_run_id=$2 WHERE id=$1", [id, runId]);
      await sql.query("INSERT INTO case_continuation_generations (case_id,generation,token,state,run_id,reconciled_run_id,body) VALUES ($1,1,$2,'running',$3,$3,$4)", [id, randomUUID(), runId, JSON.stringify({ generation: 1, runId, state: "running", fixture: true })]);
      return { id, writer, repo: store.sourceOperationRepositoryFor(writer) };
    };
    const claim = (f: Awaited<ReturnType<typeof fixture>>, key = "call") => f.repo.claim(f.id, key, "sandbox-generation", 300_000, hash, input);
    const snapshot = async (id: string) => ({
      operations: (await sql.query("SELECT operation_key,body FROM case_source_operations WHERE case_id=$1 ORDER BY operation_key", [id])).rows,
      audit: (await sql.query("SELECT generation,record_id,body FROM case_continuation_audit WHERE case_id=$1 ORDER BY generation,record_id", [id])).rows,
    });
    const locked = async (id: string, change: (c: PoolClient) => Promise<void>) => {
      const c = await sql.connect();
      try { await c.query("BEGIN"); await c.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE", [id]); await change(c); await c.query("COMMIT"); }
      catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
    };
    const advance = async (f: Awaited<ReturnType<typeof fixture>>, c: PoolClient) => {
      const writer = { generation: 2, runId: "fixture-run-" + randomUUID() };
      await c.query("INSERT INTO case_continuation_generations (case_id,generation,token,state,run_id,reconciled_run_id,body) VALUES ($1,2,$2,'running',$3,$3,$4)", [f.id, randomUUID(), writer.runId, JSON.stringify({ ...writer, state: "running", fixture: true })]);
      await c.query("UPDATE cases SET continuation_generation=2,workflow_run_id=$2 WHERE id=$1", [f.id, writer.runId]);
      return { ...f, writer, repo: store.sourceOperationRepositoryFor(writer) };
    };
    // Faults/barriers exist solely inside this fresh, dedicated disposable DB.
    workerStage = "fixture-only PostgreSQL triggers and barriers";
    await sql.query(`CREATE TABLE fixture_faults (case_id text PRIMARY KEY, mode text NOT NULL);
      CREATE FUNCTION fixture_operation_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS (SELECT 1 FROM fixture_faults WHERE case_id=NEW.case_id AND mode='gate') AND TG_OP='INSERT' THEN PERFORM pg_advisory_xact_lock(9847,1); END IF;
        IF EXISTS (SELECT 1 FROM fixture_faults WHERE case_id=NEW.case_id AND mode='owner') AND TG_OP='UPDATE' THEN RAISE EXCEPTION 'fixture_owner_fault' USING ERRCODE='P0001'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER fixture_operation_probe BEFORE INSERT OR UPDATE ON case_source_operations FOR EACH ROW EXECUTE FUNCTION fixture_operation_probe();
      CREATE FUNCTION fixture_audit_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS (SELECT 1 FROM fixture_faults WHERE case_id=NEW.case_id AND mode='audit') THEN RAISE EXCEPTION 'fixture_audit_fault' USING ERRCODE='P0001'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER fixture_audit_probe BEFORE INSERT OR UPDATE ON case_continuation_audit FOR EACH ROW EXECUTE FUNCTION fixture_audit_probe();`);
    const waitBlockedBy = (pid: number) => until(async () => (await sql.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))", [application, pid])).rowCount! > 0);

    await check("real case lock NOWAIT, eight simultaneous claims, durable canonical input and one audit/owner", async () => {
      const f = await fixture(), gate = await sql.connect();
      await sql.query("INSERT INTO fixture_faults VALUES ($1,'gate')", [f.id]);
      await gate.query("SELECT pg_advisory_lock(9847,1)");
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const mutable = structuredClone(input);
      const claims = Array.from({ length: 8 }, () => f.repo.claim(f.id, "call", "sandbox-generation", 300_000, hash, mutable));
      pending = claims; mutable.prompt = "Changed after calls started";
      try {
        await waitBlockedBy(pid); // Server proves the store is waiting inside its INSERT trigger.
        await assert.rejects(sql.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE NOWAIT", [f.id]), e => (e as { code?: string }).code === "55P03");
        assert.deepEqual(await snapshot(f.id), { operations: [], audit: [] }, "Uncommitted intention/owner/audit are invisible");
      } finally { await gate.query("SELECT pg_advisory_unlock(9847,1)"); gate.release(); }
      const results = await Promise.all(claims); pending = [];
      assert.equal(results.filter(r => r.owned).length, 1); assert.equal(new Set(results.map(r => r.operation.owner)).size, 1);
      const s = await snapshot(f.id); assert.equal(s.operations.length, 1); assert.equal(s.audit.length, 1);
      assert.equal(s.operations[0].body.inputJson, continuationJson(input)); assert.equal(s.operations[0].body.inputHash, hash);
    });
    await check("owner UPDATE and audit INSERT faults roll back intention, ownership and audit together", async () => {
      for (const mode of ["owner", "audit"]) {
        const f = await fixture(); await sql.query("INSERT INTO fixture_faults VALUES ($1,$2)", [f.id, mode]);
        await assert.rejects(claim(f), e => (e as { code?: string }).code === "P0001");
        assert.deepEqual(await snapshot(f.id), { operations: [], audit: [] });
        await sql.query("DELETE FROM fixture_faults WHERE case_id=$1", [f.id]);
        assert.equal((await claim(f)).owned, true);
      }
    });
    await check("audit ON CONFLICT collision rolls back uncertain transition without losing original owner", async () => {
      const f = await fixture(), result = await claim(f); assert.ok(result.owned);
      const record = `operation:${continuationHash("generation:1:call")}:uncertain:${result.owner}`;
      await sql.query("INSERT INTO case_continuation_audit (case_id,generation,record_id,body) VALUES ($1,1,$2,'{\"conflict\":true}')", [f.id, record]);
      const before = await snapshot(f.id);
      await assert.rejects(f.repo.fail(f.id, "call", result.owner, "Synthetic lost response", false), /audit collision/);
      assert.deepEqual(await snapshot(f.id), before);
    });
    await check("expiry and lost-result failure remain uncertain with no takeover, publication, defer or recovery", async () => {
      const f = await fixture(), result = await claim(f); assert.ok(result.owned);
      await locked(f.id, async c => { await c.query("UPDATE case_source_operations SET body=jsonb_set(body,'{expiresAt}',to_jsonb($2::text)) WHERE case_id=$1", [f.id, "2000-01-01T00:00:00Z"]); });
      assert.equal((await f.repo.get(f.id, "call"))?.status, "uncertain");
      const repeat = await Promise.all(Array.from({ length: 8 }, () => claim(f)));
      assert.ok(repeat.every(r => !r.owned && r.operation.owner === result.owner && r.operation.status === "uncertain"));
      await assert.rejects(f.repo.recover(f.id, "call", "Expired is not proof"), /recovery blocked/);
      await assert.rejects(f.repo.defer(f.id, "call", result.owner), /defer blocked/);
      await assert.rejects(f.repo.publish(f.id, "call", result.owner, { partial: true }), /ready publication blocked/);
      const other = await fixture(), lost = await claim(other); assert.ok(lost.owned);
      await other.repo.fail(other.id, "call", lost.owner, "Synthetic lost response", false);
      assert.equal((await claim(other)).owned, false); assert.equal((await other.repo.get(other.id, "call"))?.status, "uncertain");
    });
    await check("corrupt predecessors, reserved legacy namespaces and arbitrary exact-key collisions fail closed", async () => {
      const f = await fixture(), old = await claim(f), prior = old.operation;
      let next = f; await locked(f.id, async c => { next = await advance(f, c); });
      const legacy = (key: string): Operation => ({ key, stage: "legacy", status: "pending", at: prior.at, recoveries: [] });
      const rows: Array<[string, unknown]> = [
        ["generation:1:call", { ...prior, key: undefined }], ["generation:1:call", { ...prior, key: "hidden" }],
        ["generation:1:call", { ...prior, writer: undefined }], ["generation:1:call", null],
        ["generation:1:other", { ...prior, key: "other", status: "invalid" }], ["generation:01:call", prior],
        ["generation:2:call", legacy("generation:2:call")], ["generation:foo:%_", legacy("generation:foo:%_")],
        ["legacy", legacy("mismatch")], ["generation:1:other", { ...prior, key: "other", inputHash: "wrong" }],
        ["generation:1:other", { ...prior, key: "other", status: "ready", result: { partial: true } }],
      ];
      for (const [physical, body] of rows) {
        await locked(f.id, async c => { await c.query("DELETE FROM case_source_operations WHERE case_id=$1", [f.id]); await c.query("INSERT INTO case_source_operations VALUES ($1,$2,$3)", [f.id, physical, JSON.stringify(body)]); });
        const before = await snapshot(f.id);
        const rejected = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => claim(next, i ? `fresh${i}%_` : "call")));
        assert.ok(rejected.every(r => r.status === "rejected" && /predecessor blocked/.test(String(r.reason))));
        assert.deepEqual(await snapshot(f.id), before);
      }
      for (const key of ["generation:1:call", "generation:", "%_", "call%", "call_", "a:b:c", "quote'\";--", "path\\call", "line\nbreak", "é", "e\u0301", "emoji🔒"]) {
        await locked(f.id, async c => { await c.query("DELETE FROM case_source_operations WHERE case_id=$1", [f.id]); await c.query("INSERT INTO case_source_operations VALUES ($1,$2,$3)", [f.id, `generation:1:${key}`, JSON.stringify({ ...prior, key })]); });
        const before = await snapshot(f.id); await assert.rejects(claim(next, key), /predecessor blocked/); assert.deepEqual(await snapshot(f.id), before);
      }
      await locked(f.id, async c => { await c.query("DELETE FROM case_source_operations WHERE case_id=$1", [f.id]); await c.query("INSERT INTO case_source_operations VALUES ($1,$2,$3),($1,$4,$5)", [f.id, "generation:1:generation:1:call", JSON.stringify({ ...prior, key: "generation:1:call" }), "legacy%_generation:call", JSON.stringify(legacy("legacy%_generation:call"))]); });
      assert.equal((await claim(next, "call")).owned, true, "Fully consistent distinct identities can be independent; not proof of effect provenance");
    });
    await check("old writer blocked behind real case lock observes committed generation switch and cannot mutate", async () => {
      const f = await fixture(), old = await claim(f); assert.ok(old.owned);
      const before = await snapshot(f.id), c = await sql.connect();
      let next = f;
      try {
        await c.query("BEGIN"); await c.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE", [f.id]); next = await advance(f, c);
        const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const writes = [claim(f, "late"), f.repo.fail(f.id, "call", old.owner, "Late response", true), f.repo.alias(f.id, "https://fixture.invalid", "old")];
        pending = writes; await waitBlockedBy(pid); await c.query("COMMIT");
        const results = await Promise.allSettled(writes); pending = [];
        assert.ok(results.every(r => r.status === "rejected" && /fenced/.test(String(r.reason))));
      } finally { await c.query("ROLLBACK"); c.release(); }
      assert.deepEqual(await snapshot(f.id), before);
      await assert.rejects(f.repo.get(f.id, "call"), /fenced/); assert.equal((await claim(next, "fresh")).owned, true);
    });
    await check("cancellation committed ahead of waiting writers fences claims and preserves original rows", async () => {
      const f = await fixture(), before = await snapshot(f.id), c = await sql.connect();
      try {
        await c.query("BEGIN"); await c.query("SELECT id FROM cases WHERE id=$1 FOR UPDATE", [f.id]);
        await c.query("UPDATE cases SET status='failed',stopped_workflow_run_id=$2 WHERE id=$1", [f.id, f.writer.runId]);
        const pid = (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const writes = [claim(f), claim(f, "other")]; pending = writes;
        await waitBlockedBy(pid); await c.query("COMMIT");
        assert.ok((await Promise.allSettled(writes)).every(r => r.status === "rejected" && /fenced/.test(String(r.reason)))); pending = [];
      } finally { await c.query("ROLLBACK"); c.release(); }
      assert.deepEqual(await snapshot(f.id), before);
    });
    assert.equal(external, 0); assert.equal((await sql.query("SELECT nonce FROM fixture_identity")).rows[0].nonce, d.nonce);
    return { passed, version: identity.version, isolation: identity.isolation, external };
  } finally {
    await Promise.allSettled(pending); await sql.end();
    globalThis.fetch = fetch; Socket.prototype.connect = connect;
  }
}

async function run(context: string, imageTag: string, mode?: FixtureMode): Promise<void> {
  localContext(context);
  // Inspect only: never pull/build/install. Pin to the complete existing ID.
  const image = JSON.parse(docker(context, ["image", "inspect", imageTag, "--format", '{"id":{{json .Id}},"os":{{json .Os}},"volumes":{{json .Config.Volumes}}}']));
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(image.id)); assert.equal(image.os, "linux"); assert.deepEqual(Object.keys(image.volumes), [dataPath]);
  const started = Date.parse(docker(context, ["info", "--format", "{{.SystemTime}}"]));
  assert.ok(Number.isFinite(started), "Local Docker daemon time unavailable");
  const nonce = randomUUID(), own: Descriptor = { context, nonce, image: image.id, name: "fixture-operations-" + nonce, network: "fixture-operations-" + nonce, networkId: "", containerId: "", started, parentPid: process.pid,
    user: "u_" + randomBytes(16).toString("hex"), database: "db_" + randomBytes(16).toString("hex"), password: randomBytes(32).toString("hex") };
  let child: ReturnType<typeof fork> | undefined;
  let networkAttempted = false, containerAttempted = false, storageProved = false;
  console.log(`Fixture execution ${nonce}; planned dedicated resource name=${own.name}.`);
  try {
    networkAttempted = true;
    own.networkId = docker(context, ["network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=nat", "--label", `${label}=${nonce}`, own.network]);
    assert.ok(/^[0-9a-f]{64}$/.test(own.networkId)); checkNetwork(own, true);
    containerAttempted = true;
    own.containerId = docker(context, ["container", "create", "--pull=never", "--name", own.name, "--label", `${label}=${nonce}`, "--network", own.network,
      "--publish", "127.0.0.1::5432", "--read-only", "--tmpfs", `${dataPath}:rw,nosuid,noexec,size=256m`, "--tmpfs", "/var/run/postgresql:rw,nosuid,noexec,size=16m", "--tmpfs", "/tmp:rw,nosuid,noexec,size=16m",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--security-opt", "no-new-privileges", "--env", "POSTGRES_USER", "--env", "POSTGRES_DB", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256", own.image],
      { ...cleanEnvironment(), POSTGRES_USER: own.user, POSTGRES_DB: own.database, POSTGRES_PASSWORD: own.password });
    assert.ok(/^[0-9a-f]{64}$/.test(own.containerId)); docker(context, ["container", "start", own.containerId]);
    checkNetwork(own); assertDedicatedContainer(containerInfo(own), own);
    storageProved = true;
    console.log(`Created resource IDs: container=${own.containerId}; network=${own.networkId}.`);
    console.log("Dedicated local PostgreSQL created: private NAT bridge, ICC disabled, loopback-only port, tmpfs only, existing pinned image.");
    child = fork(file, mode ? ["--worker", mode] : ["--worker"], { execArgv: ["--import", "tsx"], env: cleanEnvironment(), silent: true });
    // Never forward raw child stderr/errors: pg/CLI errors can contain credentials.
    child.stdout?.resume(); child.stderr?.resume();
    const result = await new Promise<{ passed: string[]; version: string; isolation: string; external: number }>((resolve, reject) => {
      const timeout = setTimeout(() => { child?.kill(); reject(new Error("Dedicated PostgreSQL worker deadline exceeded")); }, 120_000);
      let report: { passed: string[]; version: string; isolation: string; external: number } | undefined;
      let failed = "worker bootstrap", sqlstate = "not reported";
      child!.on("message", (message: unknown) => {
        if (message && typeof message === "object" && "passed" in message) report = message as typeof report;
        if (message && typeof message === "object" && "failed" in message) { failed = String(message.failed); if ("sqlstate" in message && /^[A-Z0-9]{5}$/.test(String(message.sqlstate))) sqlstate = String(message.sqlstate); }
      });
      child!.on("error", () => { clearTimeout(timeout); reject(new Error("Dedicated PostgreSQL worker failed")); });
      child!.on("exit", code => { clearTimeout(timeout); code === 0 && report ? resolve(report) : reject(new Error(`Dedicated PostgreSQL failure at ${failed}; SQLSTATE=${sqlstate}; sensitive details suppressed`)); });
      child!.send(own);
    });
    for (const name of result.passed) console.log("PASS: " + name);
    console.log(`Real PostgreSQL ${result.version}; isolation=${result.isolation}; checks=${result.passed.length}; external attempts=${result.external}.`);
  } finally {
    // Do not release the port while a timed-out worker could still reconnect.
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child?.kill("SIGKILL"); reject(new Error("Worker exit unproved; resource cleanup deliberately blocked")); }, 5000);
        child!.once("exit", () => { clearTimeout(timer); resolve(); });
        child!.kill();
      });
    }
    if (own.containerId) {
      const info = containerInfo(own);
      assert.equal(info.id, own.containerId); assert.equal(info.name, "/" + own.name); assert.equal(info.labels[label], nonce); assert.equal(info.image, own.image);
      docker(context, ["container", "rm", "--force", own.containerId]);
      assert.equal(docker(context, ["container", "ls", "--all", "--filter", "id=" + own.containerId, "--format", "{{.ID}}"]), "");
    }
    if (own.networkId) {
      // Ownership and emptiness, not successful configuration, authorize cleanup
      // of the network this invocation created, including failed preflights.
      checkNetwork(own, true, false); docker(context, ["network", "rm", own.networkId]);
      assert.equal(docker(context, ["network", "ls", "--filter", "id=" + own.networkId, "--format", "{{.ID}}"]), "");
    }
    if ((networkAttempted && !own.networkId) || (containerAttempted && !own.containerId)) {
      console.log("Cleanup incomplete: creation response unproved; no resources adopted by name and no volumes deleted. Manual inspection required for this execution.");
    } else {
      console.log("Cleanup verified: acknowledged execution resources removed; " + (storageProved ? "tmpfs-only storage verified; no volumes created." : "storage preflight did not complete; no volumes deleted."));
    }
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--worker") {
    assert.ok(process.connected && process.send && (process.argv.length === 3 || (process.argv.length === 4 && ["--retry", "--rerun"].includes(process.argv[3]))), "Standalone worker blocked");
    process.once("message", async (message: Descriptor) => {
      try { const result = await realDatabase(message, process.argv[3] as FixtureMode); process.send!(result, () => process.exit(0)); }
      catch (error) { process.send!({ failed: workerStage, sqlstate: (error as { code?: string })?.code }, () => process.exit(1)); } // Dedicated worker exit also closes the private store pool.
    });
    return;
  }
  const args = process.argv.slice(2);
  assert.ok(args.includes("--run"), "Blocked: explicit --run required; no database or Docker resources touched");
  let context = "", image = "postgres:17-alpine", mode: FixtureMode;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--run") continue;
    if (args[i] === "--retry" || args[i] === "--rerun") {
      assert.equal(mode, undefined, "Only one fixture mode is allowed");
      mode = args[i] as FixtureMode; continue;
    }
    if (args[i] === "--context") context = args[++i];
    else if (args[i] === "--image") image = args[++i];
    else throw new Error("Unknown fixture option blocked");
  }
  assert.ok(context && /^postgres:[a-zA-Z0-9_.-]+$/.test(image), "Explicit local context and installed postgres tag required");
  await run(context, image, mode);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error && !error.message.includes("Assertion") ? error.message : "Fixture preflight/assertion blocked (details suppressed)"); process.exitCode = 1; });
}
