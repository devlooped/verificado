import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../lib/auth0.ts";
import { requestFactCheck, retryCase } from "./actions.ts";

function forbidRetryEffects(t: TestContext) {
  const unexpected = () => { throw new Error("Retry must not access storage or external services"); };
  const mocks = [
    t.mock.method(Pool.prototype, "query", unexpected),
    t.mock.method(Pool.prototype, "connect", unexpected),
    t.mock.method(globalThis, "fetch", unexpected),
  ];
  return () => { for (const mock of mocks) assert.equal(mock.mock.callCount(), 0); };
}

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

test("direct retry action calls reject unauthorized sessions with zero effects", async (t) => {
  const assertNoEffects = forbidRetryEffects(t);
  const sessions = [
    null,
    { user: { sub: "someone", email: "other@example.com", email_verified: true } },
    { user: { sub: "someone", email: "daniel@cazzulino.com", email_verified: false } },
    { user: { sub: "someone", email: "daniel@cazzulino.com" } },
    { user: { email: "daniel@cazzulino.com", email_verified: true } },
    { user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } },
    { user: { sub: "user", roles: ["admin"] } },
    { user: { roles: ["Admin"] } },
    { user: { sub: "user", roles: ["Contrib"] } },
    { user: { sub: "user", roles: "Admin" } },
  ];
  for (const session of sessions) {
    const getSession = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(retryCase("failed-case"), /No autorizado/);
    const forged = new FormData();
    forged.set("roles", "Admin");
    forged.set("enabled", "true");
    await assert.rejects(Reflect.apply(retryCase.bind(null, "failed-case"), null, [forged]), /No autorizado/);
    getSession.mock.restore();
  }
  assertNoEffects();
});

test("authorized retry is blocked even for direct POST-equivalent bound action calls", async (t) => {
  const assertNoEffects = forbidRetryEffects(t);
  const session = t.mock.method(auth0, "getSession", async () => ({ user: { sub: "admin-user", roles: ["Admin"] } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
  const blocked = { error: "Reintentar está bloqueado: la continuación segura está desactivada. El expediente no se modificó. No se puede estimar el costo pendiente ni qué resultados podrán reutilizarse." };
  // No UI is rendered. Invoke the exported action and its bound form signature
  // directly, as a POST dispatch would, including untrusted extra fields.
  for (const id of ["failed-case", "resolved-case", "active-case", "missing-case", "../invalid", ""]) {
    assert.deepEqual(await retryCase(id), blocked);
    const form = new FormData();
    form.set("enabled", "true");
    form.set("confirm", "on");
    form.set("operation", "rerun");
    assert.deepEqual(await Reflect.apply(retryCase.bind(null, id), null, [form]), blocked);
  }
  assert.equal(session.mock.callCount(), 12, "each invocation independently checks the server session");
  assertNoEffects();
});

test("an authentication failure cannot fall back to reset or continuation", async (t) => {
  const assertNoEffects = forbidRetryEffects(t);
  const unavailable = new Error("Session unavailable");
  t.mock.method(auth0, "getSession", async () => { throw unavailable; });
  await assert.rejects(retryCase("failed-case"), unavailable);
  assertNoEffects();
});

test("retry has no effectful delegation: only session and permission calls are allowed", () => {
  const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const parser = createRequire(import.meta.url)("next/dist/compiled/babel/parser.js") as { parse(source: string, options: object): { program: { body: { declaration?: { id?: { name: string } } }[] } } };
  const ast = parser.parse(source, { sourceType: "module", plugins: ["typescript"] });
  const retry = ast.program.body.find((node) => node.declaration?.id?.name === "retryCase")?.declaration;
  assert.ok(retry);
  const calls: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (["CallExpression", "OptionalCallExpression", "NewExpression"].includes(String(node.type))) {
      const callee = node.callee as { start: number; end: number };
      calls.push(source.slice(callee.start, callee.end));
    }
    Object.values(node).forEach(visit);
  };
  visit(retry);
  // Also rejects cleanup wrapper construction, workflow/reset/store helpers,
  // independent audit writes, redirects and direct provider calls.
  assert.deepEqual(calls, ["auth0.getSession", "isAdmin", "Error"]);
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

test("case requests reject the disabled Expert check and unknown check types before touching storage", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
  for (const check of ["deep", "expert"]) {
    form.set("check", check);
    assert.deepEqual(await requestFactCheck({}, form), { error: "El chequeo experto está deshabilitado." });
  }
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

test("the submission is a Quick check, with claim identification only when the request opts in", async (t) => {
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
  for (const [check, optIn, assignedRoles] of [[undefined, true, ["Contrib"]], ["quick", true, ["Admin"]], ["quick", false, []], [undefined, false, []], ["quick", true, ["reader", "Contrib"]]] as const) {
    roles = assignedRoles;
    const form = new FormData();
    form.set("kind", "text");
    form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
    if (check) form.set("check", check);
    if (optIn) form.set("identifyClaims", "on");
    await assert.rejects(requestFactCheck({}, form), stop);
    assert.equal(submissions.at(-1)?.identifyClaims, optIn ? true : undefined);
    assert.equal(submissions.at(-1)?.check, "quick");
  }
});
