// No complete durable reference set or historical-writer release protocol is
// proved. This is not a configurable bypass, and needs no DB/provider access.
export class SandboxCleanupBlockedError extends Error {
  constructor() {
    super("Sandbox cleanup blocked: resource references and historical writer inactivity are not proved");
    this.name = "SandboxCleanupBlockedError";
  }
}

export function assertSandboxCleanupSafe(): void {
  // Temporary opt-out for administrative cleanup of expert cases.
  // Leaves sandboxes/snapshots behind; `purge-sandbox-snapshots.ts` reclaims them.
  if (process.env.UNSAFE_CASE_DELETE === "1") {
    console.warn("UNSAFE_CASE_DELETE=1: bypassing sandbox cleanup guard; sandboxes/snapshots may be orphaned.");
    return;
  }
  throw new SandboxCleanupBlockedError();
}

export const SANDBOX_CLEANUP_BLOCKED_RESPONSE = {
  code: "sandbox_cleanup_blocked",
  error: "Operación bloqueada: no está demostrada la limpieza segura de sandboxes y snapshots privados. Se conservaron el expediente, sus archivos y referencias; no se inició otra ejecución.",
};
