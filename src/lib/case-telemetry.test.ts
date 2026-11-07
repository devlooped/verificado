import assert from "node:assert/strict";
import test from "node:test";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { contextStorage } from "../../node_modules/@workflow/core/dist/step/context-storage.js";
import { caseLog, errorFields, observeCaseStep } from "./case-telemetry.ts";

test("correlates workflow logs and spans, and records bounded OTEL and per-case Vercel metrics", async (t) => {
  const logExporter = new InMemoryLogRecordExporter();
  const logger = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(logExporter)] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 });
  const meter = new MeterProvider({ readers: [reader] });
  const spanExporter = new InMemorySpanExporter();
  const tracer = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  assert.ok(logs.setGlobalLoggerProvider(logger));
  assert.ok(metrics.setGlobalMeterProvider(meter));
  assert.ok(trace.setGlobalTracerProvider(tracer));
  t.after(async () => { logs.disable(); metrics.disable(); trace.disable(); await Promise.all([logger.shutdown(), meter.shutdown(), tracer.shutdown()]); });

  const consoleRecords: string[] = [];
  t.mock.method(console, "info", (line: string) => { consoleRecords.push(line); });
  t.mock.method(console, "error", (line: string) => { consoleRecords.push(line); });
  const nativeMetrics: Array<{ name: string; tags: Record<string, string> }> = [];
  const ipc = Symbol.for("@vercel/rusty-runtime-ipc");
  const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const old = globals[ipc];
  globals[ipc] = { sendMetric: (name: string, _value: number, tags: Record<string, string>) => nativeMetrics.push({ name, tags }) };
  t.after(() => { if (old === undefined) delete globals[ipc]; else globals[ipc] = old; });

  const workflow = { workflowName: "courtSession", workflowRunId: "wrun_case_v2", workflowStartedAt: new Date(), url: "", features: { encryption: false } };
  const step = { stepName: "fetchProposals", stepId: "step_123", stepStartedAt: new Date(), attempt: 2 };
  await contextStorage.run({ workflowMetadata: workflow, stepMetadata: step, ops: [], preCompletionOps: [] }, async () => {
    assert.equal(await observeCaseStep("AT-185-GA", "fetch_proposals", { "sources.count": 4 }, async () => {
      caseLog("AT-185-GA", "info", "case.source.started", { "source.url_hash": "hash" });
      return 42;
    }), 42);
    await assert.rejects(observeCaseStep("AT-185-GA", "fetch_proposals", {}, async () => { throw new Error("secret prompt https://example.test/?token=secret"); }), /secret prompt/);
  });
  await Promise.all([reader.forceFlush(), logger.forceFlush(), tracer.forceFlush()]);

  const records = consoleRecords.map((line) => JSON.parse(line));
  assert.ok(records.every((record) => record["case.id"] === "AT-185-GA" && record["case.version"] === "wrun_case_v2" && record["workflow.step.id"] === "step_123" && record["workflow.step.attempt"] === 2));
  assert.ok(records.some((record) => record.event === "case.step.failed" && record["error.type"] === "Error"));
  assert.doesNotMatch(consoleRecords.join("\n"), /secret|example\.test/);
  assert.ok(logExporter.getFinishedLogRecords().some((record) => record.eventName === "case.source.started" && record.attributes["case.version"] === "wrun_case_v2"));
  assert.ok(spanExporter.getFinishedSpans().every((span) => span.attributes["case.id"] === "AT-185-GA" && span.attributes["case.version"] === "wrun_case_v2"));
  assert.deepEqual(nativeMetrics.map((point) => point.tags.outcome), ["completed", "failed"]);
  assert.ok(nativeMetrics.every((point) => point.tags.case_id === "AT-185-GA" && point.tags.case_version === "wrun_case_v2"));
  const data = metricExporter.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assert.deepEqual(new Set(data.map((item) => item.descriptor.name)), new Set(["case.processing.step.attempts", "case.processing.step.duration"]));
  assert.ok(data.every((item) => item.dataPoints.every((point) => !("case.id" in point.attributes) && !("case.version" in point.attributes))));
});

test("telemetry failures do not change the result or mask a case error", async (t) => {
  t.mock.method(console, "info", () => { throw new Error("logger failed"); });
  t.mock.method(console, "error", () => { throw new Error("logger failed"); });
  assert.equal(await observeCaseStep("case", "test", {}, async () => 42), 42);
  const failure = new Error("original failure");
  Object.defineProperty(failure, "code", { get() { throw new Error("broken error property"); } });
  assert.deepEqual(errorFields(failure), { "error.type": "UnknownError" });
  await assert.rejects(observeCaseStep("case", "test", {}, async () => { throw failure; }), (error) => error === failure);
});
