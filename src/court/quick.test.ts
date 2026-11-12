import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNSEL, project, type Claim, type Counsel, type RecordedEvent, type Verdict } from "../domain/court.ts";
import { languageRule } from "../domain/language.ts";
import { classifiedItems, holdQuickSession, QUICK_VOTE_REQUEST, quickClaimsPrompt, quickClaimsSchema, quickClassificationSchema, quickClassifyPrompt, quickPrompt, quickSummaryPrompt, quickSynthesisPrompt, quickSynthesisSchema, quickTiebreakPrompt, quickVoteMessages, type QuickAnswer, type QuickBench, type QuickClaims, type QuickClassification, type QuickDecision, type QuickEntry, type QuickFailure, type QuickMajority, type QuickResponse, type QuickSynthesis, type QuickVote } from "./quick.ts";

const MODELS = { judge: "spacexai/grok-4.7", counsel: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" } };
const AT = "2026-11-07T12:00:00.000Z";

type Script = {
  identify?: Array<QuickClaims | QuickFailure>;
  claimVotes?: Record<string, Partial<Record<Counsel, Array<QuickVote | QuickFailure>>>>;
  answers?: Partial<Record<Counsel, Array<QuickAnswer | QuickFailure>>>;
  votes?: Partial<Record<Counsel, Array<QuickVote | QuickFailure>>>;
  tiebreak?: Array<QuickDecision | QuickFailure>;
};

function makeBench(script: Script) {
  const events: RecordedEvent[] = [];
  const calls: string[] = [];
  const retries: Array<{ by: Counsel; retry?: QuickFailure }> = [];
  const tiebreaks: QuickEntry[][] = [];
  const targets: Array<string | undefined> = [];
  const researchClaims: Array<readonly Claim[]> = [];
  const bench: QuickBench = {
    submission: { kind: "text", text: "Según el INDEC, la pobreza bajó al 31,6 % en el primer semestre de 2026.", check: "quick" },
    models: MODELS,
    identify: async (attempt) => {
      calls.push(`identify:${attempt}`);
      return script.identify?.[attempt] ?? { claims: CLAIMS, at: AT };
    },
    answer: async (by, attempt, claims) => {
      calls.push(`answer:${by}:${attempt}`);
      researchClaims.push(claims ?? []);
      return script.answers?.[by]?.[attempt] ?? { text: "Respuesta de " + by, sources: [{ url: "https://www.indec.gob.ar/" + by }], at: AT };
    },
    vote: async (by, answer, attempt, retry, claim) => {
      calls.push(`vote:${by}:${attempt}${claim ? ":" + claim.id : ""}`);
      retries.push({ by, retry });
      assert.equal(answer.text.startsWith("Respuesta"), true);
      return (claim ? script.claimVotes?.[claim.id]?.[by]?.[attempt] : script.votes?.[by]?.[attempt]) ?? { verdict: "falso", rationale: "Fundamento suficiente del voto.", at: AT };
    },
    tiebreak: async (entries, attempt, claim) => {
      calls.push(`tiebreak:${attempt}`);
      tiebreaks.push(entries);
      targets.push(claim?.id);
      return script.tiebreak?.[attempt] ?? { verdict: "enganoso", reasoning: "Las respuestas muestran una cifra fuera de contexto.", at: AT };
    },
    commit: async (batch) => void events.push(...batch),
  };
  return { bench, events, calls, retries, tiebreaks, targets, researchClaims };
}

const CLAIMS: Claim[] = [
  { id: "A1", quote: "La pobreza bajó.", text: "La pobreza bajó en el primer semestre de 2026." },
  { id: "A2", quote: "La inflación subió.", text: "La inflación subió en el primer semestre de 2026." },
];
const vote = (verdict: Verdict): QuickVote => ({ verdict, rationale: "Fundamento suficiente del voto.", at: AT });
const EXPERT_EVENTS = new Set(["claims_entered", "instruction_opened", "evidence_filed", "evidence_unified", "floor_granted", "statement", "objection", "vote", "judgment", "case_summary"]);

test("four agreeing votes give a consensus result without calling the moderator", async () => {
  const { bench, events, calls } = makeBench({});
  await holdQuickSession(bench);
  assert.deepEqual(events.map((e) => e.type), ["session_opened", ...COUNSEL.map(() => "quick_response"), ...COUNSEL.map(() => "content_vote"), "content_judgment", "session_closed"]);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.deepEqual(events.filter((e) => e.type === "quick_response").map((e) => e.type === "quick_response" && e.by), [...COUNSEL]);
  const judgment = events.find((e) => e.type === "content_judgment");
  assert.deepEqual(judgment && { ...judgment, seq: 0, at: "" }, { type: "content_judgment", verdict: "falso", method: "consensus", reasoning: "", seq: 0, at: "" });
  assert.ok(!calls.some((c) => c.startsWith("tiebreak")));
  assert.ok(!events.some((e) => EXPERT_EVENTS.has(e.type)), "no Expert turn is played");
  const response = events.find((e) => e.type === "quick_response");
  assert.deepEqual(response?.type === "quick_response" && response.sources, [{ url: "https://www.indec.gob.ar/grok" }]);
});

test("the moderator summarizes only the supporting votes, keeping claim and content majorities separate", async () => {
  const { bench, events } = makeBench({
    claimVotes: { A1: { grok: [vote("verdadero")] }, A2: { grok: [vote("verdadero")], gemini: [vote("verdadero")] } },
    votes: { chatgpt: [vote("enganoso")] },
  });
  bench.submission.identifyClaims = true;
  let received: QuickMajority[] = [];
  bench.summarize = async (majorities) => { received = majorities; return { text: "  La mayoría cita datos distintos para cada resultado.  ", at: AT }; };
  await holdQuickSession(bench);
  assert.deepEqual(received.map((m) => [m.claim?.id, m.verdict, m.votes.map((v) => v.by)]), [
    ["A1", "falso", ["gemini", "claude", "chatgpt"]],
    [undefined, "falso", ["grok", "gemini", "claude"]],
  ]);
  assert.equal(project(events).claims[1].judgment?.method, "judge", "a tie is not represented as a majority");
  assert.equal(project(events).summary, "La mayoría cita datos distintos para cada resultado.");
  assert.deepEqual(events.slice(-2).map((e) => e.type), ["case_summary", "session_closed"]);
  assert.equal(events.at(-2)?.at, AT);
});

test("a majority summary retries empty or failed output, and fails the case rather than inventing one", async () => {
  const { bench, events } = makeBench({});
  const attempts: number[] = [];
  bench.summarize = async (_majorities, attempt) => { attempts.push(attempt); return attempt ? { text: "Resumen suficiente.", at: AT } : { text: "  ", at: AT }; };
  await holdQuickSession(bench);
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(project(events).summary, "Resumen suficiente.");
  const broken = makeBench({});
  broken.bench.summarize = async () => ({ error: "timeout" });
  await assert.rejects(holdQuickSession(broken.bench), /no resumió/);
  assert.ok(!broken.events.some((e) => e.type === "session_closed" || e.type === "case_summary"));
});

test("a tie without any majority does not request a majority summary", async () => {
  const { bench, events } = makeBench({ votes: { grok: [vote("verdadero")], gemini: [vote("verdadero")] } });
  bench.summarize = async () => { throw new Error("unexpected summary"); };
  await holdQuickSession(bench);
  assert.equal(project(events).contentJudgment?.method, "judge");
  assert.equal(project(events).summary, undefined);
});

test("the majority summary prompt is bounded to the supplied votes and language", () => {
  const majority: QuickMajority = { verdict: "falso", votes: [{ by: "grok", rationale: "El dato no coincide." }] };
  const prompt = quickSummaryPrompt("es", [majority]);
  assert.ok(prompt.system.startsWith(languageRule("es")));
  assert.match(prompt.system, /do not combine their verdicts/i);
  assert.match(prompt.system, /Do not research/);
  assert.match(String(prompt.messages[0].content), /El dato no coincide/);
});

test("a 2-2 split asks the moderator, who receives only the answers and votes", async () => {
  const { bench, events, tiebreaks } = makeBench({ votes: { grok: [vote("verdadero")], gemini: [vote("verdadero")] } });
  await holdQuickSession(bench);
  assert.equal(tiebreaks.length, 1);
  assert.deepEqual(tiebreaks[0], COUNSEL.map((by) => ({ by, answer: "Respuesta de " + by, vote: { verdict: by === "grok" || by === "gemini" ? "verdadero" : "falso", rationale: "Fundamento suficiente del voto." } })));
  const judgment = events.find((e) => e.type === "content_judgment");
  assert.equal(judgment?.type === "content_judgment" && judgment.method, "judge");
  assert.equal(judgment?.type === "content_judgment" && judgment.verdict, "enganoso");
  assert.equal(events.at(-1)?.type, "session_closed");
});

test("a moderator that fails twice fails the case", async () => {
  const { bench } = makeBench({ votes: { grok: [vote("verdadero")], gemini: [vote("verdadero")] }, tiebreak: [{ error: "timeout" }, { error: "timeout" }] });
  await assert.rejects(holdQuickSession(bench), /no desempató/);
});

test("a vote that does not parse, or is too short, is asked again once with the error", async () => {
  const { bench, events, retries } = makeBench({ votes: {
    grok: [{ error: "No object generated", text: "falso porque sí" }],
    gemini: [{ verdict: "falso", rationale: "corto", at: AT, text: "{\"verdict\":\"falso\",\"rationale\":\"corto\"}" }],
  } });
  await holdQuickSession(bench);
  assert.deepEqual(retries.filter((r) => r.by === "grok").map((r) => r.retry), [undefined, { error: "No object generated", text: "falso porque sí" }]);
  assert.deepEqual(retries.filter((r) => r.by === "gemini").map((r) => r.retry?.error), [undefined, "the rationale is too short"]);
  assert.equal(events.filter((e) => e.type === "content_vote").length, 4);
});

test("an answer that fails is tried once more; a seat whose answer fails twice is absent", async () => {
  const { bench, events, calls } = makeBench({ answers: { gemini: [{ error: "timeout" }], claude: [{ error: "timeout" }, { error: "gateway error" }] } });
  await holdQuickSession(bench);
  assert.deepEqual(calls.filter((c) => c.includes("gemini")), ["answer:gemini:0", "answer:gemini:1", "vote:gemini:0"]);
  assert.deepEqual(calls.filter((c) => c.includes("claude")), ["answer:claude:0", "answer:claude:1"]);
  assert.deepEqual(events.filter((e) => e.type === "quick_response").map((e) => e.type === "quick_response" && e.by), ["grok", "gemini", "chatgpt"]);
  assert.deepEqual(events.filter((e) => e.type === "absence").map((e) => e.type === "absence" && [e.by, e.stage]), [["claude", "content"]]);
  assert.equal(events.find((e) => e.type === "content_judgment")?.type === "content_judgment" && events.find((e) => e.type === "content_judgment")!.method, "consensus");
});

test("fewer than three votes fail the case, after recording the answers, votes and absences", async () => {
  const { bench, events, calls } = makeBench({
    answers: { claude: [{ error: "timeout" }, { error: "gateway error" }] },
    votes: { chatgpt: [{ error: "bad" }, { error: "bad again" }] },
  });
  await assert.rejects(holdQuickSession(bench), /Menos de tres analistas votaron.*Claude: gateway error.*ChatGPT: bad again/);
  assert.deepEqual(events.filter((e) => e.type === "quick_response").map((e) => e.type === "quick_response" && e.by), ["grok", "gemini", "chatgpt"], "a seat without a vote keeps its answer");
  assert.deepEqual(events.filter((e) => e.type === "absence").map((e) => e.type === "absence" && e.by), ["claude", "chatgpt"]);
  assert.equal(events.filter((e) => e.type === "content_vote").length, 2);
  assert.ok(!events.some((e) => e.type === "session_closed" || e.type === "content_judgment"));
  assert.ok(!calls.some((c) => c.startsWith("tiebreak")));
});

test("three votes without a majority go to the moderator", async () => {
  const { bench, events, tiebreaks } = makeBench({
    answers: { claude: [{ error: "timeout" }, { error: "timeout" }] },
    votes: { grok: [vote("verdadero")], gemini: [vote("no_verificable")] },
  });
  await holdQuickSession(bench);
  assert.equal(tiebreaks[0]!.find((e) => e.by === "claude")?.answer, undefined);
  assert.equal(events.find((e) => e.type === "content_judgment")?.type === "content_judgment" && events.find((e) => e.type === "content_judgment")!.seq, events.length - 1);
});

test("the prompt is FACT CHECK: and the content, with the language rule as the system prompt", () => {
  const text = quickPrompt({ kind: "text", text: "La pobreza bajó al 31,6 %." }, "es");
  assert.equal(text.system, languageRule("es"));
  assert.deepEqual(text.messages, [{ role: "user", content: "FACT CHECK: La pobreza bajó al 31,6 %." }]);

  const link = quickPrompt({ kind: "link", url: "https://example.com/nota", note: "¿Es cierto el dato del título?" }, "en");
  assert.equal(link.system, languageRule("en"));
  assert.deepEqual(link.messages, [{ role: "user", content: "FACT CHECK: https://example.com/nota\n¿Es cierto el dato del título?" }]);
  assert.deepEqual(quickPrompt({ kind: "link", url: "https://example.com/nota" }, "es").messages[0]!.content, "FACT CHECK: https://example.com/nota");

  const bytes = new Uint8Array([1, 2, 3]);
  const image = quickPrompt({ kind: "image", mimeType: "image/png", note: "La cifra del gráfico" }, "es", { bytes, mimeType: "image/png" });
  assert.deepEqual(image.messages, [{ role: "user", content: [
    { type: "text", text: "FACT CHECK:" },
    { type: "file", data: bytes, mediaType: "image/png" },
    { type: "text", text: "La cifra del gráfico" },
  ] }]);
  assert.throws(() => quickPrompt({ kind: "image", mimeType: "image/png" }, "es"), /needs the image/);
});

test("the vote continues the answer's conversation, and a retry shows the previous output and its error", () => {
  const prompt = quickPrompt({ kind: "text", text: "Dato a chequear." }, "es").messages;
  assert.deepEqual(quickVoteMessages(prompt, "Es falso."), [...prompt, { role: "assistant", content: "Es falso." }, { role: "user", content: QUICK_VOTE_REQUEST }]);
  const retried = quickVoteMessages(prompt, "Es falso.", { error: "No object generated", text: "falso" });
  assert.deepEqual(retried.slice(-2).map((m) => m.role), ["assistant", "user"]);
  assert.match(String(retried.at(-1)!.content), /No object generated/);
});

test("the tie-break prompt holds the content, each answer and vote, and no tools", () => {
  const { system, messages } = quickTiebreakPrompt({ kind: "text", text: "Dato a chequear." }, "es", [
    { by: "grok", answer: "Es falso.", vote: { verdict: "falso", rationale: "Otro dato." } },
    { by: "claude" },
  ]);
  assert.ok(system.startsWith(languageRule("es")));
  assert.match(system, /do not research/);
  const text = (messages[0]!.content as Array<{ type: string; text?: string }>).map((part) => part.text).join("\n");
  assert.match(text, /FACT CHECK: Dato a chequear\./);
  assert.match(text, /## Grok\nAnswer:\nEs falso\.\nVote: falso\. Otro dato\./);
  assert.match(text, /## Claude\nNo answer\.\nNo vote\./);
});

test("optional claims are identified first, researched once per analyst, and voted separately from the content", async () => {
  const { bench, events, calls, researchClaims, targets } = makeBench({ claimVotes: { A1: Object.fromEntries(COUNSEL.map((by) => [by, [vote("verdadero")]])) } });
  bench.submission.identifyClaims = true;
  await holdQuickSession(bench);
  assert.equal(calls[0], "identify:0");
  assert.equal(calls.filter((c) => c.startsWith("answer:")).length, 4);
  assert.deepEqual(researchClaims, COUNSEL.map(() => CLAIMS));
  assert.equal(calls.filter((c) => c.startsWith("vote:")).length, 12);
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ["session_opened", "claims_entered"]);
  assert.equal(events.filter((e) => e.type === "vote").length, 8);
  assert.equal(events.filter((e) => e.type === "content_vote").length, 4);
  const view = project(events);
  assert.deepEqual(view.claims.map((c) => [c.id, c.judgment?.verdict]), [["A1", "verdadero"], ["A2", "falso"]]);
  assert.equal(view.contentJudgment?.verdict, "falso");
  assert.equal(view.closed, true);
  assert.deepEqual(targets, []);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.ok(!events.some((e) => ["instruction_opened", "evidence_filed", "statement", "case_summary"].includes(e.type)));
});

test("claim and content tie-breaks receive only their own votes, without mixing outcomes", async () => {
  const { bench, events, targets, tiebreaks } = makeBench({
    claimVotes: { A1: { grok: [vote("verdadero")], gemini: [vote("verdadero")] } },
    votes: { grok: [vote("no_verificable")], claude: [vote("no_verificable")] },
  });
  bench.submission.identifyClaims = true;
  await holdQuickSession(bench);
  assert.deepEqual(targets, ["A1", undefined]);
  assert.deepEqual(tiebreaks[0].map((e) => e.vote?.verdict), ["verdadero", "verdadero", "falso", "falso"]);
  assert.deepEqual(tiebreaks[1].map((e) => e.vote?.verdict), ["no_verificable", "falso", "no_verificable", "falso"]);
  assert.deepEqual(project(events).claims.map((c) => c.judgment?.method), ["judge", "consensus"]);
  assert.equal(project(events).contentJudgment?.method, "judge");
});

test("claim identification retries once and fails before any analyst is called if both attempts fail", async () => {
  const retried = makeBench({ identify: [{ error: "timeout" }] });
  retried.bench.submission.identifyClaims = true;
  await holdQuickSession(retried.bench);
  assert.deepEqual(retried.calls.slice(0, 2), ["identify:0", "identify:1"]);
  const broken = makeBench({ identify: [{ error: "timeout" }, { error: "bad output" }] });
  broken.bench.submission.identifyClaims = true;
  await assert.rejects(holdQuickSession(broken.bench), /no identificó/);
  assert.deepEqual(broken.calls, ["identify:0", "identify:1"]);
  assert.deepEqual(broken.events.map((e) => e.type), ["session_opened"]);
});

test("a bad claim vote retries independently and an absent claim voter still votes on the whole", async () => {
  const { bench, events, calls } = makeBench({ claimVotes: { A1: {
    grok: [{ verdict: "falso", rationale: "corto", at: AT }],
    claude: [{ error: "bad output" }, { error: "bad again" }],
  } } });
  bench.submission.identifyClaims = true;
  await holdQuickSession(bench);
  assert.ok(calls.includes("vote:grok:1:A1"));
  assert.ok(calls.includes("vote:claude:0:A2"));
  assert.ok(calls.includes("vote:claude:0"));
  assert.equal(project(events).claims[0].votes.claude, undefined);
  assert.equal(Object.keys(project(events).contentVotes).length, 4);
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "closing"));
});

