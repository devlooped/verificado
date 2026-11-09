import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../../lib/auth0.ts";
import AdminPage from "./page.tsx";

function redirectTarget(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("digest" in error)) return undefined;
  const digest = String(error.digest);
  if (!digest.startsWith("NEXT_REDIRECT;")) return undefined;
  return digest.split(";").slice(2, -2).join(";");
}

function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "digest" in error && error.digest === "NEXT_HTTP_ERROR_FALLBACK;404";
}

test("admin page sends anonymous visitors to sign in and keeps the notification cursor", async (t) => {
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  for (const session of [null, { user: { roles: ["Admin"] } }, { user: { sub: "", roles: ["Contrib"] } }]) {
    const mocked = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(AdminPage({ searchParams: Promise.resolve({}) }), (error: unknown) => {
      assert.equal(redirectTarget(error), "/auth/login?returnTo=%2Fadmin");
      return true;
    });
    mocked.mock.restore();
  }
  t.mock.method(auth0, "getSession", async () => null);
  await assert.rejects(AdminPage({ searchParams: Promise.resolve({ before: "42" }) }), (error: unknown) => {
    assert.equal(redirectTarget(error), "/auth/login?returnTo=%2Fadmin%3Fbefore%3D42");
    return true;
  });
  assert.equal(query.mock.callCount(), 0);
});

test("admin page answers 404 for a signed-in account that is neither Admin nor Contrib", async (t) => {
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  for (const roles of [["beta"], ["admin"], ["contrib"], ["SuperAdmin"], "Admin", undefined]) {
    const mocked = t.mock.method(auth0, "getSession", async () => ({ user: { sub: "user", roles } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(AdminPage({ searchParams: Promise.resolve({}) }), (error: unknown) => {
      assert.equal(isNotFound(error), true);
      return true;
    });
    mocked.mock.restore();
  }
  assert.equal(query.mock.callCount(), 0);
});

test("Admin and Contrib pass the sign-in and role gate", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  for (const roles of [["Admin"], ["Contrib"], ["reader", "Contrib"]]) {
    const mocked = t.mock.method(auth0, "getSession", async () => ({ user: { sub: "user", roles } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(AdminPage({ searchParams: Promise.resolve({}) }), (error: unknown) => {
      assert.equal(redirectTarget(error), undefined);
      assert.equal(isNotFound(error), false);
      return true;
    });
    mocked.mock.restore();
  }
});
