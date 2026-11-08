import type { ProxyHandler } from "@vercel/sandbox/proxy";
import { z } from "zod";
import { courtModel, modelEffort } from "../court/models.ts";
import { sharedPipeline, type CaseRecord } from "../domain/court.ts";
import { caseArtifactStore } from "../evidence/blob.ts";
import { trustedInstructionOrigin } from "../evidence/broker.ts";
import { sha256 } from "../evidence/validate.ts";
import { consumeSandboxBinding, getCase, getEvents, recordCaseToolActivity, saveCaseAuditRecord } from "../store.ts";
import { type SandboxBinding } from "./authorization.ts";
import { validateGatewayGeneration } from "./gateway-validation.ts";
import { hasNativeTools, nativeCitations, NATIVE_GENERATION_MS } from "./native-research.ts";
import { sourceDownloader } from "./research.ts";
import { liveSourceDependencies, SourceService } from "./sources.ts";
import { executeSourceTool } from "./tools.ts";
import { instructionBridgeConfig } from "./config.ts";
import { requireContinuationEnabled } from "../domain/continuation.ts";

export function caseSourceService(record: CaseRecord): SourceService {
  const translator = record.models?.translator;
  const researcher = record.models?.["research.x"];
  if (!translator || !researcher || !record.submission.resolvedLanguage) throw new Error("Processing snapshot unavailable");
  const dependencies = liveSourceDependencies(courtModel(translator.id, translator.effort), record.id);
  dependencies.download = sourceDownloader(courtModel(researcher.id, researcher.effort), record.id);
  return new SourceService(record.id, record.submission.resolvedLanguage, dependencies);
}

const ToolRequest = z.object({ tool: z.enum(["read_source", "read_evidence", "web_search", "x_search"]), input: z.unknown(), callId: z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/) }).strict();

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing_request_body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("request_too_large"); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function forwardGatewayGeneration(request: Request, body: unknown, timeoutMs = 150_000): Promise<string> {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!key || key === "placeholder") throw new Error("gateway_key_unavailable");
  const response = await fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(body), headers: {
    "content-type": "application/json", authorization: `Bearer ${key}`,
    // Match the installed Gateway SDK wire protocol, using host-owned auth.
    "ai-gateway-protocol-version": "0.0.1", "ai-gateway-auth-method": "api-key",
    "ai-language-model-id": request.headers.get("ai-language-model-id")!,
    "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false",
  } });
  if (!response.ok) {
    console.warn("Gateway generation rejected:", response.status);
    throw new Error("gateway_generation_failed");
  }
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new Error("gateway_result_too_large");
  return text;
}

const live = { consume: consumeSandboxBinding, getCase, getEvents, reader: caseSourceService, artifacts: caseArtifactStore, audit: saveCaseAuditRecord, activity: recordCaseToolActivity, generate: forwardGatewayGeneration };
export type TurnProxyDependencies = typeof live;

async function generation(request: Request, body: unknown, caseId: string, binding: SandboxBinding, deps: TurnProxyDependencies) {
  validateGatewayGeneration(request, body, binding);
  const callId = request.headers.get("x-court-call-id");
  if (!callId || !/^[a-zA-Z0-9:_-]{1,160}$/.test(callId)) throw new Error("missing_generation_call_id");
  const reader = deps.reader((await deps.getCase(caseId))!);
  const requestText = JSON.stringify(body);
  const requestHash = sha256(requestText);
  const key = `sandbox-generation:${binding.phaseSessionId}:${sha256(callId)}`;
  // Pipeline 3 research runs the provider's searches within this one call.
  const native = hasNativeTools(binding.gatewayTools);
  const result = await reader.hostStage(key, "sandbox-generation", async () => {
    const text = await deps.generate(request, body, native ? NATIVE_GENERATION_MS : undefined);
    const parsed = JSON.parse(text) as { usage?: unknown };
    const root = `${binding.phase === "debate" ? "discussion" : "instruction/runs"}/${binding.seat}/${binding.activeTurn!.id}/${sha256(callId)}`;
    const requestPath = `${root}/request.json`;
    const resultPath = `${root}/result.json`;
    await deps.artifacts.write(caseId, new Map([[requestPath, requestText], [resultPath, text]]));
    return { requestHash, requestPath, resultPath, resultHash: sha256(text), usage: parsed.usage ?? null, at: new Date().toISOString() };
  });
  if (result.requestHash !== requestHash) throw new Error("generation_call_id_reused");
  const bytes = (await deps.artifacts.read(caseId)).get(result.resultPath);
  if (!bytes || sha256(bytes) !== result.resultHash) throw new Error("generation_result_unavailable");
  const id = `step:${binding.phaseSessionId}:${sha256(callId)}`;
  const text = new TextDecoder().decode(bytes);
  // What the provider cited, and its billable searches, go to case.jsonl.
  const cited = native ? nativeCitations(JSON.parse(text)) : undefined;
  await deps.audit(caseId, id, { schemaVersion: 2, id, kind: "model_step", at: result.at, seat: binding.seat, phase: binding.phase, modelId: binding.model.id, effort: modelEffort(binding.model), data: { sessionId: binding.phaseSessionId, turnId: binding.activeTurn!.id, callId, channel: "preparation", sequence: (body.prompt as unknown[]).length, usage: result.usage, request: result.requestPath, result: result.resultPath, ...cited } });
  return new Response(text, { headers: { "content-type": "application/json" } });
}

