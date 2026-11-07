import { blobConfigured } from "../evidence/blob.ts";
import { requireLocalDatabase } from "../lib/local-database.ts";
import { LATEST_PIPELINE_VERSION, type CheckType, type PipelineVersion } from "../domain/court.ts";
import { instructionBridgeConfig } from "./config.ts";

// New cases use shared instruction on a normal deployment. The explicit legacy
// switch is a rollback for new cases; stored case versions are never rewritten.
// COURT_PIPELINE_VERSION=3 opts new cases into native provider research;
// they use version 5 to preserve the replay sequence of existing native runs.
// Reruns explicitly request the latest version, independent of the new-case
// rollback switch, but still undergo its preflight. A Quick check has no
// instruction: it always keeps shared storage and needs no sandbox bridge.
export async function requestedPipeline(_caseId: string, simulated: boolean, check: CheckType = "expert", latest = false): Promise<PipelineVersion> {
  const version = process.env.COURT_PIPELINE_VERSION;
  if (version && version !== "1" && version !== "2" && version !== "3") throw new Error("COURT_PIPELINE_VERSION must be 1, 2 or 3");
  if (!latest && version === "1" && check === "expert") return 1;
  const shared = latest || version === "3" ? LATEST_PIPELINE_VERSION : 2;
  if (simulated) { requireLocalDatabase(); return shared; }
  if (check === "quick") {
    if (!blobConfigured() || !gatewayKey()) throw new Error("Durable storage and the AI Gateway key are required for a Quick check");
    return shared;
  }
  await instructionBridgeConfig();
  if (!blobConfigured() || !gatewayKey()) throw new Error("Durable storage and the authenticated sandbox bridge are required before research");
  return shared;
}

function gatewayKey(): boolean {
  const key = process.env.AI_GATEWAY_API_KEY?.trim();
  return Boolean(key) && key !== "placeholder";
}