test("a claim with fewer than three votes fails even when the content has four votes", async () => {
  const { bench, events, targets } = makeBench({ claimVotes: { A1: {
    grok: [{ error: "A1 failed" }, { error: "A1 failed" }], gemini: [{ error: "A1 failed" }, { error: "A1 failed" }],
  }, A2: { grok: [{ error: "A2 failed" }, { error: "A2 failed" }] } } });
  bench.submission.identifyClaims = true;
  await assert.rejects(holdQuickSession(bench), /Menos de tres.*para A1.*Grok: A1 failed.*Gemini: A1 failed/);
  assert.equal(events.filter((e) => e.type === "content_vote").length, 4);
  assert.equal(project(events).closed, false);
  assert.deepEqual(targets, []);
});

test("no factual claims keeps the global quick check, and the option off never calls identification", async () => {
  const empty = makeBench({ identify: [{ claims: [], at: AT }] });
  empty.bench.submission.identifyClaims = true;
  await holdQuickSession(empty.bench);
  assert.equal(empty.events.filter((e) => e.type === "vote").length, 0);
  assert.equal(project(empty.events).contentJudgment?.verdict, "falso");
  const off = makeBench({});
  off.bench.submission.identifyClaims = false;
  await holdQuickSession(off.bench);
  assert.ok(!off.calls.some((c) => c.startsWith("identify:")));
});

