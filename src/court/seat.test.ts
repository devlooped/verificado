import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { courtMaxOutputTokens, DEFAULT_MODELS, JUDGE_MODEL } from "./models.ts";

const xResearcher = DEFAULT_MODELS["research.x"];
import { runSeat } from "./seat.ts";
import { Rejection, tool } from "./toolset.ts";
import { conductTurn } from "./turns.ts";

function call(toolName: string, input: unknown, id = "call") {
  return {
    content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
    warnings: [],
  };
}

test("the AI tool loop returns validation and court rejections to the model, then stops when the turn is complete", async () => {
  let committed = 0;
  const model = new MockLanguageModelV4({ doGenerate: [
    call("record", { amount: "invalid" }, "invalid"),
    call("record", { amount: 2 }, "rejected"),
    call("record", { amount: 1 }, "accepted"),
  ] });
  await runSeat({
    model: JUDGE_MODEL,
    research: false,
    xResearcher,
    prompt: "Record exactly one item.",
    done: () => committed === 1,
    tools: { record: tool("Record an item", z.object({ amount: z.number() }), ({ amount }) => {
      if (amount !== 1) throw new Rejection("Only one item allowed");
      committed++;
      return "Recorded";
    }) },
  }, model);
  assert.equal(committed, 1);
  assert.equal(model.doGenerateCalls.length, 3, "completion must not trigger another model request");
  assert.ok(model.doGenerateCalls.every((call) => call.maxOutputTokens === courtMaxOutputTokens()));
  assert.match(JSON.stringify(model.doGenerateCalls[1].prompt), /error/);
  assert.match(JSON.stringify(model.doGenerateCalls[2].prompt), /Only one item allowed/);
  assert.deepEqual(model.doGenerateCalls[0].providerOptions, JUDGE_MODEL.providerOptions);
  assert.deepEqual(model.doGenerateCalls[0].toolChoice, { type: "required" });
  assert.deepEqual(model.doGenerateCalls[0].tools?.map((t) => t.name).sort(), ["record", "web_fetch"]);
});

test("legacy seats use research and debate output overrides", async (t) => {
  const keys = ["CONTEXT_SIZE", "RESEARCH_CONTEXT_SIZE", "DEBATE_CONTEXT_SIZE"] as const;
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { CONTEXT_SIZE: "10000", RESEARCH_CONTEXT_SIZE: "24000", DEBATE_CONTEXT_SIZE: "8000" });
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  for (const [research, outputPhase, expected] of [[true, undefined, 24000], [false, "research", 24000], [false, "debate", 8000], [false, undefined, 10000]] as const) {
    const model = new MockLanguageModelV4({ doGenerate: call("record", { amount: 1 }) });
    await runSeat({ model: JUDGE_MODEL, xResearcher, research, outputPhase, prompt: "Record", done: () => true,
      tools: { record: tool("Record", z.object({ amount: z.number() }), () => "Recorded") } }, model);
    assert.equal(model.doGenerateCalls[0].maxOutputTokens, expected);
  }
});

test("an image submission is sent as binary image input and the judge can enter claims", async () => {
  const model = new MockLanguageModelV4({ doGenerate: call("enter_claims", { claims: [{ quote: "", text: "Córdoba tiene más habitantes que CABA." }] }) });
  const image = new Uint8Array([137, 80, 78, 71]);
  const outcome = await conductTurn({ submission: { kind: "image", mimeType: "image/png" }, today: "30 de octubre de 2026" }, { kind: "intake" }, [], 0,
    async ({ prompt, tools, done }) => runSeat({ model: JUDGE_MODEL, xResearcher, research: false, prompt, tools, done, images: [{ data: image, mimeType: "image/png" }] }, model));
  assert(outcome.done);
  assert.equal(outcome.events[0]?.type, "claims_entered");
  const content = model.doGenerateCalls[0].prompt[0].content;
  assert(Array.isArray(content));
  const part = content.find((p) => p.type === "file");
  assert(part?.type === "file");
  assert.equal(part.mediaType, "image/png");
  assert.deepEqual(part.data, { type: "data", data: image });
});

test("an unfinished agent cannot loop past the seat generation limit", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => call("again", {}, "call-" + calls++) });
  await runSeat({
    model: JUDGE_MODEL, xResearcher, research: true, prompt: "Continue", done: () => false,
    tools: { again: tool("Continue", z.object({}), () => "Continue") },
  }, model);
  assert.equal(calls, 20);
  assert.deepEqual(model.doGenerateCalls[0].tools?.map((t) => t.name).sort(), ["again", "web_fetch", "web_search", "x_search"]);
});

