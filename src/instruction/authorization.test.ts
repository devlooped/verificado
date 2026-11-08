import assert from "node:assert/strict";
import test from "node:test";
import { createGateway, generateText, jsonSchema, stepCountIs } from "ai";
import { defineSandboxProxy } from "@vercel/sandbox/proxy";
import type { CaseRecord } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { instructionSandboxLaunch } from "../evidence/broker.ts";
import { buildCaseLog, parseCaseLog } from "../evidence/case-log.ts";
import { assertToolCapability, authorizeSandboxBinding, committedPhase, type SandboxBinding } from "./authorization.ts";
import { validateGatewayGeneration } from "./gateway-validation.ts";
import { createTurnProxy } from "./proxy.ts";
import type { ToolActivity } from "../domain/tool-activity.ts";
import { preparationDefinitions } from "./preparation.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, SourceService } from "./sources.ts";
import { nativeResearchTools, NATIVE_GENERATION_MS } from "./native-research.ts";
import { toolSet } from "../../sandbox/harness/instruction-agent.ts";

const binding: SandboxBinding = { phase: "debate", seat: "grok", sessionKey: "debate:grok:preparation", phaseSessionId: "phase", expiresAt: "2026-11-06T00:00:00.000Z", revoked: false, model: { id: "fixture/model" }, gatewayTools: [], activeTurn: { id: "turn", expiresAt: "2026-11-05T23:00:00.000Z", remainingRequests: 10 } };
const context = { phase: "debate" as const, pipelineVersion: 2, status: "in_session", phaseSessionId: "phase", activeTurnId: "turn", now: Date.parse("2026-11-05T00:00:00.000Z") };

test("sandbox authorization rejects expired/revoked/unknown phase identities and inactive or exhausted grants", () => {
  assert.doesNotThrow(() => authorizeSandboxBinding(binding, context));
  assert.doesNotThrow(() => authorizeSandboxBinding(binding, { ...context, pipelineVersion: 3 }));
  assert.doesNotThrow(() => authorizeSandboxBinding(binding, { ...context, pipelineVersion: 4 }));
  assert.doesNotThrow(() => authorizeSandboxBinding(binding, { ...context, pipelineVersion: 5 }));
  for (const changed of [ { revoked: true }, { expiresAt: "invalid" }, { expiresAt: "2020-01-01" }, { activeTurn: undefined }, { activeTurn: { ...binding.activeTurn!, remainingRequests: 0 } }, { activeTurn: { ...binding.activeTurn!, expiresAt: "2020-01-01" } } ]) assert.throws(() => authorizeSandboxBinding({ ...binding, ...changed }, context));
  for (const changed of [{ phase: "instruction" as const }, { phase: "settling" as const }, { status: "resolved" }, { status: "failed" }, { pipelineVersion: 1 }, { phaseSessionId: "other" }, { activeTurnId: "other" }]) assert.throws(() => authorizeSandboxBinding(binding, { ...context, ...changed }));
});

test("sandbox authorization requires exact generation/run and cannot adopt legacy grants", () => {
  const writer = {generation:1,runId:"fixture-run"};
  assert.doesNotThrow(()=>authorizeSandboxBinding({...binding,writer},{...context,...{generation:1,runId:writer.runId}}));
  for (const changed of [{generation:0,runId:writer.runId},{generation:2,runId:writer.runId},{generation:1,runId:"other"}]) assert.throws(()=>authorizeSandboxBinding({...binding,writer},{...context,...changed}),/sandbox_forbidden/);
  assert.throws(()=>authorizeSandboxBinding(binding,{...context,generation:1,runId:writer.runId}),/sandbox_forbidden/);
});

test("generation-aware broker effects stay disabled before parsing or calling a provider", async (t) => {
  t.mock.method(console,"warn",()=>{});
  let effects=0;
  const proxy=createTurnProxy({origin:"https://fixture.example",teamId:"fixture-team",projectId:"fixture-project"},{
    consume:async()=>({caseId:"fixture",binding:{...binding,writer:{generation:1,runId:"fixture-run"}}}),
    generate:async()=>{effects++;throw new Error("must not call provider");},
  } as unknown as Parameters<typeof createTurnProxy>[1]);
  const response=await proxy(new Request("https://ai-gateway.vercel.sh/v4/ai/language-model",{method:"POST",body:"not-json"}),{teamId:"fixture-team",projectId:"fixture-project",sandboxName:"fixture-sandbox"} as Parameters<typeof proxy>[1]);
  assert.equal(response.status,403);assert.equal(effects,0);
});