test("claims prompts cover independent findings, targeted votes and tie-breaks, and bounded extraction", () => {
  const submission = { kind: "text" as const, text: "La pobreza bajó. La inflación subió." };
  const intake = quickClaimsPrompt(submission, "en");
  assert.ok(intake.system.startsWith(languageRule("en")));
  assert.match(intake.system, /without deciding whether they are true/);
  assert.match(intake.system, /do not research beyond/);
  const prompt = quickPrompt(submission, "es", undefined, CLAIMS);
  assert.match(prompt.system, /each.*claims independently/);
  assert.match(String(prompt.messages.at(-1)?.content), /A1.*A2/);
  const messages = quickVoteMessages(prompt.messages, "Respuesta", undefined, CLAIMS[0]);
  assert.match(String(messages.at(-1)?.content), /ONLY.*claim.*A1/s);
  const retried = quickVoteMessages(prompt.messages, "Respuesta", { error: "too short" }, CLAIMS[0]);
  assert.match(String(retried.at(-1)?.content), /ONLY claim A1/);
  const tiebreak = quickTiebreakPrompt(submission, "es", [], undefined, CLAIMS[1]);
  assert.match(tiebreak.system, /ONLY for that claim/);
  assert.match(JSON.stringify(tiebreak.messages), /ONLY for this claim.*A2/);
  assert.equal(quickClaimsSchema.safeParse({ claims: [] }).success, true);
  assert.equal(quickClaimsSchema.safeParse({ claims: Array(6).fill(CLAIMS[0]).map(({ id: _id, ...claim }) => claim) }).success, false);
});

