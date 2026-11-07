import { context, metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { metric, waitUntil } from "@vercel/functions";
import { getStepMetadata, getWorkflowMetadata } from "workflow";
import { telemetryFlush } from "./telemetry-flush.ts";

type Attributes = Record<string, string | number | boolean>;
type Level = "info" | "warn" | "error";

// The workflow run ID, unlike cases.revision, stays fixed throughout a run.
// Directly invoked steps (tests and local scripts) have no workflow context.
function correlation(caseId: string): Attributes {
  const fields: Attributes = { "case.id": caseId };
  try { fields["case.version"] = getWorkflowMetadata().workflowRunId; } catch { /* not in a workflow */ }
  try {
    const step = getStepMetadata();
    fields["workflow.step.id"] = step.stepId;
    fields["workflow.step.attempt"] = step.attempt;
  } catch { /* not in a workflow step */ }
  return fields;
}

// Only controlled metadata is logged: never prompts, model output, URLs,
// credentials, error messages, or source text. The framework retains its own
// exception diagnostics; error type/code and step identify where to look.
export function errorFields(error: unknown): Attributes {
  try {
    const name = error instanceof Error ? error.name : "UnknownError";
    const fields: Attributes = { "error.type": /^[\w.-]{1,80}$/.test(name) ? name : "Error" };
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = String(error.code);
      if (/^[\w.-]{1,80}$/.test(code)) fields["error.code"] = code;
    }
    if (typeof error === "object" && error !== null) {
      const status = "statusCode" in error ? error.statusCode : "status" in error ? error.status : undefined;
      if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) fields["http.response.status_code"] = status;
    }
    return fields;
  } catch { return { "error.type": "UnknownError" }; }
}

export function caseLog(caseId: string, level: Level, event: string, attributes: Attributes = {}): void {
  try {
    const fields = { ...attributes, ...correlation(caseId) };
    const record = { severity: level.toUpperCase(), event, ...fields };
    console[level](JSON.stringify(record));
    logs.getLogger("chebot.case").emit({
      eventName: event, body: event, severityText: level.toUpperCase(),
      severityNumber: level === "error" ? SeverityNumber.ERROR : level === "warn" ? SeverityNumber.WARN : SeverityNumber.INFO,
      attributes: fields,
    });
  } catch { /* telemetry must not affect case processing */ }
}

function recordStep(caseId: string, step: string, outcome: "completed" | "failed", duration: number): void {
  try {
    // OTel metrics use bounded labels; case/run identity is in logs and spans.
    const dimensions = { step, outcome };
    const meter = metrics.getMeter("chebot.case");
    meter.createCounter("case.processing.step.attempts", { description: "Workflow step attempts" }).add(1, dimensions);
    meter.createHistogram("case.processing.step.duration", { unit: "ms", description: "Workflow step attempt duration" }).record(duration, dimensions);
  } catch { /* telemetry must not affect case processing */ }
  try {
    // Vercel stores individual points, so they can be filtered by case/run.
    const ids = correlation(caseId);
    const tags: Record<string, string> = { step, outcome, case_id: caseId };
    if (typeof ids["case.version"] === "string") tags.case_version = ids["case.version"];
    metric("case.processing.step.duration_ms", duration, tags);
  } catch { /* telemetry must not affect case processing */ }
}

function flush(): void {
  try {
    const pending = telemetryFlush()?.catch(() => {});
    if (pending) waitUntil(pending);
  } catch { /* no Vercel request context or telemetry unavailable */ }
}

// A start record is emitted before any I/O. If a function times out, it is the
// last visible record, including the step ID and retry attempt.
export async function observeCaseStep<T>(caseId: string, step: string, attributes: Attributes, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]> | undefined;
  try { span = trace.getTracer("chebot.case").startSpan(`case.${step}`, { attributes: { ...attributes, ...correlation(caseId), "case.step": step } }); } catch { /* tracing unavailable */ }
  const execute = async () => {
    caseLog(caseId, "info", "case.step.started", { ...attributes, "case.step": step });
    try {
      const result = await run();
      const duration = Date.now() - started;
      caseLog(caseId, "info", "case.step.completed", { ...attributes, "case.step": step, "duration.ms": duration });
      recordStep(caseId, step, "completed", duration);
      return result;
    } catch (error) {
      const duration = Date.now() - started;
      caseLog(caseId, "error", "case.step.failed", { ...attributes, ...errorFields(error), "case.step": step, "duration.ms": duration });
      try { span?.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* tracing unavailable */ }
      recordStep(caseId, step, "failed", duration);
      throw error;
    } finally {
      try { span?.end(); } catch { /* tracing unavailable */ }
      flush();
    }
  };
  return span ? context.with(trace.setSpan(context.active(), span), execute) : execute();
}
