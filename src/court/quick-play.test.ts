import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { createQuickMockModel } from "./mock.ts";
import { courtModel } from "./models.ts";
import { quickAnswer, quickIdentifyClaims, quickTiebreak, quickVote, type QuickPlayDependencies } from "./quick-play.ts";
import { failed, holdQuickSession } from "./quick.ts";
import { COUNSEL, project, type RecordedEvent, type Submission } from "../domain/court.ts";

const CASE = "quick-fixture";
const MODEL = courtModel("anthropic/claude-opus-5.5", "high");

function deps(step: "claims" | "answer" | "vote" | "tiebreak", artifacts = new MemoryArtifactStore(), audit: Array<{ id: string; body: Record<string, unknown> }> = []): QuickPlayDependencies {
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
  const request = new TextDecoder().decode(files.get("quick/claude/vote-0/request.json"));
  assert.match(request, /FACT CHECK:/);
  assert.match(request, /\(the submitted image\)/, "the image bytes stay out of request.json");
  assert.equal(JSON.parse(request).reasoning, "none");
  assert.deepEqual(audit.map((a) => a.id), ["quick:claude:answer:0", "quick:claude:vote:0", "quick:judge:tiebreak:0"]);
  assert.deepEqual(audit.map((a) => [a.body.kind, a.body.seat, a.body.phase, (a.body.data as { sessionId: string }).sessionId]), [
    ["model_step", "claude", "quick", "quick:claude"], ["model_step", "claude", "quick", "quick:claude"], ["model_step", "judge", "quick", "quick:judge"],
  ]);
});

test("a step run again reuses the result already written instead of calling the model again", async () => {
  const artifacts = new MemoryArtifactStore();
  const submission = { kind: "text" as const, text: "La pobreza bajó al 31,6 %." };
  const first = await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, deps("answer", artifacts));
  const again = deps("answer", artifacts);
  again.model = createQuickMockModel("vote");
  assert.deepEqual(await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, again), first);
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
      commit: async (batch) => void events.push(...batch),
    });
    const view = project(events);
    assert.equal(view.closed, true, submission.kind);
    assert.equal(view.claims.length, 2);
    assert.ok(view.claims.every((claim) => claim.judgment?.verdict === "no_verificable" && Object.keys(claim.votes).length === 4));
    assert.equal(view.contentJudgment?.verdict, "no_verificable");
    assert.equal((await artifacts.read(CASE)).size, 34);
  }
});
