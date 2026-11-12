import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { createQuickMockModel } from "./mock.ts";
import { courtMaxOutputTokens, courtModel } from "./models.ts";
import { quickAnswer, quickClassify, quickIdentifyClaims, quickSummarize, quickSynthesize, quickTiebreak, quickVote, type QuickPlayDependencies, type QuickStep } from "./quick-play.ts";
import { failed, holdQuickSession } from "./quick.ts";
import { COUNSEL, project, type RecordedEvent, type Submission } from "../domain/court.ts";

const CASE = "quick-fixture";
const MODEL = courtModel("anthropic/claude-opus-5.5", "high");

function deps(step: QuickStep, artifacts = new MemoryArtifactStore(), audit: Array<{ id: string; body: Record<string, unknown> }> = []): QuickPlayDependencies {
  return {
    artifacts, model: createQuickMockModel(step),
    audit: async (_caseId, id, body) => void audit.push({ id, body: body as Record<string, unknown> }),
    getImage: async () => ({ mimeType: "image/png", bytes: Buffer.from([1, 2, 3]) }),
  };
}

test("an answer, its vote and a tie-break write their request, result and model step", async () => {
  const artifacts = new MemoryArtifactStore();
  const audit: Array<{ id: string; body: Record<string, unknown> }> = [];
  const submission = { kind: "image" as const, mimeType: "image/png", note: "¿Es real?" };
  const answer = await quickAnswer(CASE, submission, "es", MODEL, "claude", 0, deps("answer", artifacts, audit));
  assert.ok(!failed(answer));
  assert.match(answer.text, /SIMULACIÓN LOCAL/);
  const vote = await quickVote(CASE, submission, "es", MODEL, "claude", answer, 0, undefined, deps("vote", artifacts, audit));
  assert.ok(!failed(vote));
  assert.equal(vote.verdict, "no_verificable");
  const decision = await quickTiebreak(CASE, submission, "es", MODEL, [{ by: "claude", answer: answer.text, vote }], 0, deps("tiebreak", artifacts, audit));
  assert.ok(!failed(decision));

  const files = await artifacts.read(CASE);
  assert.deepEqual([...files.keys()].sort(), ["answer-0", "vote-0"].flatMap((step) => [`quick/claude/${step}/request.json`, `quick/claude/${step}/result.json`]).concat(["quick/judge/tiebreak-0/request.json", "quick/judge/tiebreak-0/result.json"]).sort());
  for (const [path, bytes] of files) if (path.endsWith("/request.json")) assert.equal(JSON.parse(new TextDecoder().decode(bytes)).maxOutputTokens, courtMaxOutputTokens(path.includes("/answer-") ? "research" : undefined));
  const request = new TextDecoder().decode(files.get("quick/claude/vote-0/request.json"));
  assert.match(request, /FACT CHECK:/);
  assert.match(request, /\(the submitted image\)/, "the image bytes stay out of request.json");
  assert.equal(JSON.parse(request).reasoning, "none");
  assert.deepEqual(audit.map((a) => a.id), ["quick:claude:answer:0", "quick:claude:vote:0", "quick:judge:tiebreak:0"]);
  assert.deepEqual(audit.map((a) => [a.body.kind, a.body.seat, a.body.phase, (a.body.data as { sessionId: string }).sessionId]), [
    ["model_step", "claude", "quick", "quick:claude"], ["model_step", "claude", "quick", "quick:claude"], ["model_step", "judge", "quick", "quick:judge"],
  ]);
});

test("Quick claims, answers, votes and tiebreaks carry the same case date", async () => {
  const artifacts = new MemoryArtifactStore();
  const submission: Submission = { kind: "text", text: "Today the price fell." };
  const date = "2026-11-07";
  const claims = await quickIdentifyClaims(CASE, submission, "en", MODEL, 0, deps("claims", artifacts), date);
  assert.ok(!failed(claims));
  const answer = await quickAnswer(CASE, submission, "en", MODEL, "claude", 0, deps("answer", artifacts), [], date);
  assert.ok(!failed(answer));
  const vote = await quickVote(CASE, submission, "en", MODEL, "claude", answer, 0, undefined, deps("vote", artifacts), undefined, date);
  assert.ok(!failed(vote));
  assert.ok(!failed(await quickTiebreak(CASE, submission, "en", MODEL, [{ by: "claude", answer: answer.text, vote }], 0, deps("tiebreak", artifacts), undefined, date)));
  const requests = [...(await artifacts.read(CASE))].filter(([path]) => path.endsWith("/request.json"));
  assert.equal(requests.length, 4);
  for (const [, bytes] of requests) {
    const request = JSON.parse(new TextDecoder().decode(bytes));
    assert.match(request.system, /November 07, 2026/);
    assert.match(request.system, /Resolve relative dates/);
    assert.match(JSON.stringify(request.messages), /Today the price fell/);
  }
});

