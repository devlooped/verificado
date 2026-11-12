import type { CheckType } from "../domain/court.ts";
import { isAdmin, type CaseUser } from "./case-access.ts";
import { SandboxCleanupBlockedError, SANDBOX_CLEANUP_BLOCKED_RESPONSE } from "./sandbox-cleanup.ts";

type RerunDependencies = {
  // The check type of the case, undefined when there is no such case.
  checkType: (id: string) => Promise<CheckType | undefined>;
  restartCase: (id: string) => Promise<"queued" | "missing" | "active" | "missing-image">;
  start: (id: string, latestPipeline: boolean) => Promise<unknown>;
  finish: (id: string, status: "failed", error: string) => Promise<void>;
};

export const EXPERT_DISABLED = "El chequeo experto está deshabilitado: este caso no se puede volver a ejecutar.";

export async function rerunCaseResponse(request: Request, id: string, user: CaseUser | null | undefined, deps: RerunDependencies): Promise<Response> {
  if (!user?.sub) return Response.json({ error: "Iniciá sesión." }, { status: 401 });
  if (!isAdmin(user)) return Response.json({ error: "No autorizado." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Origen no autorizado." }, { status: 403 });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: "Caso inválido." }, { status: 400 });
  try {
    // Before the restart deletes anything: an Expert case would only fail again.
    if (await deps.checkType(id) === "expert") return Response.json({ error: EXPERT_DISABLED }, { status: 409 });
    const result = await deps.restartCase(id);
    if (result === "missing") return Response.json({ error: "Caso no encontrado." }, { status: 404 });
    if (result === "active") return Response.json({ error: "El caso o una tarea detenida sigue en curso. Intentá de nuevo más tarde." }, { status: 409 });
    if (result === "missing-image") return Response.json({ error: "No se encontró la imagen original." }, { status: 409 });
    try {
      await deps.start(id, true);
    } catch (error) {
      console.error("could not start court session:", error);
      await deps.finish(id, "failed", "No se pudo iniciar la sesión.");
    }
    return Response.json({ id }, { status: 200 });
  } catch (error) {
    if (error instanceof SandboxCleanupBlockedError) return Response.json(SANDBOX_CLEANUP_BLOCKED_RESPONSE, { status: 409 });
    console.error("Case rerun failed:", error);
    return Response.json({ error: "No se pudo volver a ejecutar el caso." }, { status: 500 });
  }
}