// A bench that classifies the material first, as workflows started with classifyContent do.
const QUESTIONS: Claim[] = [
  { id: "P1", quote: "¿Cuántos habitantes tiene la Argentina?", text: "¿Cuántos habitantes tiene la Argentina según el último censo?" },
  { id: "P2", quote: "¿Y Uruguay?", text: "¿Cuántos habitantes tiene Uruguay según el último censo?" },
];
function classifyingBench(kinds: Array<QuickClassification | QuickFailure>, synthesis: Array<QuickSynthesis | QuickFailure> = [], answers: Script["answers"] = {}) {
  const made = makeBench({ answers });
  const asked: Array<{ questions: boolean; items: readonly Claim[] }> = [];
  const syntheses: Array<{ responses: QuickResponse[]; question?: string }> = [];
  const answer = made.bench.answer;
  made.bench.submission = { kind: "text", text: "¿Cuántos habitantes tiene la Argentina? ¿Y Uruguay?", check: "quick", identifyClaims: true };
  made.bench.classify = async (attempt) => { made.calls.push("classify:" + attempt); return kinds[attempt] ?? { error: "no classification" }; };
  made.bench.answer = async (by, attempt, claims, questions) => { asked.push({ questions: questions === true, items: claims ?? [] }); return answer(by, attempt, claims); };
  let calls = 0;
  made.bench.synthesize = async (responses, attempt, question) => {
    made.calls.push("synthesize:" + (question?.id ?? "-") + ":" + attempt);
    syntheses.push({ responses, ...(question ? { question: question.id } : {}) });
    return synthesis[calls++] ?? { text: "Síntesis de " + (question?.id ?? "todo") + ".", majority: true, at: AT };
  };
  return { ...made, asked, syntheses };
}