test("all Quick generations send the configured output cap to the model", async (t) => {
  const keys = ["CONTEXT_SIZE", "RESEARCH_CONTEXT_SIZE", "DEBATE_CONTEXT_SIZE"] as const;
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, { CONTEXT_SIZE: "12345", RESEARCH_CONTEXT_SIZE: "24000", DEBATE_CONTEXT_SIZE: "8000" });
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  const calls: number[] = [];
  const configured = (step: "claims" | "answer" | "vote" | "tiebreak" | "summary") => {
    const injected = deps(step);
    const underlying = createQuickMockModel(step);
    injected.model = new MockLanguageModelV4({ doGenerate: async (options) => {
      calls.push(options.maxOutputTokens!);
      return underlying.doGenerate(options);
    } });
    return injected;
  };
  const submission: Submission = { kind: "text", text: "A claim to check" };
  const claims = await quickIdentifyClaims(CASE, submission, "es", MODEL, 0, configured("claims"));
  assert.ok(!failed(claims));
  const answer = await quickAnswer(CASE, submission, "es", MODEL, "claude", 0, configured("answer"));
  assert.ok(!failed(answer));
  const vote = await quickVote(CASE, submission, "es", MODEL, "claude", answer, 0, undefined, configured("vote"));
  assert.ok(!failed(vote));
  assert.ok(!failed(await quickTiebreak(CASE, submission, "es", MODEL, [{ by: "claude", answer: answer.text, vote }], 0, configured("tiebreak"))));
  assert.ok(!failed(await quickSummarize(CASE, "es", MODEL, [{ verdict: "falso", votes: [{ by: "claude", rationale: "No" }] }], 0, configured("summary"))));
  assert.deepEqual(calls, [12_345, 24_000, 12_345, 12_345, 12_345]);
  const link: Submission = { kind: "link", url: "https://example.test/claim" };
  assert.ok(!failed(await quickIdentifyClaims(CASE, link, "es", MODEL, 0, configured("claims"))));
  assert.equal(calls.at(-1), 24_000, "link claim identification can research");
});

test("a step run again reuses the result already written instead of calling the model again", async () => {
  const artifacts = new MemoryArtifactStore();
  const submission = { kind: "text" as const, text: "La pobreza bajó al 31,6 %." };
  const first = await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, deps("answer", artifacts));
  const again = deps("answer", artifacts);
  again.model = createQuickMockModel("vote");
  assert.deepEqual(await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, again), first);
});

test("a majority summary is audited, uses no tools and reuses its recorded result on replay", async () => {
  const artifacts = new MemoryArtifactStore();
  const audit: Array<{ id: string; body: Record<string, unknown> }> = [];
  const majorities = [{ verdict: "falso" as const, votes: [{ by: "grok" as const, rationale: "El dato no coincide." }] }];
  const first = await quickSummarize(CASE, "es", MODEL, majorities, 0, deps("summary", artifacts, audit));
  assert.ok(!failed(first));
  assert.match(first.text, /SIMULACIÓN LOCAL/);
  const files = await artifacts.read(CASE);
  const request = JSON.parse(new TextDecoder().decode(files.get("quick/judge/summary-0/request.json")));
  assert.deepEqual(request.tools, []);
  assert.match(JSON.stringify(request.messages), /El dato no coincide/);
  assert.deepEqual(audit.map((entry) => entry.id), ["quick:judge:summary:0"]);
  const replay = deps("summary", artifacts);
  replay.model = { ...createQuickMockModel("summary"), doGenerate: async () => { throw new Error("unexpected call"); } } as unknown as QuickPlayDependencies["model"];
  assert.deepEqual(await quickSummarize(CASE, "es", MODEL, majorities, 0, replay), first);
});

