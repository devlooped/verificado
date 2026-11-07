import { registerOTel } from "@vercel/otel";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { setTelemetryFlush } from "./lib/telemetry-flush.ts";

// Vercel captures console logs and custom metrics itself. OTLP signals are sent
// only when a collector is explicitly configured; the SDK reads OTLP headers
// and signal-specific endpoints from the standard environment variables.
const logsEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
const metricsEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
let logProcessor: BatchLogRecordProcessor | undefined;
let metricReader: PeriodicExportingMetricReader | undefined;
try { if (logsEnabled) logProcessor = new BatchLogRecordProcessor(new OTLPLogExporter()); }
catch { console.warn("OTLP log exporter initialization failed."); }
try { if (metricsEnabled) metricReader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }); }
catch { console.warn("OTLP metric exporter initialization failed."); }

registerOTel({ serviceName: "chebot", instrumentations: [],
  ...(logProcessor ? { logRecordProcessors: [logProcessor] } : {}),
  ...(metricReader ? { metricReaders: [metricReader] } : {}),
});
setTelemetryFlush(async () => {
  await Promise.all([logProcessor?.forceFlush(), metricReader?.forceFlush()]);
});
