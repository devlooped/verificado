# Shared instruction and settled evidence (pipeline 2)

Pipeline 2 is the default for new cases, including production deployments from a
normal push. The user deferred the deployed smoke; live OIDC/egress and provider
cache/cost behavior have not been verified. Historical and in-flight
pipeline 1 cases keep their original tools, artifact formats, and download URLs;
[evidence.md](evidence.md) describes that legacy format.

## Boundaries

- The host owns acquisition, extraction/OCR, language verification and translation.
  The verifier is a model that sometimes rejects text already in the case
  language, so a rejection is checked once more before the translation
  operation fails for good. Only model-written public text (seat prose, filed
  drafts, admitted sources) is verified and translated.
- The app's own prompts, tasks, tool descriptions, tool outputs and rejection
  messages are written in English. Every seat system prompt starts with one
  language rule (`languageRule`) that names the case language and variant, such
  as Latin American Spanish, and requires quotations to be translated
  faithfully, never kept in the source language. Source titles in tool outputs
  stay in their original language.
  Durable PostgreSQL operation claims deduplicate work within a case. Completed
  stages and confirmed failures are reused. An interrupted external operation
  becomes uncertain, never an automatic paid retry.
- Instruction and source criticism can discover sources. Criticism research must
  reference a unified `reviewSourceId`; its artifacts are `review_context`, not
  new claim filings. Intake translates the submission and its linked page, and
  court actions are written in the case language, but sources and discovery
  results are read in their original language until evidence closes: translating
  sources that may never be admitted spent the turns' time. Filed excerpts quote
  the original; seats translate what they quote in their own prose into the case
  language.
- Three or four vetoes exclude a source; zero through two admit it. Missing
  reviews are not vetoes. Closing instruction translates each admitted source
  wholesale into the case language, keeping its block IDs, then freezes admitted `E1.md` documents,
  their section mappings, `question.json`, `index.md` and a hash-verified manifest.
  Missing, partial or changed settled artifacts block debate.
- Debate starts clean once for each seat/channel, then appends committed events
  and messages. Private phase checkpoints retain tool-call outcomes and model
  steps for recovery, not for ZIP export. Sandbox preparation and host decisions
  are separate continuing conversations. Context overflow never resets history.
  Preparation reserves its eighth and last step for a response with tool calls
  disabled, and the last 120 seconds of its 300-second turn for that synthesis:
  a call that requests tools must end, its tools included, before the reserve,
  and tools are disabled once less than a further minute remains. In the VM, a
  tool that outlasts its call's time returns an error to the model, and a call
  that requests tools and times out spends its step without output, so the
  synthesis still follows; a synthesis that times out fails closed.
  Preparation sandboxes also have a 300-second timeout.
  Model/command timeouts respect the remaining turn time. The turn spans many
  workflow steps, never one: each preparation call starts detached in the VM,
  and steps of at most a minute wait for it until it ends; each decision
  generation is a step of its own, of at most 150 seconds. In pipeline 3 an
  analyst decides its instruction filing, and its source review votes, in two
  answers of the same conversation, without tools: first in prose, with the
  model's own thinking and no format, in at most 240 seconds, then, after a
  follow-up message that asks for it, as a typed answer (structured output) of
  at most 150 seconds, with reasoning `none` (the least the model allows:
  Claude Opus cannot turn its thinking off). Models that always think, such as
  Claude, cannot combine thinking with a forced tool call or answer in one
  request. The host records the typed answer in the next step. A source review
  that leaves out sources, or whose votes are invalid, keeps its valid votes:
  the follow-up names the sources still missing, and the seat votes on those
  only; an answer that does not parse, or that the host rejects, gets the reason
  and another typed generation while the turn (600 seconds) has time. It still fails closed
  if the budget expires without a nonempty final response; a partial draft cannot advance the decision
  channel. Exhaustion and incomplete final responses are non-retryable workflow
  failures: replaying an already spent checkpoint cannot replenish its budget.
  So are failed or uncertain source operations (translation, acquisition,
  extraction): a retried step would only read the stored status again. The
  exception is the translation of a seat's preparation report, in every phase,
  of the commentary and search notes of a pipeline 3 filing, and of source
  review reasons: that prose keeps its own language, and the failed operation
  stays in the case log. The case
  error names the operation key, stage, status and stored reason. A failed seat
  lets the other seats of its round finish before the case fails and its
  sandbox resources are retained; revocation of grants does not authorize deletion.
