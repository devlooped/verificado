// No complete durable reference set or historical-writer release protocol is
// proved. This is not a configurable bypass, and needs no DB/provider access.
export class SandboxCleanupBlockedError extends Error {
  constructor() {
    super("Sandbox cleanup blocked: resource references and historical writer inactivity are not proved");
    this.name = "SandboxCleanupBlockedError";
  }
}

export function assertSandboxCleanupSafe(): void {
  throw new SandboxCleanupBlockedError();
}

export const SANDBOX_CLEANUP_BLOCKED_RESPONSE = {
  code: "sandbox_cleanup_blocked",
  error: "Operación bloqueada: no está demostrada la limpieza segura de sandboxes y snapshots privados. Se conservaron el expediente, sus archivos y referencias; no se inició otra ejecución.",
};