test("committed phases close all research at settlement and retain criticism research only before it", () => {
  assert.equal(committedPhase([]), "intake");
  assert.equal(committedPhase([{ type: "instruction_opened" }]), "instruction");
  assert.equal(committedPhase([{ type: "evidence_unified", sources: [] }]), "criticism");
  assert.equal(committedPhase([{ type: "evidence_settled", schemaVersion: 2, manifestHash: "a".repeat(64) }]), "settling");
  assert.equal(committedPhase([{ type: "instruction_closed" }]), "debate");
  for (const phase of ["instruction", "criticism"] as const) for (const name of ["read_source", "web_search", "x_search"]) assert.doesNotThrow(() => assertToolCapability(phase, name));
  for (const name of ["read_source", "web_fetch", "web_search", "x_search", "translate", "read_file"]) assert.throws(() => assertToolCapability("debate", name));
  assert.doesNotThrow(() => assertToolCapability("debate", "read_evidence"));
});

test("new broker forwards only exact POST tools/generation paths and terminally denies unmatched allowed-domain requests", () => {
  const launch = instructionSandboxLaunch("fixture", "https://staging.example.test");
  assert.deepEqual(Object.keys(launch.env).sort(), ["AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "COURT_TOOL_ORIGIN"]);
  assert.equal(launch.env.AI_GATEWAY_API_KEY, "placeholder");
  assert.equal(typeof launch.networkPolicy, "object");
  const policy = launch.networkPolicy as { allow: Record<string, Array<{ match?: unknown; response?: { statusCode: number }; forwardURL?: string }>> };
  assert.equal(policy.allow["*"], undefined);
  for (const rules of Object.values(policy.allow)) { assert.equal(rules.length, 2); assert.equal(rules[1]?.response?.statusCode, 403); assert.equal(rules[0]?.forwardURL, "https://staging.example.test/api/sandbox"); }
  for (const origin of ["http://staging.example.test", "https://user:secret@staging.example.test", "https://staging.example.test/path", "https://localhost"]) assert.throws(() => instructionSandboxLaunch("fixture", origin));
});

test("gateway validation permits only snapshotted ordinary generation and preserves cache hints", () => {
  const request = new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { headers: { "ai-language-model-id": "fixture/model", "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false" } });
  const body = { prompt: [{ role: "system", content: "Canonical only", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }], tools: [], maxOutputTokens: 4096 };
  const before = JSON.stringify(body);
  validateGatewayGeneration(request, body, binding);
  assert.equal(JSON.stringify(body), before);
  for (const headers of [null, [], {}, "ai/7.0.157", { authorization: "Bearer fixture" }, { "user-agent": "ai/7.0.157", "ai-language-model-id": "other/model" }, { "user-agent": "untrusted" }, { "user-agent": "ai/7.0.157\r\nAuthorization: fixture" }, { "user-agent": "ai/7.0.157\n" }, { "user-agent": `ai/7.0.157-${"x".repeat(80)}` }]) assert.throws(() => validateGatewayGeneration(request, { ...body, headers }, binding), /generation_headers_forbidden/);
  for (const changed of [{ tools: [{ type: "provider-defined", id: "web_search" }] }, { providerOptions: { google: { useSearchGrounding: true } } }, { maxOutputTokens: 999_999 }, { responseFormat: { type: "url-reader" } }, { prompt: [{ role: "user", content: [{ type: "file", data: "https://foreign.test/source.pdf" }] }] }, { prompt: [{ role: "user", content: "x", providerOptions: { google: { retrieval: true } } }] }]) assert.throws(() => validateGatewayGeneration(request, { ...body, ...changed }, binding));
});

test("broker accepts actual SDK preparation requests in every phase without relaxing the snapshot", async () => {
  const models: SandboxBinding["model"][] = [
    { id: "fixture/model" },
    { id: "openai/fixture", providerOptions: { openai: { reasoningEffort: "high", promptCacheKey: "fixture-cache" } } },
    { id: "anthropic/fixture", providerOptions: { anthropic: { effort: "high" } } },
    { id: "google/fixture", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } },
    { id: "spacexai/fixture", providerOptions: { xai: { reasoningEffort: "high" } } },
  ];
  for (const phase of ["intake", "instruction", "criticism", "debate"] as const) for (const model of models) {
    const definitions = preparationDefinitions(phase);
    let calls = 0;
    const gateway = createGateway({ baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: "placeholder", fetch: async (url, init) => {
      calls++;
      const request = new Request(url, init);
      const body = JSON.parse(String(init?.body));
      assert.match(body.headers["user-agent"], /^ai\//, "capture SDK metadata rather than a hand-built request");
      const snapshot = { ...binding, phase, model, gatewayTools: definitions };
      validateGatewayGeneration(request, body, snapshot);
      assert.throws(() => validateGatewayGeneration(request, { ...body, maxOutputTokens: 8192 }, snapshot));
      assert.throws(() => validateGatewayGeneration(request, { ...body, providerOptions: { gateway: { models: ["other/model"] } } }, snapshot));
      return Response.json({ content: [{ type: "text", text: "Fixture analysis" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
    } });
    const result = await generateText({ model: gateway(model.id), providerOptions: model.providerOptions,
      system: "Canonical material only", messages: [{ role: "user", content: "Prepare", ...(model.id.startsWith("anthropic/") ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}) }],
      tools: Object.fromEntries(definitions.map((definition) => [definition.name, { description: definition.description, inputSchema: jsonSchema(definition.inputSchema), execute: async () => ({}) }])),
      maxOutputTokens: 4096, stopWhen: stepCountIs(1), maxRetries: 0,
    });
    assert.equal(result.text, "Fixture analysis");
    assert.equal(calls, 1);
  }
});

test("SDK proxy rejects missing/invalid OIDC, and dispatch rejects wrong identity/method/origin before case access", async () => {
  let calls = 0;
  const wrapped = defineSandboxProxy(async () => { calls++; return Response.json({ ok: true }); });
  assert.equal((await wrapped(new Request("https://staging.example.test/api/sandbox/any", { method: "POST" }))).status, 403);
  const dispatch = createTurnProxy({ origin: "https://staging.example.test", teamId: "team", projectId: "project" });
  const meta = { host: "staging.example.test", teamId: "wrong", projectId: "project", sandboxId: "sandbox", sandboxName: "sandbox" };
  assert.equal((await dispatch(new Request("https://staging.example.test/api/cases/fixture/turn-tools", { method: "POST" }), meta)).status, 403);
  meta.teamId = "team";
  for (const url of ["https://staging.example.test/api/cases/fixture/turn-tools", "https://staging.example.test/admin", "https://attacker.test/api/cases/fixture/turn-tools"]) assert.equal((await dispatch(new Request(url), meta)).status, 403);
  assert.equal(calls, 0);
});

test("persistent sandbox proxy binds the verified name across VM resumes and reuses generation checkpoints", async (t) => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { diagnostics.push(args); });
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository();
  const reader = new SourceService("fixture", "es", {
    artifacts, operations, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async () => { throw new Error("generation must not acquire sources"); },
  });
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission: { kind: "text", text: "Fixture", resolvedLanguage: "es" } };
  const body = { prompt: [{ role: "user", content: [{ type: "text", text: "Canonical only" }], providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }], tools: [], maxOutputTokens: 4096 };
  let generations = 0, auditError: string | undefined;
  const audit = new Map<string, unknown>();
  const dispatch = createTurnProxy({ origin: "https://staging.example.test", teamId: "team", projectId: "project" }, {
    consume: async (name) => { assert.equal(name, "persistent-fixture"); return { caseId: "fixture", binding }; },
    getCase: async () => ({ ...record, revision: 0 }), getEvents: async () => [], reader: () => reader, artifacts, activity: async () => {},
    audit: async (_caseId, key, value) => { if (auditError) throw new Error(auditError); if (audit.has(key)) assert.deepEqual(value, audit.get(key)); audit.set(key, value); },
    generate: async (_request, actual) => { generations++; assert.deepEqual(actual, body); return JSON.stringify({ content: [], usage: { inputTokens: { cacheRead: 42, cacheWrite: 10 } } }); },
  });
  const meta = { host: "ai-gateway.vercel.sh", teamId: "team", projectId: "project", sandboxName: "persistent-fixture", sandboxId: "vm-first" };
  const request = (input = body) => new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", headers: { "content-type": "application/json", "ai-language-model-id": "fixture/model", "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false", "x-court-call-id": "turn:0" }, body: JSON.stringify(input) });
  const first = await dispatch(request(), meta);
  assert.equal(first.status, 200);
  const resumed = await dispatch(request(), { ...meta, sandboxId: "vm-resumed" });
  assert.equal(resumed.status, 200);
  assert.equal(await resumed.text(), await first.text());
  assert.equal(generations, 1);
  assert.equal(audit.size, 1);
  assert.match(JSON.stringify([...audit.values()]), /cacheRead/);
  const changed = await dispatch(request({ ...body, prompt: [{ ...body.prompt[0], content: [{ type: "text", text: "Changed request" }] }] }), meta);
  assert.equal(changed.status, 403, "the same call ID cannot replay a different prompt");
  assert.equal(generations, 1);
  assert.deepEqual(diagnostics, [["Sandbox request rejected:", "generation_call_id_reused"]]);
  assert.deepEqual(await changed.json(), { error: "tool_request_unavailable" }, "public errors stay generic");
  auditError = "private upstream response with credentials";
  const failedAudit = await dispatch(request(), meta);
  assert.equal(failedAudit.status, 403);
  assert.deepEqual(diagnostics.at(-1), ["Sandbox request rejected:", "tool_request_unavailable"], "unknown error messages are never logged");
  assert.deepEqual(await failedAudit.json(), { error: "tool_request_unavailable" });
  assert.equal(generations, 1);
});

test("sandbox source calls publish caller-attributed activity through the authenticated proxy before reading", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository();
  const activities: ToolActivity[] = [];
  const reader = new SourceService("fixture", "es", {
    artifacts, operations, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-activity",
    translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async (url) => {
      assert.equal(activities.length, 1, "activity is durable before source acquisition begins");
      return { ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode("Fuente pública de prueba.") };
    },
  });
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-06T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission: { kind: "text", text: "Fixture", resolvedLanguage: "es" }, models: { "counsel.claude": { id: "anthropic/caller", effort: "high" } } };
  const dispatch = createTurnProxy({ origin: "https://staging.example.test", teamId: "team", projectId: "project" }, {
    consume: async () => ({ caseId: "fixture", binding: { ...binding, phase: "instruction", seat: "claude" } }),
    getCase: async () => ({ ...record, revision: 0 }), getEvents: async () => [], reader: () => reader, artifacts,
    activity: async (_id, activity) => { activities.push(activity); }, audit: async () => {},
    generate: async () => { throw new Error("No model calls are expected"); },
  });
  const response = await dispatch(new Request("https://staging.example.test/api/cases/fixture/turn-tools", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "read_source", input: { url: "https://example.test/report" }, callId: "read-source" }),
  }), { host: "staging.example.test", teamId: "team", projectId: "project", sandboxName: "persistent-fixture", sandboxId: "vm" });
  assert.equal(response.status, 200);
  assert.equal(activities[0].modelId, "anthropic/caller");
  assert.equal(activities[0].seat, "claude");
  assert.deepEqual(activities[0].data, { tool: "read_source", url: "https://example.test/report" });
});