- Debate tools read only manifest-listed IDs/sections, never URLs, originals or
  instruction drafts. All source-bearing court actions validate corpus citations.
  Local sandbox computation accepts bounded numeric operations, not shell code.

## Storage and downloads

New cases use `instruction/` for originals, canonical processing and provisional
research; immutable `evidence/` for admitted case-language sources; and
`discussion/` for later analytical drafts. The complete ZIP includes these
namespaces plus one root `case.jsonl`, a typed union of court events, model steps
and source-operation provenance. It omits a separate
`transcript.jsonl` and private conversation checkpoints.

So that `case.jsonl` reads in a single language, the English prompts it records
(system prompts and tasks) are written in the case language when the case
language is not English. Each translation is cached in the `prompt_translations`
table under a hash of the source prompt and the target language: a changed
prompt has a new key and gets a new translation, and an unchanged one is
translated once for all cases. Before archiving, the workflow fills the cache a
few prompts per step, with the case's translator model; the archive then only
reads it. The cache is used only to write `case.jsonl`; the models always
receive the English prompts, and `case.json` counts the translations as
translator usage. A prompt that cannot be translated fails the archive step
rather than leaving English in the export.

The case record links admitted `E1` and `E1#p1:b2` references to safe Markdown previews.
Downloads remain public-read audit artifacts, **not a privacy boundary** and not
the input mounted into debate sandboxes. Legacy archives are not rewritten.

## Starting a case over

Only admins can retry failed cases or see raw failure details. Other visitors
receive a generic failure message with no retry control. The failed-case page's
**Reintentar** action is blocked server-side and has no effects. The separate
administrative rerun and deletion are also blocked while safe resource cleanup
is unproved. They return HTTP 409 with `code: sandbox_cleanup_blocked`, preserving
the entire case, upload, access metadata, generated state, Blob artifacts,
aliases, phase checkpoints and sandbox bindings. No new workflow is started.
The store checks under the case lock before any destructive callback, so a
direct caller or no-op callback cannot discard private-resource references.
Terminal status, cancellation, expired grants or absent tags/bindings do not
prove complete references or historical writer inactivity. This does not recover
references/resources lost by earlier resets or already-expired snapshots.
Automatic cleanup logs the block without replacing the original workflow error;
it keeps the existing step sequence. Same-execution retries can reuse active
legacy checkpoints, but this is not public continuation or a reset fallback.

## Local verification and recovery

Keep the effective `DATABASE_URL` restricted to explicit loopback and database
`grokeado_local_fixture`; `.env.local` is ignored and keeps the previous production
assignment commented locally. Never print connection strings or run the fixture
scripts against production. The scripts reject inherited remote URLs before
connecting:

```powershell
node --import tsx scripts/check-local-database.ts
node --import tsx scripts/test-local-instruction.ts
node --import tsx scripts/test-local-rerun.ts
$env:COURT_AI_MODE = "mock"
npm test
npm run typecheck
npm run build
git diff --check
```

The PostgreSQL fixture uses mocked acquisition/translation and in-memory
artifacts, verifies ownership/checkpoint CAS, ID regeneration and cascading
deletion, and cleans up its own case. It does not use Blob or paid AI.

For a failed or uncertain local source stage, inspect its operation and audit
first, then explicitly authorize only the affected stage:

```powershell
node --import tsx scripts/recover-source.ts --case CASE_ID --operation OPERATION_KEY --reason "Reviewed reason for retry"
```

This command is local-database guarded, records the reason, and does not execute
the retry. Exactly-once external billing cannot be guaranteed across a crash
between external completion and checkpoint publication.

## Deployment and deferred smoke

