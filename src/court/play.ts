import { imageDescribed, type CourtEvent } from "../domain/court.ts";
import { randomUUID } from "node:crypto";
import { blobConfigured, writeEvidenceTree } from "../evidence/blob.ts";
import { getImage } from "../store.ts";
import { courtOutputPhase, DEFAULT_MODELS, MOCK_MODEL_ID, modelEffort, seatModel } from "./models.ts";
import { runSeat, type SeatImage } from "./seat.ts";
import { conductTurn, type Docket, type SeatId, type TurnOutcome, type TurnSpec } from "./turns.ts";
import { turnPhase } from "../instruction/court-tools.ts";

async function imagesFor(caseId: string, docket: Docket): Promise<SeatImage[]> {
  // A described image reaches seats as text in the prompt, so no seat analyzes it again.
  if (docket.submission.kind !== "image" || imageDescribed(docket.submission, docket.submissionContext)) return [];
  const image = await getImage(caseId);
  if (!image) throw new Error("No se encontró la imagen del caso " + caseId + ".");
  return [{ data: image.bytes, mimeType: image.mimeType }];
}

// Workflow step body: one attempt of one seat, using AI Gateway for every model.
export async function playTurn(
  caseId: string,
  docket: Docket,
  spec: TurnSpec,
  record: readonly CourtEvent[],
  attempt: number,
  evidence?: { index: string; citations: string[] }
): Promise<TurnOutcome> {
  const models = docket.models ?? DEFAULT_MODELS;
  const images = await imagesFor(caseId, docket);
  const research: Array<{ seat: SeatId; stepNumber: number; content: unknown[] }> = [];
  const outcome = await conductTurn(docket, spec, record, attempt, async ({ seat, prompt, tools, done }) => {
    await runSeat({
      caseId,
      role: seat === "judge" ? "moderator" : "analyst",
      model: seatModel(models, seat),
      research: spec.kind === "instruction",
      outputPhase: courtOutputPhase(turnPhase(spec)),
      xResearcher: models["research.x"],
      prompt,
      tools,
      done,
      images,
      mock: docket.simulated ? { spec, record, submission: docket.submission } : undefined,
      onResearchStep: (step) => research.push({ seat, ...step }),
    });
  }, evidence);
  if (research.length && blobConfigured()) {
    const runId = randomUUID();
    for (const step of research) {
      const path = `evidence/${step.seat}/research/${runId}/step-${String(step.stepNumber).padStart(3, "0")}.json`;
      const model = seatModel(models, step.seat);
      const modelId = docket.simulated ? MOCK_MODEL_ID : model.id;
      const effort = docket.simulated ? null : modelEffort(model);
      await writeEvidenceTree(caseId, new Map([[path, JSON.stringify({ spec, attempt, modelId, effort, ...step })]]));
    }
  }
  return outcome;
}
