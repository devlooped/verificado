import { canDeleteCase, type CaseUser } from "./case-access.ts";
import { SandboxCleanupBlockedError, SANDBOX_CLEANUP_BLOCKED_RESPONSE } from "./sandbox-cleanup.ts";

type DeleteCase = (id: string) => Promise<"deleted" | "missing" | "active">;

// Route handlers are public: do not rely on the button being hidden.
export async function deleteCaseResponse(request: Request, id: string, user: CaseUser | null | undefined, remove: DeleteCase): Promise<Response> {
  if (!user?.sub) return Response.json({ error: "Iniciá sesión." }, { status: 401 });
  if (!canDeleteCase(user)) return Response.json({ error: "No autorizado." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Origen no autorizado." }, { status: 403 });
  // Current IDs and historical base64url IDs, without path separators.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: "Caso inválido." }, { status: 400 });
  try {
    const result = await remove(id);
    if (result === "missing") return Response.json({ error: "Caso no encontrado." }, { status: 404 });
    if (result === "active") return Response.json({ error: "El caso o una tarea detenida sigue en curso. Intentá de nuevo más tarde." }, { status: 409 });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof SandboxCleanupBlockedError) return Response.json(SANDBOX_CLEANUP_BLOCKED_RESPONSE, { status: 409 });
    console.error("Case deletion failed:", error);
    return Response.json({ error: "No se pudo completar la eliminación. Algunos archivos podrían haberse borrado; intentá de nuevo." }, { status: 500 });
  }
}
