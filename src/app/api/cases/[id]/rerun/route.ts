import { revalidatePath } from "next/cache";
import { auth0 } from "@/lib/auth0.ts";
import { rerunCaseResponse } from "@/lib/rerun-case-response.ts";
import { startCourtSession } from "@/lib/case-workflow.ts";
import { deleteCaseBlobs } from "@/evidence/blob.ts";
import { finishCase, restartCase } from "@/store.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await auth0.getSession();
  const { id } = await context.params;
  const response = await rerunCaseResponse(request, id, session?.user, {
    restartCase: (caseId) => restartCase(caseId, deleteCaseBlobs),
    start: startCourtSession,
    finish: finishCase,
  });
  if (response.status === 200) {
    revalidatePath("/");
    revalidatePath(`/c/${id}`);
  }
  return response;
}
