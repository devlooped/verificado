<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Vercel sandbox snapshots

Never delete the harness snapshot this project starts sandboxes from. Before deleting any Vercel Sandbox snapshot, read the production environment variables `INSTRUCTION_SANDBOX_SNAPSHOT_ID` and `EVIDENCE_SANDBOX_SNAPSHOT_ID` and preserve every snapshot id they name. Deleting one of those ids is permanent and stops new instruction sandboxes from starting.
