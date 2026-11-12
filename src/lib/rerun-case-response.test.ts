import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckType } from "../domain/court.ts";
import { EXPERT_DISABLED, rerunCaseResponse } from "./rerun-case-response.ts";
import { SandboxCleanupBlockedError, SANDBOX_CLEANUP_BLOCKED_RESPONSE } from "./sandbox-cleanup.ts";

const admin = { sub: "admin-user", roles: ["Admin"] };
const request = (origin = "https://example.test") => new Request("https://example.test/api/cases/AA-123-BB/rerun", { method: "POST", headers: { origin } });
function dependencies(result: "queued" | "missing" | "active" | "missing-image" = "queued", check: CheckType | undefined = "quick") {
  const calls: unknown[][] = [];
  return { calls, deps: {
    checkType: async () => check,
    restartCase: async (id: string) => { calls.push(["restartCase", id]); return result; },
    start: async (id: string, latestPipeline: boolean) => { calls.push(["start", id, latestPipeline]); },
    finish: async (id: string, status: "failed", error: string) => { calls.push(["finish", id, status, error]); },
  } };
}

test("reruns reject unauthorized, cross-origin and invalid requests before resetting a case", async () => {
  const { calls, deps } = dependencies();
  for (const [req, id, user, status] of [
    [request(), "AA-123-BB", undefined, 401],
    [request(), "AA-123-BB", { roles: ["Admin"] }, 401],
    [request(), "AA-123-BB", { sub: "user", roles: ["admin"] }, 403],
    [request("https://attacker.test"), "AA-123-BB", admin, 403],
    [request(), "../bad", admin, 400],
  ] as const) assert.equal((await rerunCaseResponse(req, id, user, deps)).status, status);
  assert.deepEqual(calls, []);
});

test("a rerun resets and starts the same case id", async () => {
  const { calls, deps } = dependencies();
  const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "AA-123-BB" });
  assert.deepEqual(calls, [["restartCase", "AA-123-BB"], ["start", "AA-123-BB", true]]);
});

test("missing and active cases and cases with missing images are not started", async () => {
  for (const [result, status] of [["missing", 404], ["active", 409], ["missing-image", 409]] as const) {
    const { calls, deps } = dependencies(result);
    const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
    assert.equal(response.status, status);
    if (result === "missing-image") assert.deepEqual(await response.json(), { error: "No se encontró la imagen original." });
    assert.deepEqual(calls, [["restartCase", "AA-123-BB"]]);
  }
});

test("a workflow start failure leaves the existing case visibly failed", async (t) => {
  const { calls, deps } = dependencies();
  deps.start = async (id) => { calls.push(["start", id]); throw new Error("offline"); };
  t.mock.method(console, "error", () => {});
  const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "AA-123-BB" });
  assert.deepEqual(calls.at(-1), ["finish", "AA-123-BB", "failed", "No se pudo iniciar la sesión."]);
});

test("a cleanup safety block reports conflict without start or failure mutation", async () => {
  const { calls, deps } = dependencies();
  deps.restartCase = async () => { throw new SandboxCleanupBlockedError(); };
  const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), SANDBOX_CLEANUP_BLOCKED_RESPONSE);
  assert.deepEqual(calls, []);
});

test("an Expert case is refused before the restart deletes anything: the Expert check is disabled", async () => {
  for (const check of ["expert", undefined] as const) {
    const { calls, deps } = dependencies("queued", check);
    const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
    if (check) {
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: EXPERT_DISABLED });
      assert.deepEqual(calls, []);
    } else assert.deepEqual(calls[0], ["restartCase", "AA-123-BB"], "a missing case is left to the restart, which reports it");
  }
});
