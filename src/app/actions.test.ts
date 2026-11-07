import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../lib/auth0.ts";
import { requestFactCheck, retryCase } from "./actions.ts";

test("case requests require the verified authorized account before validating input", async (t) => {
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "short");

  const sessions = [
    null,
    { user: { sub: "someone", email: "other@example.com", email_verified: true } },
    { user: { sub: "someone", email: "daniel@cazzulino.com", email_verified: false } },
    { user: { sub: "someone", email: "daniel@cazzulino.com" } },
    { user: { email: "daniel@cazzulino.com", email_verified: true } },
  ];
  for (const session of sessions) {
    const getSession = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    assert.deepEqual(await requestFactCheck({}, form), { error: "Che.bot está en beta. Para pedir un chequeo, enviá un correo a hola@che.bot." });
    form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
    assert.deepEqual(await requestFactCheck({}, form), { error: "Che.bot está en beta. Para pedir un chequeo, enviá un correo a hola@che.bot." });
    form.set("text", "short");
    getSession.mock.restore();
  }

  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "Daniel@Cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  assert.deepEqual(await requestFactCheck({}, form), { error: "Pegá un texto de al menos 20 caracteres.", field: "text" });
});

test("retrying a case rejects unauthorized sessions before accessing storage", async (t) => {
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const sessions = [
    null,
    { user: { sub: "someone", email: "other@example.com", email_verified: true } },
    { user: { sub: "someone", email: "daniel@cazzulino.com", email_verified: false } },
    { user: { sub: "someone", email: "daniel@cazzulino.com" } },
    { user: { email: "daniel@cazzulino.com", email_verified: true } },
    { user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } },
    { user: { sub: "user", roles: ["admin"] } },
    { user: { roles: ["Admin"] } },
  ];
  for (const session of sessions) {
    const getSession = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(retryCase("failed-case"), /No autorizado/);
    getSession.mock.restore();
  }
  assert.equal(query.mock.callCount(), 0);
});

test("an authorized retry uses the transactional reset and does not restart a resolved case", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "admin-user", roles: ["Admin"] } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
  const queries: { sql: string; values?: unknown[] }[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [], rowCount: 0 })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return { rows: sql.startsWith("SELECT status") ? [{ status: "resolved" }] : [], rowCount: 0 };
    },
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  try {
    await assert.rejects(retryCase("failed-case"), { digest: "NEXT_REDIRECT;replace;/c/failed-case;307;" });
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
  assert.ok(queries.some(({ sql }) => sql === "SELECT status, stopped_workflow_run_id FROM cases WHERE id = $1 FOR UPDATE"));
  assert.deepEqual(queries.find(({ sql }) => sql.startsWith("SELECT status"))?.values, ["failed-case"]);
  assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
  assert.ok(!queries.some(({ sql }) => /^(UPDATE|DELETE)/.test(sql)));
});

test("malformed and private links return form errors instead of throwing", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);

  const malformed = new FormData();
  malformed.set("kind", "link");
  malformed.set("url", "example.com");
  assert.deepEqual(await requestFactCheck({}, malformed), { error: "Ingresá un enlace válido (http o https).", field: "url" });

  const privateLink = new FormData();
  privateLink.set("kind", "link");
  privateLink.set("url", "http://localhost:3000/secret");
  assert.deepEqual(await requestFactCheck({}, privateLink), { error: "Ingresá un enlace público.", field: "url" });
});

test("case requests reject unsupported languages before touching storage", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
  form.set("language", "fr");
  assert.deepEqual(await requestFactCheck({}, form), { error: "Elegí un idioma válido.", field: "language" });
});

test("case requests reject unknown check types before touching storage", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
  form.set("check", "deep");
  assert.deepEqual(await requestFactCheck({}, form), { error: "Elegí un tipo de chequeo válido.", field: "check" });
  assert.equal(query.mock.callCount(), 0);
});

test("claim identification rejects malformed values before touching storage", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
  form.set("identifyClaims", "yes");
  assert.deepEqual(await requestFactCheck({}, form), { error: "Elegí una opción de afirmaciones válida.", field: "identifyClaims" });
  assert.equal(query.mock.callCount(), 0);
});

test("a forged Quick claim option is denied without an exact Contrib or Admin role before storage", async (t) => {
  let roles: unknown;
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true, roles } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
  form.set("check", "quick");
  form.set("identifyClaims", "on");
  for (const value of [undefined, [], ["reader"], ["contrib"], ["admin"], ["SuperAdmin"], "Contrib", [null]]) {
    roles = value;
    assert.deepEqual(await requestFactCheck({}, form), { error: "Identificar afirmaciones independientes requiere el rol Contrib o Admin.", field: "identifyClaims" });
  }
  assert.equal(query.mock.callCount(), 0);
});

test("the submission stores claim identification only when a Quick request opts in", async (t) => {
  let roles: readonly string[] = [];
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true, roles } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original; });
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [], rowCount: 0 })) as unknown as typeof Pool.prototype.query);
  const submissions: Record<string, unknown>[] = [];
  const stop = new Error("Stop after observing submission; do not start a real workflow");
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("INSERT INTO cases")) { submissions.push(JSON.parse(values![2] as string)); throw stop; }
      return { rows: [] };
    },
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  for (const [check, optIn, assignedRoles] of [[undefined, true, ["Contrib"]], ["quick", true, ["Admin"]], ["quick", false, []], ["expert", true, []], ["quick", true, ["reader", "Contrib"]]] as const) {
    roles = assignedRoles;
    const form = new FormData();
    form.set("kind", "text");
    form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
    if (check) form.set("check", check);
    if (optIn) form.set("identifyClaims", "on");
    await assert.rejects(requestFactCheck({}, form), stop);
    assert.equal(submissions.at(-1)?.identifyClaims, optIn && check !== "expert" ? true : undefined);
    assert.equal(submissions.at(-1)?.check, check ?? "quick");
  }
});
