import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { observeCaseStep } from "./lib/case-telemetry.ts";
import { telemetryFlush } from "./lib/telemetry-flush.ts";

test("configured OTLP collectors receive case logs and processing metrics", async (t) => {
  const received: Record<string, string[]> = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      (received[request.url!] ??= []).push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = { logs: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, metrics: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, runtime: process.env.NEXT_RUNTIME };
  t.after(() => {
    for (const [key, value] of Object.entries({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: previous.logs, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: previous.metrics, NEXT_RUNTIME: previous.runtime })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://127.0.0.1:${address.port}/v1/logs`;
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `http://127.0.0.1:${address.port}/v1/metrics`;
  process.env.NEXT_RUNTIME = "nodejs";
  t.mock.method(console, "info", () => {});
  await import("./instrumentation.node.ts");
  await observeCaseStep("TEST-CASE", "fetch_proposals", {}, async () => {});
  await telemetryFlush();
  assert.ok(received["/v1/logs"]?.some((body) => body.includes("TEST-CASE") && body.includes("case.step.completed")));
  assert.ok(received["/v1/metrics"]?.some((body) => body.includes("case.processing.step.attempts") && body.includes("case.processing.step.duration")));
});