test("a model failure and a vote that does not parse are results for the orchestration to retry", async () => {
  const submission = { kind: "text" as const, text: "La pobreza bajó al 31,6 %." };
  const broken = deps("answer");
  broken.model = { ...createQuickMockModel("answer"), doGenerate: async () => { throw new Error("gateway down"); } } as unknown as QuickPlayDependencies["model"];
  assert.deepEqual(await quickAnswer(CASE, submission, "es", MODEL, "gemini", 0, broken), { error: "gateway down" });
  const prose = await quickVote(CASE, submission, "es", MODEL, "gemini", { text: "Es falso.", sources: [], at: "2026-11-07T00:00:00.000Z" }, 0, undefined, deps("answer"));
  assert.ok(failed(prose));
  assert.match(prose.text ?? "", /SIMULACIÓN LOCAL/);
});

test("claim identification, individual votes and tie-breaks have distinct replay-safe artifacts", async () => {
  const artifacts = new MemoryArtifactStore();
  const audit: Array<{ id: string; body: Record<string, unknown> }> = [];
  const submission: Submission = { kind: "image", mimeType: "image/png", identifyClaims: true, check: "quick" };
  const identified = await quickIdentifyClaims(CASE, submission, "es", MODEL, 0, deps("claims", artifacts, audit));
  assert.ok(!failed(identified));
  assert.deepEqual(identified.claims.map((c) => c.id), ["A1", "A2"]);
  const answer = await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, deps("answer", artifacts, audit), identified.claims);
  assert.ok(!failed(answer));
  for (const claim of [...identified.claims, undefined]) {
    const vote = await quickVote(CASE, submission, "es", MODEL, "grok", answer, 0, undefined, deps("vote", artifacts, audit), claim);
    assert.ok(!failed(vote));
    const decision = await quickTiebreak(CASE, submission, "es", MODEL, [{ by: "grok", answer: answer.text, vote }], 0, deps("tiebreak", artifacts, audit), claim);
    assert.ok(!failed(decision));
  }
  const files = await artifacts.read(CASE);
  assert.equal(files.size, 16);
  assert.equal(new Set(audit.map((a) => a.id)).size, 8);
  const decode = (path: string) => JSON.parse(new TextDecoder().decode(files.get(path)));
  const extraction = decode("quick/judge/claims-0/request.json");
  assert.deepEqual(extraction.tools, []);
  assert.match(JSON.stringify(extraction), /the submitted image/);
  const research = decode("quick/grok/answer-0/request.json");
  assert.match(JSON.stringify(research.messages), /A1.*A2/);
  const claimVote = decode("quick/grok/claims/A1/vote-0/request.json");
  assert.match(JSON.stringify(claimVote.messages), /ONLY.*A1/s);
  assert.equal(claimVote.reasoning, "none");
  assert.equal(claimVote.tools, undefined);
  const repeated = deps("answer", artifacts);
  repeated.model = { ...createQuickMockModel("answer"), doGenerate: async () => { throw new Error("unexpected model call on replay"); } } as unknown as QuickPlayDependencies["model"];
  assert.deepEqual(await quickIdentifyClaims(CASE, submission, "es", MODEL, 0, repeated), identified);
  const replay = await quickVote(CASE, submission, "es", MODEL, "grok", answer, 0, undefined, repeated, identified.claims[0]);
  assert.ok(!failed(replay));
  const judgeSteps = audit.filter((a) => a.body.seat === "judge");
  assert.deepEqual(judgeSteps.map((a) => (a.body.data as { sequence: number }).sequence), [0, 0, 0, 2]);
});

