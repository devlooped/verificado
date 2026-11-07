import assert from "node:assert/strict";
import test from "node:test";
import { requestedPipeline } from "./rollout.ts";

test("new cases default to shared instruction in production and retain explicit legacy rollback", async () => {
  const values = { COURT_PIPELINE_VERSION: "2", VERCEL_ENV: "production", INSTRUCTION_STAGING_CASE_ID: "fixture", INSTRUCTION_TOOL_ORIGIN: "https://court.example.test", APP_BASE_URL: "https://court.example.test", R2_ACCOUNT_ID: "account", R2_BUCKET: "bucket", R2_ACCESS_KEY_ID: "fixture-only", R2_SECRET_ACCESS_KEY: "fixture-only", R2_PUBLIC_URL: "https://public.example.test", INSTRUCTION_SANDBOX_TEAM_ID: "team", INSTRUCTION_SANDBOX_PROJECT_ID: "project", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "snapshot", AI_GATEWAY_API_KEY: "fixture-only", VERCEL_OIDC_TOKEN: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`, VERCEL_OIDC_TOKEN_FILE: "", EVIDENCE_SANDBOX_SNAPSHOT_ID: "" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    assert.equal(await requestedPipeline("fixture", false), 2);
    assert.equal(await requestedPipeline("different-case", false), 2);
    process.env.COURT_PIPELINE_VERSION = "3";
    assert.equal(await requestedPipeline("fixture", false), 5, "native research is an explicit opt-in; new cases use replay-safe batch URLs");
    delete process.env.COURT_PIPELINE_VERSION;
    assert.equal(await requestedPipeline("different-case", false), 2);
    process.env.VERCEL_ENV = "preview";
    assert.equal(await requestedPipeline("different-case", false), 2);
    for (const key of ["INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "AI_GATEWAY_API_KEY"]) {
      delete process.env[key];
      await assert.rejects(requestedPipeline("fixture", false), /required|requires/);
      process.env[key] = values[key as keyof typeof values];
    }
    process.env.AI_GATEWAY_API_KEY = "placeholder";
    await assert.rejects(requestedPipeline("fixture", false), /required/);
    process.env.AI_GATEWAY_API_KEY = " ";
    await assert.rejects(requestedPipeline("fixture", false), /required/);
    process.env.COURT_PIPELINE_VERSION = "invalid";
    await assert.rejects(requestedPipeline("fixture", false), /must be 1, 2 or 3/);
    process.env.COURT_PIPELINE_VERSION = "1";
    assert.equal(await requestedPipeline("fixture", false), 1);
    delete process.env.COURT_PIPELINE_VERSION;
    for (const key of ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID"]) delete process.env[key];
    process.env.AI_GATEWAY_API_KEY = values.AI_GATEWAY_API_KEY;
    process.env.EVIDENCE_SANDBOX_SNAPSHOT_ID = "existing-snapshot";
    process.env.VERCEL_OIDC_TOKEN = `fixture.${Buffer.from(JSON.stringify({ owner_id: "team", project_id: "project", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
    assert.equal(await requestedPipeline("production-case", false), 2, "normal deployment reuses existing configuration without instruction-specific variables");
    const contextKey = Symbol.for("@vercel/request-context");
    const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previousContext = global[contextKey];
    try {
      const contextToken = process.env.VERCEL_OIDC_TOKEN;
      global[contextKey] = { get: () => ({ headers: { "x-vercel-oidc-token": contextToken } }) };
      delete process.env.VERCEL_OIDC_TOKEN;
      assert.equal(await requestedPipeline("production-case", false), 2, "production identity comes from the Vercel function context");
      delete process.env.AI_GATEWAY_API_KEY;
      await assert.rejects(requestedPipeline("production-case", false), /authenticated sandbox bridge are required/, "the gateway key is still required");
    } finally { if (previousContext === undefined) delete global[contextKey]; else global[contextKey] = previousContext; }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("mock shared instruction still requires the dedicated local database", async () => {
  const previous = { COURT_PIPELINE_VERSION: process.env.COURT_PIPELINE_VERSION, DATABASE_URL: process.env.DATABASE_URL };
  try {
    delete process.env.COURT_PIPELINE_VERSION;
    delete process.env.DATABASE_URL;
    await assert.rejects(requestedPipeline("fixture", true), /Local database preflight/);
    process.env.DATABASE_URL = "postgresql://grokeado:fixture@remote.example.test:5432/grokeado_local_fixture";
    await assert.rejects(requestedPipeline("fixture", true), /Local database preflight/);
    process.env.DATABASE_URL = "postgresql://grokeado:fixture@127.0.0.1:5432/grokeado_local_fixture";
    assert.equal(await requestedPipeline("fixture", true), 2);
    for (const version of [undefined, "1", "2", "3"]) {
      if (version === undefined) delete process.env.COURT_PIPELINE_VERSION;
      else process.env.COURT_PIPELINE_VERSION = version;
      for (const check of ["expert", "quick"] as const) {
        assert.equal(await requestedPipeline("rerun", true, check, true), 5, `rerun selects latest for ${check}, rollout ${version}`);
      }
    }
    delete process.env.DATABASE_URL;
    await assert.rejects(requestedPipeline("rerun", true, "expert", true), /Local database preflight/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("a Quick check keeps shared storage and needs no sandbox bridge", async () => {
  const values = { R2_ACCOUNT_ID: "account", R2_BUCKET: "bucket", R2_ACCESS_KEY_ID: "fixture-only", R2_SECRET_ACCESS_KEY: "fixture-only", R2_PUBLIC_URL: "https://public.example.test", AI_GATEWAY_API_KEY: "fixture-only" };
  const keys = [...Object.keys(values), "COURT_PIPELINE_VERSION", "INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "EVIDENCE_SANDBOX_SNAPSHOT_ID", "VERCEL_OIDC_TOKEN", "VERCEL_OIDC_TOKEN_FILE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    assert.equal(await requestedPipeline("fixture", false, "quick"), 2);
    await assert.rejects(requestedPipeline("fixture", false, "expert"), /required|requires/, "an Expert case still needs the bridge");
    process.env.COURT_PIPELINE_VERSION = "1";
    assert.equal(await requestedPipeline("fixture", false, "quick", true), 5, "reruns use the latest even with legacy rollback");
    await assert.rejects(requestedPipeline("fixture", false, "expert", true), /required|requires/, "reruns still require the bridge");
    assert.equal(await requestedPipeline("fixture", false, "quick"), 2, "the legacy switch does not apply to Quick checks");
    assert.equal(await requestedPipeline("fixture", false, "expert"), 1);
    process.env.COURT_PIPELINE_VERSION = "3";
    assert.equal(await requestedPipeline("fixture", false, "quick"), 5);
    process.env.AI_GATEWAY_API_KEY = "placeholder";
    await assert.rejects(requestedPipeline("fixture", false, "quick"), /AI Gateway key are required/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
