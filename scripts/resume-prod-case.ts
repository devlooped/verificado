// Surgical recovery of a failed case: POSTs to /api/cases/:id/resume. Preserves
// every ready source operation and only marks failed/uncertain operations as
// pending before starting a fresh workflow run from the surviving checkpoints.
//
// Auth (one of):
//   RECOVERY_ADMIN_TOKEN=<token>   - bearer token (preferred for scripts; set
//                                    the same value in Vercel prod env var)
//   APP_COOKIE="appSession=..."    - admin Auth0 session cookie (browser-copy)
//
// Usage:
//   RECOVERY_ADMIN_TOKEN=... node --import tsx scripts/resume-prod-case.ts \
//     --case AT-185-GA \
//     --reason "verifier flakiness, LANGUAGE_VERIFICATIONS=5 landed" \
//     [--stages translation,acquisition] [--base https://che.bot]
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    reason: { type: "string" },
    stages: { type: "string" },
    force: { type: "boolean", default: false },
    base: { type: "string", default: "https://che.bot" },
  },
});

if (!values.case || !values.reason?.trim()) {
  throw new Error("Usage: resume-prod-case --case ID --reason REASON [--stages s1,s2] [--base URL]");
}
const bearer = process.env.RECOVERY_ADMIN_TOKEN?.trim();
const cookie = process.env.APP_COOKIE?.trim();
if (!bearer && !cookie) {
  throw new Error("RECOVERY_ADMIN_TOKEN or APP_COOKIE env var required.");
}

const base = values.base!.replace(/\/+$/, "");
const url = `${base}/api/cases/${encodeURIComponent(values.case)}/resume`;
const stages = values.stages?.split(",").map((s) => s.trim()).filter(Boolean);
const payload: Record<string, unknown> = { reason: values.reason };
if (stages?.length) payload.stages = stages;
if (values.force) payload.force = true;

const headers: Record<string, string> = {
  "content-type": "application/json",
  origin: base,
};
if (bearer) headers.authorization = `Bearer ${bearer}`;
else if (cookie) headers.cookie = cookie;

const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text);
if (!response.ok) process.exit(1);