test("the optional quick flow runs end to end through simulated calls for text, links and images", async () => {
  for (const submission of [
    { kind: "text" as const, text: "Primera afirmación. Segunda afirmación." },
    { kind: "link" as const, url: "https://example.test/nota" },
    { kind: "image" as const, mimeType: "image/png", note: "Dos afirmaciones" },
  ]) {
    const artifacts = new MemoryArtifactStore();
    const events: RecordedEvent[] = [];
    const selected = { ...submission, check: "quick" as const, identifyClaims: true };
    await holdQuickSession({
      submission: selected, models: { judge: MODEL.id, counsel: Object.fromEntries(COUNSEL.map((by) => [by, MODEL.id])) as Record<typeof COUNSEL[number], string> },
      identify: (attempt) => quickIdentifyClaims(CASE, selected, "es", MODEL, attempt, deps("claims", artifacts)),
      answer: (by, attempt, claims) => quickAnswer(CASE, selected, "es", MODEL, by, attempt, deps("answer", artifacts), claims),
      vote: (by, answer, attempt, retry, claim) => quickVote(CASE, selected, "es", MODEL, by, answer, attempt, retry, deps("vote", artifacts), claim),
      tiebreak: (entries, attempt, claim) => quickTiebreak(CASE, selected, "es", MODEL, entries, attempt, deps("tiebreak", artifacts), claim),
      summarize: (majorities, attempt) => quickSummarize(CASE, "es", MODEL, majorities, attempt, deps("summary", artifacts)),
      commit: async (batch) => void events.push(...batch),
    });
    const view = project(events);
    assert.equal(view.closed, true, submission.kind);
    assert.equal(view.claims.length, 2);
    assert.ok(view.claims.every((claim) => claim.judgment?.verdict === "no_verificable" && Object.keys(claim.votes).length === 4));
    assert.equal(view.contentJudgment?.verdict, "no_verificable");
    assert.match(view.summary ?? "", /SIMULACIÓN LOCAL/);
    assert.equal((await artifacts.read(CASE)).size, 36);
  }
});

test("the classifier, the answers to questions and their syntheses write their request, result and model step", async () => {
  const artifacts = new MemoryArtifactStore();
  const audit: Array<{ id: string; body: Record<string, unknown> }> = [];
  const question: Submission = { kind: "text", text: "¿Cuántos habitantes tiene la Argentina?", check: "quick" };
  const classifier = courtModel("openai/gpt-6.1-terra", "medium");
  const classified = await quickClassify(CASE, question, "es", classifier, 0, deps("classify", artifacts, audit), "2026-11-11");
  assert.ok(!failed(classified));
  assert.equal(classified.kind, "question");
  assert.deepEqual(classified.items.map((item) => item.id), ["P1"]);
  const assertions = await quickClassify(CASE, { kind: "text", text: "La Argentina tiene 46 millones de habitantes." }, "es", classifier, 1, deps("classify", artifacts, audit));
  assert.ok(!failed(assertions));
  assert.equal(assertions.kind, "assertion");
  assert.deepEqual(assertions.items.map((item) => item.id), ["A1", "A2"]);
  const answer = await quickAnswer(CASE, question, "es", MODEL, "gemini", 0, deps("answer", artifacts, audit), classified.items, "2026-11-11", true);
  assert.ok(!failed(answer));
  const synthesis = await quickSynthesize(CASE, question, "es", MODEL, [{ by: "gemini", answer: answer.text }], 0, deps("synthesis", artifacts, audit), "2026-11-11", classified.items[0]);
  assert.ok(!failed(synthesis));
  assert.equal(synthesis.majority, true);
  assert.match(synthesis.text, /SIMULACIÓN LOCAL/);
  assert.ok(!failed(await quickSynthesize(CASE, question, "es", MODEL, [{ by: "gemini", answer: answer.text }], 0, deps("synthesis", artifacts, audit))));

  const files = await artifacts.read(CASE);
  const read = (path: string) => JSON.parse(new TextDecoder().decode(files.get(path)));
  const classifyRequest = read("quick/classifier/classify-0/request.json");
  assert.equal(classifyRequest.modelId, "openai/gpt-6.1-terra");
  assert.match(JSON.stringify(classifyRequest.messages), /MATERIAL: ¿Cuántos/);
  assert.deepEqual(classifyRequest.output.properties.kind.enum, ["assertion", "question"]);
  assert.ok(classifyRequest.output.properties.items);
  const asked = read("quick/gemini/answer-0/request.json");
  assert.match(JSON.stringify(asked.messages), /QUESTION: ¿Cuántos.*Questions identified:.*P1/);
  assert.doesNotMatch(JSON.stringify(asked), /FACT CHECK/);
  assert.match(asked.system, /Do not rate the questions/);
  assert.match(JSON.stringify(read("quick/judge/claims/P1/synthesis-0/request.json").messages), /## Gemini.*ONLY to this question.*P1/);
  assert.ok(files.has("quick/judge/synthesis-0/request.json"), "a synthesis of the whole material has no question");
  assert.deepEqual(audit.map((a) => [a.id, a.body.seat]), [["quick:classifier:classify:0", "classifier"], ["quick:classifier:classify:1", "classifier"], ["quick:gemini:answer:0", "gemini"], ["quick:judge:claim:P1:synthesis:0", "judge"], ["quick:judge:synthesis:0", "judge"]]);
});
