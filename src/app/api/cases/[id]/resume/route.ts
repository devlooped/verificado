import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth0 } from "@/lib/auth0.ts";
import { isAdmin } from "@/lib/case-access.ts";
import { startCourtSession } from "@/lib/case-workflow.ts";
import { finishCase, resumeFailedCase } from "@/store.ts";

// Returns true only if both strings are non-empty and byte-equal in constant time.
function bearerMatchesEnv(presented: string | null, envValue: string | undefined): boolean {
  if (!presented || !envValue) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(envValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)/i)?.[1] ?? null;
  const tokenAuthorized = bearerMatchesEnv(bearer, process.env.RECOVERY_ADMIN_TOKEN);
  if (!tokenAuthorized) {
    const session = await auth0.getSession();
    const user = session?.user;
    if (!user?.sub) return Response.json({ error: "Iniciá sesión." }, { status: 401 });
    if (!isAdmin(user)) return Response.json({ error: "No autorizado." }, { status: 403 });
    if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Origen no autorizado." }, { status: 403 });
  }
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Response.json({ error: "Caso inválido." }, { status: 400 });
  let body: { reason?: unknown; stages?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "JSON inválido." }, { status: 400 }); }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return Response.json({ error: "Falta el motivo del recovery." }, { status: 400 });
  const stages = Array.isArray(body.stages)
    ? body.stages.filter((s): s is string => typeof s === "string" && /^[a-z_]{1,32}$/.test(s))
    : undefined;
  if (Array.isArray(body.stages) && stages!.length !== body.stages.length) {
    return Response.json({ error: "Etapas inválidas." }, { status: 400 });
  }
  const result = await resumeFailedCase(id, { reason, stages });
  if (result === "missing") return Response.json({ error: "Caso no encontrado." }, { status: 404 });
  if (result === "inactive") return Response.json({ error: "El caso no está en estado failed, o tiene state de continuación activo." }, { status: 409 });
  if (result === "active") return Response.json({ error: "El run anterior no se ha asentado; esperá antes de reintentar." }, { status: 409 });
  if (result === "no-operations") return Response.json({ error: "No hay operaciones failed/uncertain para recuperar." }, { status: 409 });
  try {
    await startCourtSession(id);
  } catch (error) {
    console.error("could not start court session after surgical resume:", error);
    await finishCase(id, "failed", "No se pudo reiniciar la sesión tras el recovery quirúrgico.");
    return Response.json({ error: "Recovery registrado pero no se pudo reiniciar el workflow." }, { status: 500 });
  }
  revalidatePath("/");
  revalidatePath(`/c/${id}`);
  return Response.json({ id }, { status: 200 });
}