test("pipeline 3 bindings accept exactly the seat's native research tools and their output budget", async () => {
  const models: SandboxBinding["model"][] = [
    { id: "spacexai/fixture", providerOptions: { xai: { reasoningEffort: "high" } } },
    { id: "openai/fixture", providerOptions: { openai: { reasoningEffort: "high" } } },
    { id: "anthropic/fixture", providerOptions: { anthropic: { effort: "high" } } },
    { id: "google/fixture", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } },
    { id: "other/fixture" },
  ];
  for (const phase of ["instruction", "criticism"] as const) for (const model of models) {
    const native = nativeResearchTools(model.id, phase);
    const snapshot: SandboxBinding = { ...binding, phase, model, gatewayTools: native, maxOutputTokens: null };
    let calls = 0;
    const gateway = createGateway({ baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: "placeholder", fetch: async (url, init) => {
      calls++;
      const request = new Request(url, init);
      const body = JSON.parse(String(init?.body));
      assert.equal(request.headers.get("ai-language-model-id"), model.id, "native tools keep the model routing header");
      validateGatewayGeneration(request, body, snapshot);
      const [first] = body.tools as Array<Record<string, unknown>>;
      const other = nativeResearchTools(model.id.startsWith("openai/") ? "google/x" : "openai/x", phase)[0];
      for (const tools of [[{ ...first, id: "xai.code_execution" }], [{ ...first, args: { ...first!.args as object, maxUses: 99 } }], [other]]) {
        assert.throws(() => validateGatewayGeneration(request, { ...body, tools }, snapshot), /generation_snapshot_mismatch/, "the request must equal the snapshot");
        assert.throws(() => validateGatewayGeneration(request, { ...body, tools }, { ...snapshot, gatewayTools: tools }), /native_tools_forbidden/, "a snapshot holds only the model's own tools");
      }
      assert.throws(() => validateGatewayGeneration(request, body, { ...snapshot, phase: "debate" }), /native_tools_forbidden/, "debate has no native research");
      assert.equal(body.maxOutputTokens, undefined, "native research sends no output cap");
      assert.throws(() => validateGatewayGeneration(request, { ...body, maxOutputTokens: 16_384 }, snapshot), /generation_snapshot_mismatch/);
      const { maxOutputTokens: _, ...pipeline2 } = snapshot;
      assert.throws(() => validateGatewayGeneration(request, body, pipeline2), /generation_snapshot_mismatch/, "a pipeline 2 binding keeps 4096 output tokens");
      return Response.json({ content: [{ type: "text", text: "Report" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
    } });
    const task = { caseId: "fixture", callId: "turn:0", model, system: "Research", messages: [], tools: native, resultPath: "/workspace/result.json" };
    const result = await generateText({ model: gateway(model.id), providerOptions: model.providerOptions, system: "Research", prompt: "Claims",
      tools: toolSet(task, undefined, new AbortController().signal), stopWhen: stepCountIs(1), maxRetries: 0 });
    assert.equal(result.text, "Report");
    assert.equal(calls, 1);
  }
});

test("the broker gives native research its longer call and audits what the provider cited", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository();
  const reader = new SourceService("fixture", "es", {
    artifacts, operations, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-native",
    translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async () => { throw new Error("generation must not acquire sources"); },
  });
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-06T00:00:00.000Z", status: "in_session", pipelineVersion: 3, submission: { kind: "text", text: "Fixture", resolvedLanguage: "es" } };
  const model = { id: "openai/fixture" };
  const native = nativeResearchTools(model.id, "instruction");
  const nativeBinding: SandboxBinding = { ...binding, phase: "instruction", seat: "chatgpt", model, gatewayTools: native, maxOutputTokens: null };
  const body = { prompt: [{ role: "user", content: [{ type: "text", text: "Claims" }] }], tools: native };
  const timeouts: Array<number | undefined> = [];
  const audit: Array<{ data: Record<string, unknown> }> = [];
  const dispatch = createTurnProxy({ origin: "https://staging.example.test", teamId: "team", projectId: "project" }, {
    consume: async () => ({ caseId: "fixture", binding: nativeBinding }),
    getCase: async () => ({ ...record, revision: 0 }), getEvents: async () => [], reader: () => reader, artifacts, activity: async () => {},
    audit: async (_caseId, _key, value) => { audit.push(value as { data: Record<string, unknown> }); },
    generate: async (_request, _body, timeoutMs) => {
      timeouts.push(timeoutMs);
      return JSON.stringify({ content: [
        { type: "tool-call", toolCallId: "s1", toolName: "web_search", input: "{}", providerExecuted: true },
        { type: "tool-result", toolCallId: "s1", toolName: "web_search", result: {} },
        { type: "source", sourceType: "url", id: "1", url: "https://example.test/report", title: "Report" },
        { type: "text", text: "Report" },
      ], usage: {} });
    },
  });
  const response = await dispatch(new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", headers: { "content-type": "application/json", "ai-language-model-id": model.id, "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false", "x-court-call-id": "turn:0" }, body: JSON.stringify(body) }),
    { host: "ai-gateway.vercel.sh", teamId: "team", projectId: "project", sandboxName: "persistent-fixture", sandboxId: "vm" });
  assert.equal(response.status, 200);
  assert.deepEqual(timeouts, [NATIVE_GENERATION_MS]);
  assert.deepEqual(audit[0]!.data.sources, [{ url: "https://example.test/report", title: "Report" }]);
  assert.equal(audit[0]!.data.searches, 1);
  // The citations survive the public case log.
  const [step] = parseCaseLog(buildCaseLog([], audit, []));
  assert.equal(step!.kind, "model_step");
  assert.deepEqual(step!.data.sources, [{ url: "https://example.test/report", title: "Report" }]);
  assert.equal(step!.data.searches, 1);
});