test("questions are each answered by the four analysts and synthesized by the moderator, with no claims, votes or rating", async () => {
  const { bench, events, calls, asked, syntheses } = classifyingBench([{ kind: "question", items: QUESTIONS, at: AT }]);
  await holdQuickSession(bench);
  assert.deepEqual(events.map((e) => e.type), ["session_opened", "content_classified", ...COUNSEL.map(() => "quick_response"), "answer_synthesis", "answer_synthesis", "session_closed"]);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.ok(!calls.some((call) => call.startsWith("identify") || call.startsWith("vote") || call.startsWith("tiebreak")), "the old claim identification does not run after a classification");
  assert.deepEqual(asked, COUNSEL.map(() => ({ questions: true, items: QUESTIONS })));
  const responses = COUNSEL.map((by) => ({ by, answer: "Respuesta de " + by }));
  assert.deepEqual(syntheses, [{ responses, question: "P1" }, { responses, question: "P2" }]);
  assert.deepEqual(events.filter((e) => e.type === "answer_synthesis").map((e) => e.type === "answer_synthesis" && [e.questionId, e.text, e.majority]), [["P1", "Síntesis de P1.", true], ["P2", "Síntesis de P2.", true]]);
  const view = project(events);
  assert.equal(view.contentKind, "question");
  assert.deepEqual(view.questions.map((q) => [q.id, q.synthesis]), [["P1", { text: "Síntesis de P1.", majority: true }], ["P2", { text: "Síntesis de P2.", majority: true }]]);
  assert.deepEqual(view.claims, []);
  assert.equal(view.contentJudgment, undefined);
  assert.equal(view.contentVotingRecorded, false);
});

