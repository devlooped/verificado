import assert from "node:assert/strict";
import test from "node:test";
import { assertLegacyRunWriter, legacyWorkflowRunId, rerunRunSettled, withLegacyRunScope, type RerunWorldReader } from "./rerun-run.ts";

function reader(status = "completed", pages = [{ data: [{ runId: "run", status: "completed" }], hasMore: false, cursor: null as string | null }]): RerunWorldReader {
  let page = 0;
  return { runs: { get: async () => ({ runId: "run", status, deploymentId: "deployment" }) }, steps: { list: async () => pages[page++] ?? pages.at(-1)! } };
}

test("rerun needs a matching terminal run and every page of settled steps", async () => {
  for (const status of ["completed", "failed", "cancelled"]) assert.equal(await rerunRunSettled("run", reader(status)), true);
  for (const status of ["pending", "running", "unknown"]) assert.equal(await rerunRunSettled("run", reader(status)), false);
  const pages = [
    { data: [{ runId: "run", status: "completed" }], hasMore: true, cursor: "next" },
    { data: [{ runId: "run", status: "running" }], hasMore: false, cursor: null },
  ];
  assert.equal(await rerunRunSettled("run", reader("completed", pages)), false);
  pages[1].data[0].status = "completed";
  assert.equal(await rerunRunSettled("run", reader("completed", pages)), true);
  assert.equal(await rerunRunSettled("other", reader()), false);
  for (const status of ["completed", "failed", "pending"]) {
    assert.equal(await rerunRunSettled("run", reader("failed", [{ data: [{ runId: "run", status }], hasMore: false, cursor: null }])), true);
  }
});

test("ambiguous steps, unavailable journals and incomplete pagination fail closed", async () => {
  for (const status of ["running", "cancelled", "unknown"]) {
    assert.equal(await rerunRunSettled("run", reader("failed", [{ data: [{ runId: "run", status }], hasMore: false, cursor: null }])), false);
  }
  for (const cursor of [null, "repeated"]) assert.equal(await rerunRunSettled("run", reader("completed", [{ data: [], hasMore: true, cursor }])), false);
  assert.equal(await rerunRunSettled("run", reader("completed", [{ data: [], hasMore: false, cursor: null }])), false);
  const missingDeployment = reader();
  missingDeployment.runs.get = async () => ({ runId: "run", status: "completed", deploymentId: "" });
  assert.equal(await rerunRunSettled("run", missingDeployment), false);
  const world = reader();
  world.steps.list = async () => { throw new Error("private provider diagnostics"); };
  assert.equal(await rerunRunSettled("run", world), false);
  // Explicitly rejected reader does not consult another World or expose its error.
  assert.equal(await rerunRunSettled("run", Promise.reject(new Error("offline"))), false);
});

test("a previously started pending step and a run changing during the read are not settled", async () => {
  const world = reader();
  world.steps.list = async () => ({ data: [{ runId: "run", status: "pending", startedAt: new Date() }], hasMore: false, cursor: null });
  assert.equal(await rerunRunSettled("run", world), false);
  const changed = reader();
  let calls = 0;
  changed.runs.get = async () => ({ runId: "run", status: ++calls === 1 ? "completed" : "running", deploymentId: "deployment" });
  assert.equal(await rerunRunSettled("run", changed), false);
});

test("broker run identity survives await and fences old writers without leaking across requests", async () => {
  const outside = () => { throw new Error("not a workflow"); };
  assert.equal(legacyWorkflowRunId(outside), undefined);
  await Promise.all(["old", "new"].map(runId => withLegacyRunScope(runId, async () => {
    await Promise.resolve();
    assert.equal(legacyWorkflowRunId(outside), runId);
    if (runId === "old") assert.throws(() => assertLegacyRunWriter(legacyWorkflowRunId(outside), "new", null), /fenced/);
    else assertLegacyRunWriter(legacyWorkflowRunId(outside), "new", null);
  })));
  assert.equal(legacyWorkflowRunId(outside), undefined);
  assert.throws(() => assertLegacyRunWriter("old", null, null), /fenced/);
  assert.throws(() => assertLegacyRunWriter("new", "new", "new"), /fenced/);
});