The normal deployment reuses existing configuration: the trusted HTTPS
`APP_BASE_URL` (or Vercel's `VERCEL_URL`), team/project identity from the host's
Vercel OIDC function context (or local `VERCEL_OIDC_TOKEN`),
`EVIDENCE_SANDBOX_SNAPSHOT_ID`, `AI_GATEWAY_API_KEY`, durable database and Blob
storage. The gateway key is shared with the rest of the application rather than
separately budgeted for evidence processing. Newly created
sandboxes receive the deployed instruction harness over the SDK; no separate
snapshot rebuild is needed for this code change. These harness files are included
in Next.js server traces. Resumed sandboxes retain their original harness.

Explicit `INSTRUCTION_TOOL_ORIGIN`, `INSTRUCTION_SANDBOX_TEAM_ID`,
`INSTRUCTION_SANDBOX_PROJECT_ID` and `INSTRUCTION_SANDBOX_SNAPSHOT_ID` overrides
remain available. Missing trusted identity, HTTPS origin, snapshot, storage or
gateway credentials fails before research; there is no open-network fallback.
No case allowlist, preview-only restriction or opt-in variable is required.
`COURT_PIPELINE_VERSION=1` rolls new cases back to the legacy pipeline; unset or
`2` selects shared instruction. Persisted cases retain their chosen version.

For a future deployed smoke, use explicitly authorized fixture storage and AI
costs. Do not point local verification at production or create snapshots without
authorization. Plan completion records implementation, not a passed live smoke.

Persistent sandboxes resume by name. Their OIDC-verified `sandboxName` selects
the binding, not the VM `sandboxId`, which can change across resumes.
Each stop snapshots the VM for the next turn. Future preparation snapshots use
no expiration and no deletion on eviction (SDK policy: `snapshotExpiration: 0`,
`keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: false }`). Before
accessing an existing VM or explicitly stopping it, its future-snapshot policy
is updated without an explicit resume. An API/quota failure blocks rather than
running a new command or explicitly stopping under the old policy.
Automatic case deletion and the notification sweep are blocked for **all**
case sandboxes, including resolved, failed, deleted, renamed and ambiguous tags:
there is no complete durable reference-release and historical-inactivity proof.
The workflow cleanup step stays in its original position for replay and logs
`case.sandboxes.cleanup_blocked`; revoking a grant still preserves resource IDs.
The sweep returns no deleted names and does not enumerate provider resources.
Untagged snapshot-build and `purpose:*` smoke resources are likewise untouched.

This is not historical recovery. Already-expiring snapshots retain their old
expiration, and already-deleted snapshots cannot be restored by this change.
Stopped historical VMs not accessed by this code are not retroactively updated.
Provider automatic timeout/retention and old deployments remain unverified; if
a policy update fails, this code cannot prevent the provider's own timeout.
Retention increases storage. Historical resets may already have detached private
resources; current admin reset/deletion is blocked and does not authorize losing
more references. No quota monitor, cost estimate, complete resource registry or
safe deletion protocol is implemented. Do not run provider calls to validate
these assumptions without separate authorization.
Evidence-step sandboxes are not persistent.
The SDK-authenticated proxy checks team/project, sandbox/case/session binding,
committed phase, active turn, expiry and request budget. Only exact POST tool and
generation paths are forwarded. Generation is constrained to the snapshotted
model/options and harness function tools; native search, URL/file inputs and
unmatched routes fail closed. No database, Blob or gateway credential enters the
VM. Deployed OIDC, deployment protection and egress must still be smoke-tested.
The SDK also serializes its user-agent into the generation body; the broker
accepts only that metadata, not arbitrary header overrides. Rejections log known
reason codes on the host while public errors remain generic. Preparation errors
include the command exit code, never raw sandbox output.

OpenAI requests use case/phase/seat/channel-scoped cache keys. Anthropic requests
mark the immutable initial message with an ephemeral cache breakpoint; other
providers retain their implicit caching behavior. Both channels record actual
provider usage, including cache-read/write fields when supplied. Stable prefixes
and hints do **not** prove cache hits: measure per-provider staging requests,
minimum lengths, TTLs and cost against the legacy fixture in the deferred smoke.
