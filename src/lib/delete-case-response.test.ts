import assert from "node:assert/strict";
import { test } from "node:test";
import { canDeleteCase } from "./case-access.ts";
import { deleteCaseResponse } from "./delete-case-response.ts";
import { SandboxCleanupBlockedError, SANDBOX_CLEANUP_BLOCKED_RESPONSE } from "./sandbox-cleanup.ts";

const admin = { sub: "user", roles: ["reader", "Admin"] };
const request = (origin = "https://example.test") => new Request("https://example.test/api/cases/AA-123-BB", { method: "DELETE", headers: { origin } });

test("deletion requires an authenticated user with the exact Admin role", () => {
  assert.equal(canDeleteCase(admin), true);
  for (const user of [undefined, { roles: ["Admin"] }, { sub: "user", roles: ["admin"] }, { sub: "user", roles: ["ADMIN"] }, { sub: "user", roles: ["superadmin"] }, { sub: "user", roles: "Admin" }, { sub: "user", roles: [null, "beta"] }]) assert.equal(canDeleteCase(user), false);
});

test("the API rejects unauthenticated, non-admin, cross-origin and invalid requests before deleting", async () => {
  let calls = 0;
  const remove = async () => { calls++; return "deleted" as const; };
  assert.equal((await deleteCaseResponse(request(), "AA-123-BB", undefined, remove)).status, 401);
  assert.equal((await deleteCaseResponse(request(), "AA-123-BB", { sub: "user", roles: ["beta"] }, remove)).status, 403);
  assert.equal((await deleteCaseResponse(request("https://attacker.test"), "AA-123-BB", admin, remove)).status, 403);
  assert.equal((await deleteCaseResponse(request(), "../bad", admin, remove)).status, 400);
  assert.equal(calls, 0);
});

test("the API reports deleted, missing, active and incomplete deletions", async () => {
  assert.equal((await deleteCaseResponse(request(), "AA-123-BB", admin, async (id) => { assert.equal(id, "AA-123-BB"); return "deleted"; })).status, 204);
  assert.equal((await deleteCaseResponse(request(), "AA-123-BB", admin, async () => "missing")).status, 404);
  assert.equal((await deleteCaseResponse(request(), "AA-123-BB", admin, async () => "active")).status, 409);
  const original = console.error; console.error = () => {};
  try {
    const failed = await deleteCaseResponse(request(), "AA-123-BB", admin, async () => { throw new Error("blob failure"); });
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /intentá de nuevo/);
  } finally { console.error = original; }
});

test("a cleanup safety block is an explicit conflict, never a success or a partial-deletion claim", async () => {
  const response = await deleteCaseResponse(request(), "AA-123-BB", admin, async () => { throw new SandboxCleanupBlockedError(); });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), SANDBOX_CLEANUP_BLOCKED_RESPONSE);
});
