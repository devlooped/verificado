import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import matrix from "../docs/continuation-unit-matrix.json" with { type: "json" };
import effects from "../docs/continuation-effect-sites.json" with { type: "json" };
import { inspectContinuationSources, inspectSource } from "../scripts/continuation-inventory.ts";
import { COUNSEL, type CourtEvent, type RecordedEvent } from "./domain/court.ts";
import { holdSession, type Bench } from "./court/procedure.ts";
import { holdQuickSession, type QuickBench } from "./court/quick.ts";
import { collectProposedBatches } from "./instruction/proposed-urls.ts";
import { MemoryOperationRepository } from "./instruction/source-store.ts";

// Design evidence only: passing these tests does not enable any continuation.
// All executable dependencies below are pure orchestration/in-memory stores.
const AT = "2026-11-07T12:00:00.000Z";
const models = { judge: "fixture/judge", counsel: { grok: "fixture/grok", gemini: "fixture/gemini", claude: "fixture/claude", chatgpt: "fixture/chatgpt" } };
const submission = { kind: "text" as const, text: "Material sintético local, no es AT-185-GA." };
const inspect = (file: string) => inspectSource(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

test("matrix covers expert/Quick 1–5 but authorizes no unproved route", () => {
  assert.equal(matrix.continuationEnabled, false);
  assert.equal(matrix.purpose, "step-1-design-only; not runtime permission or migration");
  const routes = ["expert", "quick"].flatMap((check) => [1, 2, 3, 4, 5].map((pipeline) => `${check}:${pipeline}`));
  assert.deepEqual(matrix.profiles.map((p) => p.route), routes);
  for (const profile of matrix.profiles) {
    assert.equal(profile.continuation, "blocked", profile.route);
    assert.equal(profile.adapter, "none-tested", profile.route);
    assert.ok(profile.requiredProofs.includes("interruption-and-reuse"));
    assert.ok(profile.requiredProofs.includes("no-old-writers-or-external-commands"));
    assert.ok(profile.gaps.length);
  }
  const ids = matrix.units.map((unit) => unit.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const unit of matrix.units) {
    assert.ok(unit.key && unit.result && unit.evidence.length && unit.gaps.length, unit.id);
    for (const route of unit.routes) assert.ok(routes.includes(route), `${unit.id}: ${route}`);
    for (const dependency of unit.dependsOn) assert.ok(ids.includes(dependency), `${unit.id}: ${dependency}`);
    for (const gap of unit.gaps) assert.ok(matrix.gaps.includes(gap), `${unit.id}: ${gap}`);
    for (const reference of unit.evidence) assert.ok(inspect(reference.file).symbols.includes(reference.symbol), `${unit.id}: ${reference.file}/${reference.symbol}`);
  }
});

test("all observed workflow steps and TurnSpec kinds have unit contracts", () => {
  const actual = inspectContinuationSources(fileURLToPath(new URL("../", import.meta.url)));
  const covered = matrix.units.flatMap((u) => u.workflowSteps.map((s) => `${s.file}:${s.symbol}`));
  assert.deepEqual([...new Set(covered)].sort(), actual.steps.flatMap((s) => s.steps.map((step) => `${s.file}:${step}`)).sort());
  assert.deepEqual(matrix.units.filter((u) => u.id.startsWith("court.") && u.id !== "court.publish").map((u) => u.id.slice(6)).sort(), actual.turnKinds);
});

test("reviewed source effect inventory detects drift without executing writers", () => {
  // Replacing this fixture is a review decision, not automatic compatibility.
  assert.deepEqual(inspectContinuationSources(), effects);
  for (const kind of ["model", "network", "workflow", "sandbox", "browser", "object-storage", "sql-write-or-lock", "write-candidate"]) {
    assert.ok(effects.sites.some((site) => site.kind === kind), kind);
  }
  for (const scope of ["recordEvents", "saveCover", "savePhaseCheckpoint", "consumeSandboxBinding", "changeOperation", "restartCase", "revokeSandboxBindings"]) {
    assert.ok(effects.sites.some((s) => s.file === "src/store.ts" && s.scope === scope), scope);
  }
});

test("source scanner finds concatenated SQL and nested effects, not comments", () => {
  const result = inspectSource("fixture.ts", `
    // generateImage({}); client.query('DELETE FROM cases');
    async function publish() { "use step";
      const result = await client.query('INSERT INTO events ' + columns + ' ON CONFLICT DO NOTHING');
      await artifacts.write('fixture', new Map()); await found.delete({deleteOrphanSnapshots: true});
      await sandbox.update({ snapshotExpiration: 0 });
    }
  `);
  assert.deepEqual(result.steps, ["publish"]);
  assert.deepEqual(result.sites.map(({ scope, call, kind }) => ({ scope, call, kind })), [
    { scope: "publish", call: "client.query", kind: "sql-write-or-lock" },
    { scope: "publish", call: "artifacts.write", kind: "write-candidate" },
    { scope: "publish", call: "found.delete", kind: "sandbox" },
    { scope: "publish", call: "sandbox.update", kind: "sandbox" },
  ]);
});

test("the model catalog's injectable fetch remains visible as a network effect", () => {
  assert.ok(inspect("src/lib/gateway-catalog.ts").sites.some((site) =>
    site.scope === "fetchModelsDev" && site.call === "fetch" && site.kind === "network"));
});

test("G02: a second pure Quick invocation starts at seq=1, not at the stored prefix", async () => {
  const stored: RecordedEvent[] = [];
  let answers = 0;
  const bench: QuickBench = {
    submission, models,
    answer: async (by) => { answers++; return { text: `Respuesta de ${by}`, sources: [], at: AT }; },
    vote: async () => ({ verdict: "falso", rationale: "Fundamento sintético suficiente.", at: AT }),
    tiebreak: async () => { throw new Error("Consensus fixture must not tiebreak"); },
    commit: async (events) => { stored.push(...events); },
  };
  await holdQuickSession(bench);
  const prefixLength = stored.length;
  await holdQuickSession(bench);
  assert.equal(stored[prefixLength].seq, 1);
  assert.equal(answers, 2 * COUNSEL.length);
  assert.deepEqual(stored.slice(prefixLength).map((e) => e.type), stored.slice(0, prefixLength).map((e) => e.type));
});

test("G04: a completed expert seat is absent from the published round if another rejects", async () => {
  const stored: RecordedEvent[] = [];
  const completed: string[] = [];
  const bench: Bench = {
    submission, models,
    play: async (spec) => {
      if (spec.kind === "intake") return { done: true, events: [{ type: "claims_entered", claims: [{ id: "A1", quote: "Local", text: "Afirmación sintética verificable." }], at: AT }] };
      assert.equal(spec.kind, "instruction");
      if (spec.kind !== "instruction") throw new Error("Unexpected turn");
      if (spec.counsel === "gemini") throw new Error("fixture interruption");
      completed.push(spec.counsel);
      return { done: true, events: [{ type: "instruction_completed", by: spec.counsel, searches: [], at: AT }] };
    },
    commit: async (events) => { stored.push(...events); },
  };
  await assert.rejects(holdSession(bench), /fixture interruption/);
  assert.equal(completed.length, 3);
  assert.ok(stored.some((e) => e.type === "instruction_opened"));
  assert.equal(stored.filter((e) => e.type === "instruction_completed").length, 0);
});

test("G04: Quick rejects while other seats are still in flight, without publishing their results", async () => {
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const stored: RecordedEvent[] = [];
  let completed = 0;
  const bench: QuickBench = {
    submission, models,
    answer: async (by) => {
      if (by === "gemini") throw new Error("fixture interruption");
      await release.promise;
      return { text: `Respuesta de ${by}`, sources: [], at: AT };
    },
    vote: async () => {
      if (++completed === 3) finished.resolve();
      return { verdict: "falso", rationale: "Fundamento sintético suficiente.", at: AT };
    },
    tiebreak: async () => { throw new Error("Unexpected moderator"); },
    commit: async (events) => { stored.push(...events); },
  };
  try {
    await assert.rejects(holdQuickSession(bench), /fixture interruption/);
    assert.equal(completed, 0);
  } finally {
    release.resolve();
    await finished.promise;
  }
  assert.equal(completed, 3);
  assert.deepEqual(stored.map((e) => e.type), ["session_opened"]);
});

test("G05: 33-URL/four-error synthetic fixture proves v4/v5 progress is lossy", async () => {
  const proposals: RecordedEvent[] = Array.from({ length: 33 }, (_, i) => ({
    type: "evidence_proposed", by: COUNSEL[i % COUNSEL.length], seq: i + 1, at: AT,
    proposal: { claimId: "A1", url: `https://fixture.invalid/${i}`, quote: "Pasaje sintético local.", stance: "supports" },
  }));
  const results: Array<{ url: string; error?: string; sourceId?: string }> = proposals.map((_, i) => ({ url: `https://fixture.invalid/${i}`, ...(i < 4 ? { error: "fixture_unreadable" } : { sourceId: `source-${i}` }) }));
  for (const showUrls of [false, true]) {
    const report = async (alternative: boolean) => {
      const progress: CourtEvent[] = [];
      let fixtureReads = 0;
      const fetched = await collectProposedBatches(proposals, async (urls) => urls.map((url) => {
        fixtureReads++;
        const result = results.find((item) => item.url === url)!;
        return alternative ? { ...result, ...(result.error ? { error: "different_exact_error" } : { sourceId: "different-id" }) } : result;
      }), async (event) => { progress.push(event); }, showUrls);
      assert.equal(fixtureReads, 33);
      return { fetched, progress };
    };
    const first = await report(false), other = await report(true);
    assert.equal(first.fetched.length, 33);
    assert.equal(first.fetched.filter((r) => r.error).length, 4);
    assert.equal(first.progress.filter((e) => e.type === "source_batch_completed").length, 9);
    assert.notDeepEqual(first.fetched, other.fetched);
    assert.deepEqual(first.progress, other.progress, "Events cannot prove exact sourceId/error results");
    assert.equal(first.progress.filter((e) => e.type === "source_batch_started").length, showUrls ? 9 : 0);
  }
});

test("G07: an expired operation becomes uncertain and is not claimed again", async () => {
  let now = Date.parse(AT);
  const operations = new MemoryOperationRepository(() => now);
  const claim = await operations.claim("fixture", "paid-step", "decision-generation", 10);
  assert.equal(claim.owned, true);
  now += 11;
  const retry = await operations.claim("fixture", "paid-step", "decision-generation", 10);
  assert.equal(retry.owned, false);
  assert.equal(retry.operation.status, "uncertain");
  if (claim.owned) await assert.rejects(operations.publish("fixture", "paid-step", claim.owner, {}), /ownership lost/);
});