export function createTurnProxy(config: { origin: string; teamId: string; projectId: string }, deps: TurnProxyDependencies = live): ProxyHandler {
  const origin = trustedInstructionOrigin(config.origin);
  return async (request, meta) => {
    if (!config.teamId || !config.projectId || meta.teamId !== config.teamId || meta.projectId !== config.projectId) return Response.json({ error: "sandbox_forbidden" }, { status: 403 });
    const url = new URL(request.url);
    const toolPath = /^\/api\/cases\/([a-zA-Z0-9_-]+)\/turn-tools$/.exec(url.pathname);
    const isGeneration = url.origin === "https://ai-gateway.vercel.sh" && url.pathname === "/v4/ai/language-model";
    if (request.method !== "POST" || url.search || (!isGeneration && (url.origin !== origin || !toolPath))) return Response.json({ error: "route_forbidden" }, { status: 403 });
    try {
      // Persistent SDK sandboxes resume by name; their VM ID may change on
      // resume. Both values are OIDC-verified, but the binding stores the name.
      const { caseId, binding } = await deps.consume(meta.sandboxName, toolPath?.[1]);
      // Generation-aware broker effects need generation-isolated artifacts and
      // retention (step 4). Do not authorize them with legacy paths meanwhile.
      if(binding.writer) requireContinuationEnabled();
      const body = await boundedJson(request);
      if (isGeneration) return await generation(request, body, caseId, binding, deps);
      const call = ToolRequest.parse(body);
      const record = await deps.getCase(caseId);
      if (!record || !sharedPipeline(record.pipelineVersion)) throw new Error("case_unavailable");
      const events = await deps.getEvents(caseId);
      return Response.json(await executeSourceTool(call, { record, events, phase: binding.phase, seat: binding.seat, turnId: binding.activeTurn!.id, reader: deps.reader(record), artifacts: deps.artifacts, activity: deps.activity }));
    } catch (error) {
      // Keep public responses generic and log only known codes, never request
      // bodies, credentials, source text or arbitrary upstream error messages.
      const reason = error instanceof Error && [
        "invalid_generation", "generation_headers_forbidden", "generation_snapshot_mismatch", "native_tools_forbidden", "tool_choice_forbidden",
        "external_model_content_forbidden", "message_options_forbidden", "missing_generation_call_id", "generation_call_id_reused",
        "generation_result_unavailable", "gateway_key_unavailable", "gateway_generation_failed", "gateway_result_too_large", "sandbox_forbidden",
      ].includes(error.message) ? error.message : "tool_request_unavailable";
      console.warn("Sandbox request rejected:", reason);
      return Response.json({ error: "tool_request_unavailable" }, { status: 403 });
    }
  };
}

export const dispatchSandboxRequest: ProxyHandler = async (request, meta) => {
  try { return await createTurnProxy(await instructionBridgeConfig())(request, meta); }
  catch { return Response.json({ error: "sandbox_bridge_unavailable" }, { status: 503 }); }
};
