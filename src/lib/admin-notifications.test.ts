import assert from "node:assert/strict";
import { test } from "node:test";
import { caseFailureMessage, snapshotHealth } from "./admin-notifications.ts";
import { adminNotificationResponse } from "./admin-notification-response.ts";

const now = Date.parse("2026-11-05T00:00:00Z");
const env = { EVIDENCE_SANDBOX_SNAPSHOT_ID: "snap-1" };
const info = (days: number, status = "created") => async () => ({ status, expiresAt: new Date(now + days * 86_400_000) });

test("snapshot checks use the configured snapshot and report warning, expiration and recovery", async () => {
  assert.equal((await snapshotHealth(env, info(8), now)).state, "ok:snap-1");
  assert.match((await snapshotHealth(env, info(7), now)).title!, /por vencer/);
  assert.match((await snapshotHealth(env, info(0), now)).title!, /vencido/);
  assert.match((await snapshotHealth(env, info(-1), now)).title!, /vencido/);
  assert.match((await snapshotHealth(env, info(8, "deleted"), now)).title!, /no disponible/);
  assert.equal((await snapshotHealth({ ...env, INSTRUCTION_SANDBOX_SNAPSHOT_ID: "override" }, async (id) => { assert.equal(id, "override"); return { status: "created" }; }, now)).state, "ok:override");
  assert.equal((await snapshotHealth({}, info(8), now)).state, "missing");
  assert.equal((await snapshotHealth({ ...env, COURT_PIPELINE_VERSION: "1" }, async () => { throw Error("must not call"); }, now)).state, "disabled");
  const failed = await snapshotHealth(env, async () => { throw Error("secret"); }, now);
  assert.match(failed.title!, /verificar/);
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});

test("case failure alerts classify known configuration errors without copying raw errors", () => {
  assert.match(caseFailureMessage("Step failed: Instruction sandbox bridge requires trusted team/project identities and a harness snapshot"), /snapshot/);
  assert.match(caseFailureMessage("Durable storage and the authenticated sandbox bridge are required before research"), /almacenamiento/);
  assert.doesNotMatch(caseFailureMessage("secret token and private submission"), /secret|token|submission/);
});

test("only admins can read or check notifications; checks require same origin", async () => {
  const calls: string[] = [];
  const deps = { checkSnapshot: async () => { calls.push("check"); return true; }, hasUnread: async () => { calls.push("unread"); return true; } };
  const get = new Request("https://example.test/api/admin/notifications");
  const post = (origin: string) => new Request(get.url, { method: "POST", headers: { origin } });
  assert.equal((await adminNotificationResponse(get, undefined, deps)).status, 403);
  assert.equal((await adminNotificationResponse(get, { sub: "user", roles: ["admin"] }, deps)).status, 403);
  assert.equal((await adminNotificationResponse(post("https://evil.test"), { sub: "admin", roles: ["Admin"] }, deps)).status, 403);
  assert.deepEqual(calls, []);
  const user = { sub: "admin", roles: ["Admin"] };
  const result = await adminNotificationResponse(post("https://example.test"), user, deps);
  assert.deepEqual(await result.json(), { unread: true, changed: true });
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, ["check", "unread"]);
  calls.length = 0;
  assert.deepEqual(await (await adminNotificationResponse(get, user, deps)).json(), { unread: true, changed: false });
  assert.deepEqual(calls, ["unread"]);
});

test("a contributor reads notifications but cannot run the checks", async () => {
  const calls: string[] = [];
  const deps = { checkSnapshot: async () => { calls.push("check"); return true; }, hasUnread: async () => { calls.push("unread"); return false; } };
  const get = new Request("https://example.test/api/admin/notifications");
  const contrib = { sub: "contrib", roles: ["Contrib"] };
  assert.equal((await adminNotificationResponse(new Request(get.url, { method: "POST", headers: { origin: "https://example.test" } }), contrib, deps)).status, 403);
  assert.deepEqual(calls, []);
  assert.deepEqual(await (await adminNotificationResponse(get, contrib, deps)).json(), { unread: false, changed: false });
  assert.deepEqual(calls, ["unread"]);
});
