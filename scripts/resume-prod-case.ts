// Surgical recovery of a failed case: POSTs to /api/cases/:id/resume with the
// admin's Auth0 session cookie. Preserves every ready source operation and only
// marks failed/uncertain operations as pending before starting a fresh workflow.
//
// Usage:
//   APP_COOKIE="appSession=..." node --import tsx scripts/resume-prod-case.ts \
//     --case AT-185-GA --reason "verifier flakiness, LANGUAGE_VERIFICATIONS=5 landed" \
//     [--stages translation,acquisition] [--base https://che.bot]
//
// Get the cookie from a browser session signed in as an Admin: DevTools →
// Application → Cookies → copy the `appSession=...` value. The cookie is only
// sent over HTTPS and kept in-process; never log it.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    reason: { type: "string" },
    stages: { type: "string" },
    base: { type: "string", default: "https://che.bot" },
  },
});

if (!values.case || !values.reason?.trim()) {
  throw new Error("Usage: resume-prod-case --case ID --reason REASON [--stages s1,s2] [--base URL]");
}
const cookie = process.env.APP_COOKIE?.trim();
if (!cookie) throw new Error("APP_COOKIE env var required (Auth0 admin session cookie, e.g. appSession=...).");

const base = values.base!.replace(/\/+$/, "");
const url = `${base}/api/cases/${encodeURIComponent(values.case)}/resume`;
const stages = values.stages?.split(",").map((s) => s.trim()).filter(Boolean);
const payload: Record<string, unknown> = { reason: values.reason };
if (stages?.length) payload.stages = stages;

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: base,
    cookie,
  },
  body: JSON.stringify(payload),
});
const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text);
if (!response.ok) process.exit(1);
