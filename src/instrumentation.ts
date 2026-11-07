export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try { await import("./instrumentation.node.ts"); }
    catch { console.warn("OpenTelemetry initialization failed; case processing will continue."); }
  }
}
