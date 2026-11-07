import { test } from "node:test";
import assert from "node:assert/strict";
import { project, type Counsel, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { holdSession, type Bench } from "./procedure.ts";
import { conductTurn, type Converse, type Docket, type SeatId } from "./turns.ts";
import { toAiTools } from "./toolset.ts";
import { translateFiledEvidence } from "../evidence/translate.ts";

type Call = [tool: string, args: Record<string, unknown>];
type Script = (prompt: string, tools: string[]) => Call[];
type Result = { tool: string; isError: boolean; text: string };

const MODELS = { judge: "grok-4.7", counsel: { grok: "grok-4.7", gemini: "gemini-4-argon", claude: "claude-opus-5-5", chatgpt: "gpt-5.5" } };
const DOCKET: Docket = { submission: { kind: "text", text: "CABA tiene más habitantes que Córdoba y la inflación de 2025 fue de un dígito." }, today: "27 de octubre de 2026" };

function makeBench(scripts: Record<SeatId, Script>, docket: Docket = DOCKET) {
  const results: Result[] = [];
  const prompts: Record<SeatId, string[]> = { judge: [], grok: [], gemini: [], claude: [], chatgpt: [] };
  const events: RecordedEvent[] = [];
  const converse: Converse = async ({ seat, prompt, tools }) => {
    prompts[seat].push(prompt);
    const sdk = toAiTools(tools);
    for (const [name, args] of scripts[seat](prompt, Object.keys(tools))) {
      const out = await sdk[name].execute(args);
      const isError = typeof out === "object" && "error" in out;
      results.push({ tool: name, isError, text: typeof out === "string" ? out : out.error });
    }
  };
  const bench: Bench = {
    submission: docket.submission,
    models: MODELS,
    play: (spec, record, attempt) => conductTurn(docket, spec, record, attempt, converse),
    commit: async (batch) => void events.push(...batch),
  };
  return { bench, results, prompts, events };
}

const lastId = (prompt: string, prefix: string) => [...prompt.matchAll(new RegExp("\\[(" + prefix + "\\d+)\\]", "g"))].at(-1)?.[1];

function counsel(name: Counsel, votes: Record<string, string> | null): Script {
  return (prompt, tools) => {
    if (tools.includes("vote_content")) return [["vote_content", { verdict: null, rationale: "Las afirmaciones no forman una narrativa común." }]];
    if (tools.includes("review_sources")) return [["review_sources", { votes: [{ sourceId: "E1", veto: false, reason: "Documento oficial con metodología publicada." }] }]];
    if (tools.includes("object")) return name === "claude" && /intervention I1 by/.test(prompt) ? [["object", { grounds: "La cifra citada no aparece en la fuente." }]] : [["pass", {}]];
    if (tools.includes("reply_objection")) return [["reply_objection", { text: "La cifra está en la tabla 3 del informe." }]];
    if (tools.includes("cast_votes")) {
      const statement: Call = ["make_statement", { text: "Mantengo mi evaluación según la evidencia.", evidenceIds: [] }];
      if (!votes) return [statement];
      return [statement, ["cast_votes", { votes: Object.entries(votes).map(([claimId, verdict]) => ({ claimId, verdict, rationale: "Según la evidencia del registro." })) }]];
    }
    if (tools.includes("make_statement")) {
      const p = lastId(prompt, "E") ?? "E1";
      if (name === "gemini" && /your opening statement/.test(prompt)) {
        return [
          ["make_statement", { text: "Cito una evidencia que no está en el registro.", evidenceIds: ["P99"] }],
          ["make_statement", { text: "Cito la evidencia correcta del registro.", evidenceIds: [p] }],
        ];
      }
      return [["make_statement", { text: "Mi evaluación de las afirmaciones.", evidenceIds: [p] }]];
    }
    if (tools.includes("file_evidence") && name !== "claude")
      return [
        ["file_evidence", { claimId: "A1", title: "INDEC, Censo 2022", url: "https://www.indec.gob.ar/", excerpt: "Córdoba: 3.840.905 habitantes.", stance: "opposes" }],
        ["finish_instruction", { searches: ["A1", "A2"].map((claimId) => ({ claimId, supporting: "Busqué datos que respaldaran la afirmación; no encontré respaldo verificable.", opposing: "Busqué cifras oficiales que contradijeran la afirmación." })) }],
      ];
    return [];
  };
}

const judgeScript: Script = (prompt, tools) => {
  if (tools.includes("unify_evidence")) {
    const evidenceIds = [...new Set([...prompt.matchAll(/\[(P\d+)\]/g)].map((m) => m[1]))];
    return [["unify_evidence", { groups: evidenceIds.length ? [{ evidenceIds }] : [] }]];
  }
  if (tools.includes("enter_claims"))
    return [["enter_claims", { claims: [{ quote: "CABA tiene más habitantes", text: "La CABA tiene más habitantes que Córdoba." }, { quote: "", text: "La inflación de 2025 fue de un dígito." }] }]];
  if (tools.includes("rule")) return [["rule", { sustained: true, reason: "La evidencia no contiene la cifra." }]];
  if (tools.includes("decide")) return [["decide", { decisions: [{ claimId: "A2", verdict: "verdadero", reasoning: "La evidencia P2 del registro es la más directa." }] }]];
  if (tools.includes("summarize_case")) return [["summarize_case", { text: "Los analistas debatieron el alcance de las cifras y discreparon sobre la segunda afirmación." }]];
  return [];
};

test("collection progress is committed incrementally before evidence and source review", async () => {
  const { bench, events } = makeBench({ judge: judgeScript, grok: counsel("grok", {}), gemini: counsel("gemini", {}), claude: counsel("claude", {}), chatgpt: counsel("chatgpt", {}) });
  bench.collect = async (record, progress) => {
    const snapshotLength = record.length;
    await progress({ type: "source_collection_started", total: 1, batches: 1 });
    assert.equal(events.at(-1)?.type, "source_collection_started");
    await progress({ type: "source_batch_completed", batch: 1, batches: 1, count: 1, completed: 1, total: 1, failed: 0 });
    assert.equal(events.at(-1)?.type, "source_batch_completed");
    assert.equal(record.length, snapshotLength, "progress does not mutate the collector's input");
    return [{ type: "evidence_unified", sources: [] }];
  };
  const play = bench.play;
  bench.play = async (spec, record, attempt) => {
    if (spec.kind === "statement") throw new Error("stop after collection");
    return play(spec, record, attempt);
  };
  await assert.rejects(holdSession(bench), /stop after collection/);
  const start = events.findIndex((e) => e.type === "source_collection_started");
  assert.equal(events[start + 1]?.type, "source_batch_completed");
  assert.equal(events[start + 2]?.type, "evidence_unified");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
});

test("settlement is committed after source decisions and before instruction closes", async () => {
  const { bench, events } = makeBench({ judge: judgeScript, grok: counsel("grok", { A1: "verdadero", A2: "verdadero" }), gemini: counsel("gemini", { A1: "verdadero", A2: "verdadero" }), claude: counsel("claude", { A1: "verdadero", A2: "verdadero" }), chatgpt: counsel("chatgpt", { A1: "verdadero", A2: "verdadero" }) });
  bench.settle = async (record) => {
    assert.ok(record.some((event) => event.type === "source_decided"));
    assert.ok(events.some((event) => event.type === "source_decided"), "source decisions must already be durable");
    assert.ok(!record.some((event) => event.type === "instruction_closed"));
    return { type: "evidence_settled", schemaVersion: 2, manifestHash: "a".repeat(64) };
  };
  await holdSession(bench);
  const settled = events.findIndex((event) => event.type === "evidence_settled");
  assert.ok(settled > events.findIndex((event) => event.type === "source_decided"));
  assert.equal(events[settled + 1]?.type, "instruction_closed");
});

test("settlement failure blocks closure and every debate turn", async () => {
  const { bench, events } = makeBench({ judge: judgeScript, grok: counsel("grok", {}), gemini: counsel("gemini", {}), claude: counsel("claude", {}), chatgpt: counsel("chatgpt", {}) });
  bench.settle = async () => { throw new Error("Required admitted source missing"); };
  await assert.rejects(holdSession(bench), /Required admitted source missing/);
  assert.ok(!events.some((event) => event.type === "instruction_closed" || event.type === "floor_granted"));
});

test("a failed seat waits for the other seats of its round, whose sandboxes cleanup would delete", async () => {
  const { bench, events } = makeBench({ judge: judgeScript, grok: counsel("grok", {}), gemini: counsel("gemini", {}), claude: counsel("claude", {}), chatgpt: counsel("chatgpt", {}) });
  const play = bench.play;
  const finished: string[] = [];
  bench.play = async (spec, record, attempt) => {
    if (spec.kind !== "instruction") return play(spec, record, attempt);
    if (spec.counsel === "grok") throw new Error("Source translation operation is failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    finished.push(spec.counsel);
    return { events: [], done: true };
  };
  await assert.rejects(holdSession(bench), /Source translation operation is failed/);
  assert.deepEqual(finished.sort(), ["chatgpt", "claude", "gemini"], "the session fails only once every seat settled");
  assert.ok(!events.some((event) => event.type === "absence"), "a failed round records none of its outcomes");
});

test("translated contributions reach unification and source review, including after an incomplete instruction attempt", async () => {
  let instructionAttempts = 0;
  const grok: Script = (prompt, tools) => {
    if (tools.includes("file_evidence")) {
      instructionAttempts++;
      if (instructionAttempts === 1) return [["file_evidence", { claimId: "A1", title: "Relatório oficial", url: "https://www.indec.gob.ar/", excerpt: "O investigado não entregou os documentos.", stance: "opposes" }]];
      return [["finish_instruction", { searches: ["A1", "A2"].map((claimId) => ({ claimId, supporting: "Busqué documentos a favor de la afirmación.", opposing: "Busqué documentos en contra de la afirmación." })) }]];
    }
    return counsel("grok", { A1: "falso", A2: "falso" })(prompt, tools);
  };
  const { bench, events, prompts } = makeBench({ judge: judgeScript, grok, gemini: counsel("gemini", { A1: "falso", A2: "falso" }), claude: counsel("grok", { A1: "falso", A2: "falso" }), chatgpt: counsel("chatgpt", { A1: "falso", A2: "falso" }) });
  const play = bench.play;
  bench.play = async (spec, record, attempt) => {
    const outcome = await play(spec, record, attempt);
    if (spec.kind !== "instruction") return outcome;
    return { ...outcome, events: await translateFiledEvidence(outcome.events, "es", async (input) => input.title === "Relatório oficial"
      ? { changed: true, title: "Informe oficial", description: "", body: "El investigado no entregó los documentos." }
      : { changed: false, ...input }) };
  };
  await holdSession(bench);
  const filed = events.find((e) => e.type === "evidence_filed" && e.evidence.translation);
  assert.ok(filed && filed.type === "evidence_filed");
  assert.equal(filed.evidence.translation?.original.excerpt, "O investigado não entregou os documentos.");
  assert.equal(project(events).sources.get("E1")!.contributions.find((e) => e.by === "grok")?.excerpt, "El investigado no entregó los documentos.");
  const unification = prompts.judge.find((p) => p.includes("Unify the evidence of instruction"))!;
  const review = prompts.grok.find((p) => p.includes("Source review turn."))!;
  for (const prompt of [unification, review]) {
    assert.ok(prompt.includes("El investigado no entregó los documentos."));
    assert.ok(!prompt.includes("O investigado não entregou os documentos."));
  }
  assert.equal(instructionAttempts, 2);
});

test("a failed contribution translation stops the session before unification and source review", async () => {
  const { bench, events } = makeBench({ judge: judgeScript, grok: counsel("grok", null), gemini: counsel("gemini", null), claude: counsel("claude", null), chatgpt: counsel("chatgpt", null) });
  const play = bench.play;
  bench.play = async (spec, record, attempt) => {
    const outcome = await play(spec, record, attempt);
    if (spec.kind !== "instruction") return outcome;
    return { ...outcome, events: await translateFiledEvidence(outcome.events, "es", async () => { throw new Error("translator unavailable"); }) };
  };
  await assert.rejects(holdSession(bench), /translator unavailable/);
  assert.ok(!events.some((e) => e.type === "evidence_unified" || e.type === "source_review_vote"));
});

test("a full session reaches consensus where 3 of 4 agree and sends a split to the judge", async () => {
  const { bench, results, prompts, events } = makeBench({
    judge: judgeScript,
    grok: counsel("grok", { A1: "falso", A2: "verdadero" }),
    gemini: counsel("gemini", { A1: "falso", A2: "falso" }),
    claude: counsel("claude", null),
    chatgpt: counsel("chatgpt", { A1: "falso", A2: "no_verificable" }),
  });
  await holdSession(bench);

  assert.equal(events[0].type, "session_opened");
  assert.equal(events.at(-1)?.type, "session_closed");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq is contiguous");

  const view = project(events);
  assert.deepEqual(view.claims.map((c) => [c.id, c.judgment?.verdict, c.judgment?.method]), [
    ["A1", "falso", "consensus"],
    ["A2", "verdadero", "judge"],
  ]);
  assert.match(view.summary ?? "", /debatieron el alcance/);
  const summaryIndex = events.findIndex((e) => e.type === "case_summary");
  assert.ok(events.filter((e) => e.type === "judgment").every((e) => e.seq < events[summaryIndex].seq));
  assert.equal(summaryIndex, events.length - 2, "the summary is recorded after every judgment and before the session closes");
  const summaryPrompt = prompts.judge.at(-1)!;
  assert.ok(summaryPrompt.includes("Resultado de A1: Falso (por mayoría)"));
  assert.ok(summaryPrompt.includes("Resultado de A2: Verdadero (desempate del moderador)"));
  assert.match(summaryPrompt, /do not invent disagreements/);
  assert.ok(view.struck.has("I1"), "sustained objection strikes the objected statement");

  const rejected = results.find((r) => r.isError && r.tool === "make_statement");
  assert.match(rejected?.text ?? "", /P99/, "citing evidence not in the record is rejected back to the model");

  const evidenceIds = events.flatMap((e) => (e.type === "evidence_filed" ? [e.evidence.id] : []));
  assert.deepEqual(evidenceIds.slice(0, 2), ["P1", "P2"], "evidence filed in parallel is numbered uniquely");
  assert.equal(new Set(evidenceIds).size, evidenceIds.length);

  assert.equal(prompts.claude.filter((p) => /your closing statement/.test(p)).length, 2, "a missing vote gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "closing"), "a counsel that never votes is recorded as absent");
  assert.equal(events.filter((e) => e.type === "vote").length, 6);

  assert.equal(prompts.claude.filter((p) => /Instruction stage:/.test(p)).length, 2, "an unfinished instruction gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "instruction"), "and is then recorded as absent from instruction");

  for (const p of prompts.grok) {
    assert.match(p, /You are Grok, one of the four analysts/, "every turn carries the role brief");
    assert.match(p, /Debate record so far/, "and the record, since seats keep no memory");
  }
  assert.match(prompts.grok.at(-1)!, /\[I1\]/, "later turns see earlier statements");
});

test("a judge who never rules on an objection suspends the session instead of a ruling being invented", async () => {
  const silentJudge: Script = (prompt, tools) => (tools.includes("rule") ? [] : judgeScript(prompt, tools));
  const { bench, events } = makeBench({
    judge: silentJudge,
    grok: counsel("grok", null),
    gemini: counsel("gemini", null),
    claude: counsel("claude", null),
    chatgpt: counsel("chatgpt", null),
  });
  await assert.rejects(holdSession(bench), /no resolvió la objeción O1/);
  assert.ok(!events.some((e) => e.type === "ruling"), "no ruling is recorded in the judge's name");
});

test("the judge can dismiss a submission with no verifiable claims", async () => {
  const dismiss: Script = (_p, tools) => (tools.includes("dismiss_case") ? [["dismiss_case", { reason: "Es una opinión, no una afirmación fáctica." }]] : []);
  const { bench, events } = makeBench({ judge: dismiss, grok: () => [], gemini: () => [], claude: () => [], chatgpt: () => [] });
  bench.efforts = { judge: "high", counsel: { grok: "high", gemini: "high", claude: "high", chatgpt: null } };
  await holdSession(bench);
  assert.deepEqual(events.map((e) => e.type), ["session_opened", "dismissed", "session_closed"]);
  assert.deepEqual(events[0], { type: "session_opened", judgeModel: MODELS.judge, counselModels: MODELS.counsel, judgeEffort: "high", counselEfforts: bench.efforts.counsel, seq: 1, at: events[0].at });
});

test("an unfinished summary is retried and does not close the case without the moderator's words", async () => {
  const silent: Script = (prompt, tools) => tools.includes("summarize_case") ? [] : judgeScript(prompt, tools);
  const allAgree = (name: Counsel) => counsel(name, { A1: "falso", A2: "falso" });
  const { bench, events, prompts } = makeBench({ judge: silent, grok: allAgree("grok"), gemini: allAgree("gemini"), claude: allAgree("claude"), chatgpt: allAgree("chatgpt") });
  await assert.rejects(holdSession(bench), /no resumió el caso/);
  assert.equal(prompts.judge.filter((p) => p.includes("The case is already decided")).length, 2);
  assert.equal(events.filter((e) => e.type === "judgment").length, 2);
  assert.ok(!events.some((e) => e.type === "case_summary" || e.type === "session_closed"));
});

test("the moderator can finish the summary on retry after unanimous decisions", async () => {
  let attempts = 0;
  const retrying: Script = (prompt, tools) => {
    if (tools.includes("summarize_case") && attempts++ === 0) return [];
    return judgeScript(prompt, tools);
  };
  const allAgree = (name: Counsel) => counsel(name, { A1: "falso", A2: "falso" });
  const { bench, events } = makeBench({ judge: retrying, grok: allAgree("grok"), gemini: allAgree("gemini"), claude: allAgree("claude"), chatgpt: allAgree("chatgpt") });
  await holdSession(bench);
  assert.equal(attempts, 2);
  assert.equal(events.filter((e) => e.type === "case_summary").length, 1);
  assert.ok(project(events).claims.every((c) => c.judgment?.method === "consensus"));
  assert.equal(events.at(-1)?.type, "session_closed");
});

test("instruction finishes before opening and only an absolute majority can annul a shared source", async (t) => {
  for (const [vetoCount, absent, excluded] of [
    [4, false, true], [3, false, true], [2, false, false], [1, false, false], [0, false, false], [2, true, false],
  ] as const) {
    await t.test(`${vetoCount} vetoes, absent=${absent}`, async () => {
      const names = ["grok", "gemini", "claude", "chatgpt"] as const;
      const scripts = Object.fromEntries(names.map((name, i) => {
        const base = counsel(name === "claude" ? "grok" : name, { A1: "falso", A2: "falso" });
        const script: Script = (prompt, tools) => {
          if (tools.includes("review_sources")) return absent && name === "chatgpt" ? [] : [["review_sources", { votes: [{ sourceId: "E1", veto: i < vetoCount, reason: "Evalué la autoría y la metodología de esta fuente." }] }]];
          if (tools.includes("make_statement")) return base(prompt, tools).map(([tool, input]) => tool === "make_statement" ? [tool, { ...input, evidenceIds: [] }] : [tool, input]);
          return base(prompt, tools);
        };
        return [name, script];
      })) as Record<Counsel, Script>;
      const { bench, events, prompts } = makeBench({ judge: judgeScript, ...scripts });
      await holdSession(bench);
      const source = project(events).sources.get("E1")!;
      assert.equal(source.excluded, excluded);
      assert.equal(source.contributions.length, 4, "deduplicated source retains all four authors");
      assert.equal(Object.keys(source.votes).length, absent ? 3 : 4);
      const unified = events.findIndex((e) => e.type === "evidence_unified");
      const closed = events.findIndex((e) => e.type === "instruction_closed");
      const opening = events.findIndex((e) => e.type === "floor_granted");
      assert.ok(unified < closed && closed < opening);
      assert.ok(events.filter((e) => e.type === "source_review_vote").every((e) => e.seq > events[unified].seq && e.seq < events[closed].seq));
      assert.ok(events.filter((e) => e.type === "evidence_filed").every((e) => e.seq < events[unified].seq));
      for (const name of names) {
        const prompt = prompts[name].find((p) => /You have the floor for your opening statement/.test(p))!;
        assert.match(prompt, excluded ? /\[E1\] STRUCK OUT/ : /\[E1\] ADMITTED/);
        for (const author of ["Grok", "Gemini", "Claude", "ChatGPT"]) assert.ok(prompt.includes("Contribution by " + author));
      }
      if (absent) {
        assert.equal(prompts.chatgpt.filter((p) => /Source review turn\./.test(p)).length, 2);
        assert.ok(events.some((e) => e.type === "absence" && e.by === "chatgpt" && e.stage === "source_review"));
      }
    });
  }
});

test("an unfinished moderator unification blocks exposures rather than silently inventing a shared record", async () => {
  const silent: Script = (prompt, tools) => tools.includes("unify_evidence") ? [] : judgeScript(prompt, tools);
  const { bench, events, prompts } = makeBench({ judge: silent, grok: counsel("grok", null), gemini: counsel("gemini", null), claude: counsel("claude", null), chatgpt: counsel("chatgpt", null) });
  await assert.rejects(holdSession(bench), /no unificó las pruebas/);
  assert.equal(prompts.judge.filter((p) => /Unify the evidence of instruction with/.test(p)).length, 2);
  assert.ok(!events.some((e) => e.type === "floor_granted"));
});

test("instruction with no evidence records unsuccessful searches and shares an empty dossier", async () => {
  const script: Script = (_prompt, tools) => {
    if (tools.includes("vote_content")) return [["vote_content", { verdict: null, rationale: "Las afirmaciones no forman una narrativa común." }]];
    if (tools.includes("finish_instruction")) return [["finish_instruction", { searches: ["A1", "A2"].map((claimId) => ({ claimId, supporting: "Busqué respaldo a favor sin encontrar documentos verificables.", opposing: "Busqué respaldo en contra sin encontrar documentos verificables." })) }]];
    if (tools.includes("object")) return [["pass", {}]];
    if (tools.includes("cast_votes")) return [
      ["make_statement", { text: "La evidencia no alcanza para verificar estas afirmaciones.", evidenceIds: [] }],
      ["cast_votes", { votes: ["A1", "A2"].map((claimId) => ({ claimId, verdict: "no_verificable", rationale: "No encontramos pruebas verificables en ninguno de los dos sentidos." })) }],
    ];
    if (tools.includes("make_statement")) return [["make_statement", { text: "No contamos con evidencia verificable sobre las afirmaciones.", evidenceIds: [] }]];
    return [];
  };
  const { bench, events, prompts } = makeBench({ judge: judgeScript, grok: script, gemini: script, claude: script, chatgpt: script });
  await holdSession(bench);
  assert.equal(project(events).sources.size, 0);
  assert.equal(events.filter((e) => e.type === "instruction_completed").length, 4);
  assert.ok(!events.some((e) => e.type === "source_review_vote" || e.type === "absence"));
  assert.ok(project(events).claims.every((c) => c.judgment?.verdict === "no_verificable"));
  assert.ok(prompts.grok.some((p) => p.includes("No sources. Do not invent evidence")));
});

test("a misleading verdict can win a majority or be chosen by the moderator", async () => {
  const judge: Script = (prompt, tools) => tools.includes("decide")
    ? [["decide", { decisions: [{ claimId: "A2", verdict: "enganoso", reasoning: "Los datos se presentan fuera de su contexto original." }] }]]
    : judgeScript(prompt, tools);
  const { bench, events, prompts } = makeBench({
    judge,
    grok: counsel("grok", { A1: "enganoso", A2: "verdadero" }),
    gemini: counsel("gemini", { A1: "enganoso", A2: "falso" }),
    claude: counsel("claude", { A1: "enganoso", A2: "no_verificable" }),
    chatgpt: counsel("chatgpt", { A1: "falso", A2: "enganoso" }),
  });
  await holdSession(bench);
  assert.deepEqual(project(events).claims.map((c) => [c.judgment?.verdict, c.judgment?.method]), [
    ["enganoso", "consensus"], ["enganoso", "judge"],
  ]);
  assert.ok(prompts.judge.at(-1)!.includes("Resultado de A1: Engañoso (por mayoría)"));
  assert.ok(prompts.judge.at(-1)!.includes("Resultado de A2: Engañoso (desempate del moderador)"));
});

test("content voting follows all claim judgments and can disagree with their aggregate", async () => {
  const scripts = Object.fromEntries((["grok", "gemini", "claude", "chatgpt"] as const).map((name) => {
    const base = counsel(name, { A1: "verdadero", A2: "falso" });
    const script: Script = (prompt, tools) => tools.includes("vote_content")
      ? [["vote_content", { verdict: name === "chatgpt" ? "falso" : "enganoso", rationale: "La combinación de las afirmaciones omite contexto importante." }]]
      : base(prompt, tools);
    return [name, script];
  })) as Record<Counsel, Script>;
  const { bench, events, prompts } = makeBench({ judge: judgeScript, ...scripts });
  await holdSession(bench);
  const view = project(events);
  assert.deepEqual(view.contentJudgment, { verdict: "enganoso", method: "consensus", reasoning: "" });
  assert.equal(view.contentVotes.chatgpt?.verdict, "falso");
  assert.ok(events.filter((e) => e.type === "content_vote").every((e) => e.seq > events.filter((x) => x.type === "judgment").at(-1)!.seq));
  assert.ok(events.find((e) => e.type === "content_judgment")!.seq < events.find((e) => e.type === "case_summary")!.seq);
  assert.match(prompts.grok.find((p) => p.includes("assess the submitted content as a whole"))!, /Resultado de A1: Verdadero/);
  assert.match(prompts.grok.find((p) => p.includes("assess the submitted content as a whole"))!, /Resultado de A2: Falso/);
  assert.match(prompts.judge.at(-1)!, /Resultado del contenido completo: Engañoso/);
});

test("content votes need at least three votes; a split is decided by the moderator", async (t) => {
  for (const [votes, expected] of [
    [["verdadero", "falso", null, null], undefined],
    [["verdadero", "falso", "enganoso", null], "judge"],
    [[null, null, null, null], undefined],
  ] as const) {
    await t.test(JSON.stringify(votes), async () => {
      const names = ["grok", "gemini", "claude", "chatgpt"] as const;
      const scripts = Object.fromEntries(names.map((name, i) => {
        const base = counsel(name, { A1: "falso", A2: "falso" });
        return [name, ((prompt, tools) => tools.includes("vote_content")
          ? [["vote_content", { verdict: votes[i], rationale: "Evaluación del contenido según el debate completo." }]]
          : base(prompt, tools)) satisfies Script];
      })) as Record<Counsel, Script>;
      const judge: Script = (prompt, tools) => tools.includes("decide_content")
        ? [["decide_content", { verdict: "enganoso", reasoning: "La narrativa en conjunto presenta los hechos sin contexto." }]]
        : judgeScript(prompt, tools);
      const { bench, events } = makeBench({ judge, ...scripts });
      await holdSession(bench);
      assert.equal(project(events).contentJudgment?.method, expected);
      assert.equal(events.filter((e) => e.type === "content_vote").length, 4);
    });
  }
});

test("missing content votes are retried and never fabricated", async () => {
  const silent: Script = (prompt, tools) => tools.includes("vote_content") ? [] : counsel("grok", { A1: "falso", A2: "falso" })(prompt, tools);
  const { bench, events, prompts } = makeBench({ judge: judgeScript, grok: silent, gemini: silent, claude: silent, chatgpt: silent });
  await holdSession(bench);
  assert.equal(prompts.grok.filter((p) => p.includes("assess the submitted content as a whole")).length, 2);
  assert.equal(events.filter((e) => e.type === "absence" && e.stage === "content").length, 4);
  assert.equal(project(events).contentJudgment, undefined);
});

test("an unfinished content tiebreak does not invent a verdict or close the case", async () => {
  const names = ["grok", "gemini", "claude", "chatgpt"] as const;
  const verdicts = ["verdadero", "falso", "enganoso", "no_verificable"];
  const scripts = Object.fromEntries(names.map((name, i) => {
    const base = counsel(name, { A1: "falso", A2: "falso" });
    return [name, ((prompt, tools) => tools.includes("vote_content")
      ? [["vote_content", { verdict: verdicts[i], rationale: "Evaluación del contenido según el debate completo." }]]
      : base(prompt, tools)) satisfies Script];
  })) as Record<Counsel, Script>;
  const judge: Script = (prompt, tools) => tools.includes("decide_content") ? [] : judgeScript(prompt, tools);
  const { bench, events, prompts } = makeBench({ judge, ...scripts });
  await assert.rejects(holdSession(bench), /no desempató el contenido completo/);
  assert.equal(prompts.judge.filter((p) => p.includes("At least three analysts voted on the whole content")).length, 2);
  assert.ok(!events.some((e) => e.type === "content_judgment" || e.type === "session_closed"));
});