test("without a majority on a question its positions are synthesized as such, after a failed attempt", async () => {
  const { bench, events, calls } = classifyingBench([{ kind: "question", items: QUESTIONS, at: AT }], [{ error: "no object" }, { text: " Grok y Gemini sostienen una cifra; Claude y ChatGPT, otra. ", majority: false, at: AT }]);
  await holdQuickSession(bench);
  assert.deepEqual(calls.filter((call) => call.startsWith("synthesize")), ["synthesize:P1:0", "synthesize:P1:1", "synthesize:P2:0"]);
  const first = events.find((e) => e.type === "answer_synthesis");
  assert.deepEqual(first?.type === "answer_synthesis" && [first.questionId, first.text, first.majority], ["P1", "Grok y Gemini sostienen una cifra; Claude y ChatGPT, otra.", false]);
});

test("questions without identified items get one synthesis of the whole material", async () => {
  const { bench, events, syntheses } = classifyingBench([{ kind: "question", items: [], at: AT }]);
  await holdQuickSession(bench);
  assert.deepEqual(syntheses.map((s) => s.question), [undefined]);
  const synthesis = events.find((e) => e.type === "answer_synthesis");
  assert.ok(synthesis?.type === "answer_synthesis" && !("questionId" in synthesis));
  assert.deepEqual(project(events).synthesis, { text: "Síntesis de todo.", majority: true });
});

