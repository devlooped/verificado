import { canViewAdmin, isAdmin, type CaseUser } from "./case-access.ts";

type Dependencies = { checkSnapshot: () => Promise<boolean>; hasUnread: () => Promise<boolean> };

export async function adminNotificationResponse(request: Request, user: CaseUser | null | undefined, deps: Dependencies): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!canViewAdmin(user)) return Response.json({ error: "No autorizado." }, { status: 403, headers });
  // Checks write notifications and sweep sandboxes: Contrib only reads.
  if (request.method === "POST" && !isAdmin(user)) return Response.json({ error: "No autorizado." }, { status: 403, headers });
  if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Origen no autorizado." }, { status: 403, headers });
  }
  try {
    const changed = request.method === "POST" ? await deps.checkSnapshot() : false;
    return Response.json({ unread: await deps.hasUnread(), changed }, { headers });
  } catch {
    return Response.json({ error: "No se pudieron consultar las notificaciones." }, { status: 503, headers });
  }
}
