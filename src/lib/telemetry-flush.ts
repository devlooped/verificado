// The Next instrumentation bundle and workflow steps can be separate modules.
// Share only a flush callback, not a provider or per-case state.
const key = Symbol.for("chebot.telemetry.flush");
type Registry = typeof globalThis & { [key]?: () => Promise<void> };

export function setTelemetryFlush(flush: () => Promise<void>): void {
  (globalThis as Registry)[key] = flush;
}

export function telemetryFlush(): Promise<void> | undefined {
  return (globalThis as Registry)[key]?.();
}