test("questions with fewer than three answers record the absences and fail without a synthesis", async () => {
  const failure = { error: "timeout" };
  const { bench, events, calls } = classifyingBench([{ kind: "question", items: QUESTIONS, at: AT }], [], { claude: [failure, failure], chatgpt: [failure, failure] });
  await assert.rejects(holdQuickSession(bench), /Menos de tres analistas respondieron.*Claude: timeout.*ChatGPT: timeout/);
  assert.deepEqual(events.filter((e) => e.type === "absence").map((e) => e.type === "absence" && [e.by, e.stage]), [["claude", "answer"], ["chatgpt", "answer"]]);
  assert.ok(!calls.some((call) => call.startsWith("synthesize")));
  assert.ok(!events.some((e) => e.type === "answer_synthesis" || e.type === "session_closed"));
});

test("a failed synthesis of a question fails the case without inventing one", async () => {
  const { bench, events } = classifyingBench([{ kind: "question", items: QUESTIONS, at: AT }], [{ error: "a" }, { text: "  ", majority: true, at: AT }]);
  await assert.rejects(holdQuickSession(bench), /no sintetizó las respuestas de la consulta para P1/);
  assert.ok(!events.some((e) => e.type === "answer_synthesis" || e.type === "session_closed"));
});

test("assertion items are the claims: each one and the whole are voted, with their tie-breaks, after a retried classification", async () => {
  const { bench, events, asked, calls } = classifyingBench([{ error: "no object" }, { kind: "assertion", items: CLAIMS, at: AT }]);
  await holdQuickSession(bench);
  assert.deepEqual(events.slice(0, 2).map((e) => e.type), ["session_opened", "content_classified"]);
  assert.ok(!events.some((e) => e.type === "claims_entered" || e.type === "answer_synthesis"));
  assert.ok(!calls.some((call) => call.startsWith("identify") || call.startsWith("synthesize")));
  assert.deepEqual(asked, COUNSEL.map(() => ({ questions: false, items: CLAIMS })));
  assert.deepEqual(events.filter((e) => e.type === "vote").map((e) => e.type === "vote" && e.claimId), COUNSEL.flatMap(() => ["A1", "A2"]));
  assert.deepEqual(events.filter((e) => e.type === "judgment").map((e) => e.type === "judgment" && e.claimId), ["A1", "A2"]);
  assert.ok(events.some((e) => e.type === "content_judgment"));
  const view = project(events);
  assert.equal(view.contentKind, "assertion");
  assert.deepEqual(view.claims.map((c) => [c.id, c.judgment?.verdict]), [["A1", "falso"], ["A2", "falso"]]);
});