test("a failed provider call leaves a turn unfinished so the court can retry it", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("Gateway unavailable"); } });
  const outcome = await conductTurn({ submission: { kind: "text", text: "Una afirmación verificable para analizar." }, today: "hoy" }, { kind: "intake" }, [], 0,
    async ({ prompt, tools, done }) => runSeat({ model: JUDGE_MODEL, xResearcher, research: false, prompt, tools, done }, model));
  assert.equal(outcome.done, false);
  assert.deepEqual(outcome.events, []);
});

test("instruction keeps collecting evidence until the analyst explicitly completes both searches", async () => {
  const evidence = { claimId: "A1", title: "Censo 2022", url: "https://www.indec.gob.ar/", excerpt: "La provincia de Córdoba supera la población de CABA.", stance: "supports" };
  const model = new MockLanguageModelV4({ doGenerate: [
    call("file_evidence", evidence, "source-1"),
    call("file_evidence", { ...evidence, title: "Otra fuente del censo" }, "source-2"),
    call("finish_instruction", { searches: [{ claimId: "A1", supporting: "Consulté las tablas oficiales del Censo 2022.", opposing: "Busqué datos contrarios y no encontré respaldo verificable." }] }, "complete"),
  ] });
  const outcome = await conductTurn({ submission: { kind: "text", text: "Córdoba tiene más habitantes que CABA." }, today: "hoy" }, { kind: "instruction", counsel: "grok" }, [
    { type: "claims_entered", claims: [{ id: "A1", quote: "", text: "Córdoba tiene más habitantes que CABA." }] },
  ], 0, async ({ prompt, tools, done }) => runSeat({ model: JUDGE_MODEL, xResearcher, research: true, prompt, tools, done }, model));
  assert(outcome.done);
  assert.equal(outcome.events.filter((e) => e.type === "evidence_filed").length, 2);
  assert.equal(model.doGenerateCalls.length, 3);
  assert.deepEqual(model.doGenerateCalls[0].toolChoice, { type: "required" });
});

test("captures complete research tool calls and results without capturing court tools", async () => {
  const submission = { kind: "text" as const, text: "Una afirmación verificable para analizar." };
  const spec = { kind: "instruction" as const, counsel: "grok" as const };
  const record = [{ type: "claims_entered" as const, claims: [{ id: "A1", quote: "", text: submission.text }] }];
  const steps: Array<{ stepNumber: number; content: unknown[] }> = [];
  const outcome = await conductTurn({ submission, today: "hoy", simulated: true }, spec, record, 0,
    async ({ prompt, tools, done }) => runSeat({ model: JUDGE_MODEL, xResearcher, research: true, prompt, tools, done, mock: { spec, record, submission }, onResearchStep: (step) => steps.push(step) }));
  assert.equal(outcome.done, true);
  const content = JSON.stringify(steps);
  assert.match(content, /web_search/);
  assert.match(content, /web_fetch/);
  assert.match(content, /Documento de prueba con aportes/);
  assert.doesNotMatch(content, /file_evidence|finish_instruction/);
});

test("retains completed research steps if a later model call fails", async () => {
  const submission = { kind: "text" as const, text: "Una afirmación verificable para analizar." };
  const spec = { kind: "instruction" as const, counsel: "grok" as const };
  const steps: unknown[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    if (calls++ === 0) return call("web_fetch", { url: "https://example.test/article" });
    throw new Error("Gateway unavailable");
  } });
  await assert.rejects(runSeat({ model: JUDGE_MODEL, xResearcher, research: true, prompt: "Investigá", tools: {},
    mock: { spec, record: [], submission }, onResearchStep: (step) => steps.push(step) }, model), /Gateway unavailable/);
  assert.match(JSON.stringify(steps), /Documento de prueba con aportes/);
});

test("captures research executed by the gateway provider", async () => {
  const steps: unknown[] = [];
  const response = call("web_fetch", { url: "https://example.test/article" }, "fetch-1");
  const model = new MockLanguageModelV4({ doGenerate: {
    ...response,
    content: [
      { ...response.content[0]!, providerExecuted: true },
      { type: "tool-result", toolCallId: "fetch-1", toolName: "web_fetch", result: { content: "Texto devuelto por el proveedor" } },
    ],
  } });
  await runSeat({ model: JUDGE_MODEL, xResearcher, research: false, prompt: "Leé", tools: {}, onResearchStep: (step) => steps.push(step) }, model);
  assert.match(JSON.stringify(steps), /Texto devuelto por el proveedor/);
});
