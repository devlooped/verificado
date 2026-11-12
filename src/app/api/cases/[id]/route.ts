import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth0 } from "@/lib/auth0.ts";
import { deleteCaseResponse, performCaseDeletion } from "@/lib/delete-case-response.ts";
import { deleteCaseBlobs } from "@/evidence/blob.ts";
import { withSandboxCleanup } from "@/instruction/preparation.ts";
import { deleteCase } from "@/store.ts";

function bearerMatchesEnv(presented: string | null, envValue: string | undefined): boolean {
  if (!presented || !envValue) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(envValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)/i)?.[1] ?? null;
  // A Quick check with no sandbox reference skips the sandbox cleanup guard.
  const remove = (caseId: string) => deleteCase(caseId, withSandboxCleanup(deleteCaseBlobs), deleteCaseBlobs);
  let response: Response;
  if (bearerMatchesEnv(bearer, process.env.RECOVERY_ADMIN_TOKEN)) {
    response = await performCaseDeletion(id, remove);
  } else {
    const session = await auth0.getSession();
    response = await deleteCaseResponse(request, id, session?.user, remove);
  }
  if (response.status === 204) {
    revalidatePath("/");
    revalidatePath(`/c/${id}`);
  }
  return response;
}