test("material the moderator cannot classify is checked as a whole, without items or a classification event", async () => {
  const { bench, events, calls, asked } = classifyingBench([]);
  await holdQuickSession(bench);
  assert.deepEqual(calls.filter((call) => call.startsWith("classify")), ["classify:0", "classify:1"]);
  assert.ok(!calls.some((call) => call.startsWith("identify")), "the old option does not apply to a classified run");
  assert.ok(!events.some((e) => e.type === "content_classified" || e.type === "claims_entered" || e.type === "vote"));
  assert.deepEqual(asked, COUNSEL.map(() => ({ questions: false, items: [] })));
  assert.ok(events.some((e) => e.type === "content_judgment"));
});

test("the classification, the answers to questions and their syntheses have their own prompts", () => {
  const submission = { kind: "text" as const, text: "¿Quién ganó el Mundial 2022?", check: "quick" as const };
  const classify = quickClassifyPrompt(submission, "es", undefined, "2026-11-11");
  assert.match(classify.system, /asserts facts to check or asks questions to answer, and identify each assertion or question/);
  assert.match(classify.system, /2026-11-11/);
  assert.equal(classify.messages[0]?.content, "MATERIAL: ¿Quién ganó el Mundial 2022?");
  assert.equal(quickClassificationSchema.safeParse({ kind: "question", items: [{ quote: "¿Quién ganó?", text: "¿Quién ganó el Mundial 2022?" }] }).success, true);
  assert.equal(quickClassificationSchema.safeParse({ kind: "questions", items: [] }).success, false);
  assert.equal(quickClassificationSchema.safeParse({ kind: "assertion" }).success, false, "items are required");
  assert.equal(quickClassificationSchema.safeParse({ kind: "assertion", items: Array(6).fill({ quote: "", text: "Una afirmación verificable." }) }).success, false);
  assert.match(String(quickClassificationSchema.shape.kind.description), /Is it true that/);
  assert.deepEqual(classifiedItems("question", [{ quote: "a", text: "b" }, { quote: "c", text: "d" }]).map((c) => c.id), ["P1", "P2"]);
  assert.deepEqual(classifiedItems("assertion", [{ quote: "a", text: "b" }]), [{ id: "A1", quote: "a", text: "b" }]);
  const answer = quickPrompt(submission, "es", undefined, QUESTIONS, undefined, true);
  assert.equal(answer.messages[0]?.content, "QUESTION: ¿Quién ganó el Mundial 2022?");
  assert.match(String(answer.messages[1]?.content), /Questions identified:.*P1.*P2/s);
  assert.match(answer.system, /Answer each of them/);
  assert.match(answer.system, /separately, by its identifier/);
  assert.match(answer.system, /Do not rate the questions/);
  assert.doesNotMatch(JSON.stringify(answer), /FACT CHECK/);
  const synthesis = quickSynthesisPrompt(submission, "es", [{ by: "grok", answer: "Argentina." }, { by: "claude", answer: "La Argentina." }], undefined, undefined, QUESTIONS[1]);
  assert.match(synthesis.system, /at least three analysts/);
  assert.match(synthesis.system, /Do not rate/);
  assert.match(synthesis.system, /ONLY the answers to the question/);
  assert.match(JSON.stringify(synthesis.messages), /## Grok\\nArgentina\..*## Claude\\nLa Argentina\..*ONLY to this question.*P2/);
  assert.doesNotMatch(quickSynthesisPrompt(submission, "es", []).system, /ONLY/);
  assert.equal(quickSynthesisSchema.safeParse({ majority: true, synthesis: "Texto" }).success, true);
  assert.equal(quickSynthesisSchema.safeParse({ majority: true, synthesis: "Texto", verdict: "falso" }).success, false);
});
