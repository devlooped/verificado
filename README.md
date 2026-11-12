# Che, bot

The whole court runs as a Vercel Workflow. Each seat attempt is a durable step
using AI SDK through Vercel AI Gateway. Court events are saved to Postgres in
idempotent batches between rounds. Completed steps are replayed from the workflow
journal; an interrupted seat attempt can run again, including its paid model and
research calls. Court participant generations are capped at 32,000 output tokens
per model call by default. `RESEARCH_CONTEXT_SIZE` overrides this for Expert
instruction and criticism (both preparation and decision), Quick analyst answers
and link claim identification; `DEBATE_CONTEXT_SIZE` overrides it for Expert
debate (both preparation and decision). Intake and other Quick calls use
`CONTEXT_SIZE`. Each phase override falls back to `CONTEXT_SIZE`, then 32,000.
Set these variables to positive integers; they limit output, not the model's input
context window. They do not change helper workers such as translation or search
extraction. Already-bound preparation calls retain their original limit when
resumed. A native research report that reaches the limit fails rather than
silently filing a partial report.

For case/run-correlated logs, workflow progress, Vercel metrics, and optional
OpenTelemetry export, see [case processing observability](docs/observability.md).

Admins can delete resolved or failed cases and their Postgres and Blob data;
active cases cannot be deleted. A failed Blob cleanup leaves the case record for
a retry, although some files may already have been deleted. Workflow journals
are not deleted by this feature and may retain step data under the workflow
backend’s retention policy. Do not run `cases:regenerate-ids -- --apply`
concurrently with case deletion.

By default the moderator and Grok analyst use `spacexai/grok`; the other
analysts use `google/gemini-argon`, `anthropic/opus`, and
`openai/gpt-sol`. Translations of sources and promoted evidence use a separate
translator role, `google/gemini-flash-lite`. An uploaded image is described
and its text transcribed once, by `openai/gpt-terra`, while the evidence base
is collected; language detection and cover review use
`anthropic/haiku`, cover search `spacexai/grok` and the cover
illustration `spacexai/grok-imagine-image`. Every role (seats, image
description, language detection, translator, cover search, review and
illustration, and the tier-eval models, including the tier evaluator that
routes each claim)
has its default in `src/court/models.ts` and can be overridden by a user with
the exact `Admin` role at `/admin`, linked from the session badge. Overrides are
stored in the `model_settings` table as provider and model family (including
flavors such as `flash`), and validated against the Vercel catalog on
models.dev. Existing versioned settings are read as families. The catalog is
cached for an hour per process; on refresh failure the last successful copy is
reused. If no copy is available, real cases cannot resolve their models. Each
case snapshots the newest available version of each configured family when its
session opens; retries keep that snapshot. Simulated cases work offline.
`npm run models` lists the current Gateway catalog.

All analysts have Gateway's Parallel web search and Browserbase page fetch.
They can also search public X posts through a Grok researcher using Gateway and
the native X search tool. The moderator can fetch submitted links. Seats read the
description of an uploaded image instead of the image itself; only when the
description fails is the image, loaded from Postgres, sent to them as an image
input. No Cursor account, local agent
process, provider API keys, or X OAuth connection is required.

## Court procedure

Every new request is a **Quick** check: the **Expert** check is disabled and
hidden from the interface. The request form offers no type, the server refuses any
`check` other than `quick`, and a rerun or a recovery of an Expert case is refused
before anything is deleted (a workflow started for one fails at once). The type is
still stored with the submission as `check`; cases recorded before it read as
Expert, and their records still display, without naming the check type.

### Claims or questions

A Quick check opens with the moderator classifying the material, without
researching or answering it: **claims** (a news item, a post, a statement, or a
request to verify one, "is it true that...?") or **questions** that the panel is
asked to answer. The classification is recorded as `content_classified`. When the
moderator cannot classify the material in two attempts, it is checked as claims,
without that event; cases recorded before the classification are claims too.

Questions are not checked and receive no rating at all, neither each question nor
the whole: no claims are identified (even when the request asked for it), and
nobody votes. Each analyst answers `QUESTION: <content>` with its own search,
like a Quick answer; a seat without an answer after two attempts is recorded as
absent. With at least three answers, the moderator writes a synthesis from the
answers alone, without tools, recorded as `answer_synthesis`: the majority's
answer when at least three analysts substantially agree on every question
(`majority: true`), otherwise each position and who holds it (`majority: false`).
Fewer than three answers, or a synthesis that fails twice, fail the case.

### Quick check of claims

A Quick check of claims has no instruction, instruction, source review, debate, objections or
moderator summary. Each of the four analysts, in parallel, receives the case
language rule and `FACT CHECK: <content>` (a link with the submitter's note, or
the image with its note), answers in prose using its provider's own web search
tools (no sandbox), then gives its overall vote on the whole content in the same
conversation. Each answer and each vote is its own workflow step, bounded to
240 seconds and tried once more on failure; a seat that still has no vote is
recorded as absent. Three agreeing votes decide; otherwise, with at least three
votes, the moderator breaks the tie from the content, the answers and the votes
alone, without tools. When there is a majority, the moderator briefly summarizes
the supporting votes without researching or changing the verdict; if claims were
identified, each majority is summarized separately. Fewer than three votes fail
the case, which can be retried.
The answers are recorded as `quick_response` events with the pages their
provider cited; those pages are the providers' citations, not sources reviewed
by the panel. Every generation's request and result is kept under `quick/` in
the case artifacts, and the archive holds them with one `case.jsonl`. A Quick
case always uses the shared storage version, even under
`COURT_PIPELINE_VERSION=1`, and needs only Blob storage and the AI Gateway key.

### Expert check

Disabled for new cases (see above); described here for the cases recorded with it.

After the moderator identifies the claims, the court opens **instrucción**, a
stage exclusively for evidence. Every analyst must actively search for evidence
both supporting and opposing every claim, file relevant excerpts with their
orientation, and explicitly document both searches before finishing. Searches
that find no reliable evidence are recorded as such; analysts must not invent
evidence to create artificial balance.

The moderator then unifies contributions by source URL (ignoring `#` fragments).
Each newly unified source receives an `E` identifier (such as `E1`) and retains
every original excerpt, claim, orientation and contributing analyst. Original
`P` contributions remain in the audit trail. Distinct URLs remain separate sources.
In case records, known historical `S` source identifiers are displayed as `E`
references; stored events and original evidence remain unchanged, and old source
anchors still work.

All four analysts independently review every shared source, including their own,
and record a veto or a decision not to veto, with a concrete reliability reason.
**Three of the four analysts** must veto a source to exclude it; ties and absences
do not lower that threshold. The case record preserves all votes, reasons and excluded
sources. An unfinished moderator unification suspends the court after one retry.

Only after criticism ends does the court begin opening statements, rebuttals,
objections and final votes. Every seat sees the same closed source dossier and
may use any admitted source to support or challenge positions, regardless of who
contributed it. In new cases, statements can cite only admitted `E` source
identifiers. New evidence cannot be filed during the debate; excluded sources
cannot support statements, votes or moderator decisions. If no evidence was
found, the empty dossier is recorded and analysts are instructed to vote
`no_verificable` (presented as Insostenible) when evidence is insufficient. The
other verdicts are Verdadero, Falso and Engañoso (`enganoso`, for misleading or
out-of-context claims). The
historical `no_verificable` identifier is retained so existing records remain
readable. Historical records without instruction events remain readable too.

Once every claim has a decision, the moderator records a case summary of the
salient arguments, agreements and disagreements, using the completed record.
An unfinished summary suspends the court after one retry. Existing cases without
a summary remain readable; they are not silently backfilled with invented text.
The result page opens with cards for the submitted content, the configured panel,
and the claims with their overall result and individual analyst votes. Each vote
links to its folded reason; the moderator's case summary follows the cards. When
a text submission matches its only claim, one card combines the content, result
and votes without repeating the claim's text.

## Case revisions and caching

Resolved case events are cached by case ID and database revision and revalidated
after an hour; active and failed cases are read dynamically. Closing a new run or adding
new events to a resolved case advances its revision atomically. Duplicate events
and repeated closes do not. Any future code that edits or removes resolved
events must also advance the revision in the same transaction.

The revision is a cache version, not a history of prior runs: opening a session
currently clears its existing events. Preserving old results requires a separate
revision-history design before offering a way to revisit resolved cases.

## Vercel setup

1. Select your team in the Vercel dashboard, open **AI Gateway → API Keys**, and
   create a key. Add `AI_GATEWAY_API_KEY` to `.env.local` (already git-ignored).
   Keep it server-side; do not prefix it with `NEXT_PUBLIC_`.
2. Check **AI Gateway → Credits** and add a payment method if requested. Gateway
   has its own usage balance, independent of a model vendor's chat subscription.
   Vercel documents a $5/month free tier with payment verification and purchased
   credits for larger workloads. Buying credits transitions the account to the
   paid tier, where the monthly free credit no longer applies. Model inference,
   web search, page fetch, and X research can all incur usage charges.
3. For deployment, keep your Postgres and Auth0 variables configured and either
   use Vercel's automatic OIDC Gateway authentication or add the Gateway key to
   the project's deployment environment variables. Set the production
   `APP_BASE_URL` to `https://che.bot`, configure `www.che.bot` to redirect to
   it, and keep its callback and logout URLs registered in Auth0. Redeploy after
   environment changes.
4. Under project **Settings → Environment Variables**, enable access to **System
   Environment Variables**. Workflow uses `VERCEL_DEPLOYMENT_ID` to select its
   managed Vercel backend. No hosted workflow service is needed for local tests.

References: [Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok),
[Gateway pricing](https://vercel.com/docs/ai-gateway/pricing),
[Gateway research tools](https://vercel.com/docs/ai-gateway/models-and-providers/web-search),
[Workflow deployment](https://workflow-sdk.dev/docs/deploying).

## Local development and live tests

Install dependencies with `npm install`. Merge the needed variables from
`.env.example` into your existing `.env.local`; do not overwrite existing secrets.
Use Node.js 22 or newer.

### Local AI Gateway simulation

Run `npm run dev:mock` to start Next.js with deterministic, fictitious AI
responses. Alternatively set `COURT_AI_MODE=mock` in `.env.local`, then restart
`npm run dev`. The default is `live`. This mode replaces both the Gateway models
and web/X research tools, so it makes no model, search or page-fetch requests and
does not need Gateway credentials. Postgres and Auth0 are still needed to use the
normal application UI; this mode only mocks AI and research.

The fixtures run through the real AI SDK tool loop, schemas, court procedure and
Workflow steps. They contribute sources both for and against the synthetic claim,
merge repeated sources with all four authors, and veto an unreliable source with
three votes. They also supply statements, an objection/reply/ruling and final
`no_verificable` votes. Source URLs use the reserved `.test` domain. The mock does
not analyze arbitrary claims or submitted images: all evidence and conclusions
are invented solely to exercise the application. Cases persist their simulation
flag so the case record and result remain visibly labeled even after switching modes.

To test individual mocked turns without a database, server or credentials:

```sh
node --import tsx --test src/court/mock.test.ts
```

These tests block network access and exercise turns independently; they do not
create or validate a complete case. To return to real providers, stop the mock
server, set `COURT_AI_MODE=live` (or remove it), and run `npm run dev`.

For a smaller live model test, run `npm run test:gateway`. It uses the actual
court prompts and tools to identify a census claim, research it with each of the
four analysts, unify and review the sources, and record their final votes. It requires a Gateway credential but
no database or web server. It makes paid requests and fails if any analyst
doesn't file evidence or vote. It does not test Workflow orchestration.

For a complete local scenario:

1. Set `AI_GATEWAY_API_KEY` and `DATABASE_URL` in `.env.local`.
2. Start the app with `npm run dev`. Restart it after changing credentials.
   Next.js runs the Workflow handlers locally and keeps the journal in
   `.next/workflow-data/`. Keep that folder to allow interrupted runs to resume.
3. In another terminal, run `npm run test:court`. This creates a case in the
   configured database and starts the compiled court workflow through the local
   server. It runs instruction, unification, source criticism, the full debate,
   objections, votes, and judgment, then checks
   that every analyst participated. It prints the case URL and workflow run ID.
   You can supply your own claim with `npm run test:court -- "Your claim here"`.
   The test expects a factual claim, so opinion-only submissions fail its
   evidence and voting assertions even if the court correctly dismisses them.
4. Alternatively, sign in through the UI and submit text, a link, or an image.
   UI login needs the Auth0 variables and a callback registered for the local
   `APP_BASE_URL`; the terminal test doesn't need a browser login.
   For `returnTo=/`, logout uses the application origin without a trailing slash
   (for example `http://localhost:3000`). Register that exact URL in Auth0's
   [Allowed Logout URLs](https://auth0.com/docs/authenticate/login/logout/log-users-out-of-auth0#post_logout_redirect_uri-parameter);
   OIDC logout redirect URIs must match a registered URL.

`test:court` uses the same `.next/workflow-data/` directory as the local server; run
both from the project root. If using another port, set
`WORKFLOW_LOCAL_BASE_URL` for both processes. For CLI inspection, set
`WORKFLOW_LOCAL_DATA_DIR=.next/workflow-data` before running
`npx workflow inspect runs` or `npx workflow web`.

To check a completed run without creating another case, use
`npm run test:court -- --case <caseId> --run <workflowRunId>`. This checks the
record as it stands, including any historical absences. If overriding
`WORKFLOW_LOCAL_DATA_DIR`, use the same value for the server and test command.

Offline checks: `npm test`, `npm run typecheck`, and `npm run build`.
The dependency overrides in `package.json` address the Zod collection-validation
DoS (GHSA-mrhx-c7xc-m3w5), Undici 7.30.0 advisories, and the Minimatch glob
amplification DoS (GHSA-g3hv-75wg-m249). Some upstream packages pin affected
versions; remove the overrides when they adopt patched releases. The Minimatch
override crosses major versions, so check the dependent tooling and workflow
build when changing it.

The separate [verification tier pilot](evals/tiers/README.md) runs three curated
cases through real Gateway research, medium moderation with substantive escalation,
bounded follow-up research and all four evaluators. It separates task complexity
from evidence sufficiency, with English identifiers and Spanish reports.
Use `npm run test:evals` for offline checks and `npm run eval:tiers`
for the paid experiment. It does not change production court behavior.
`npm run eval:research` measures pipeline 3 native research in process (no
sandbox, no database writes): research latency, quotes matched to the fetched
sources, source review coverage and cost, from intake to source review, with
`--case`, `--out`, `--resume` and `--max-usd` (default 8). It is paid as well.
A running workflow can outlast a single HTTP request, but each step is bounded
by the hosting plan's function duration (300 seconds on Vercel Hobby). Shared
turns therefore run as many short steps: each decision generation (at most 150
seconds, or 240 for the prose decision of a pipeline 3 instruction filing or
source review, whose typed answer the host records in the next step) is a step of its own, and each preparation call runs detached in its
sandbox while steps of at most a minute wait for it. Retries stay in the
workflow: the court retries unfinished turns once, each attempt in steps of its
own, and the Workflow runtime retries failed steps. Legacy (pipeline 1) seat
attempts keep their 20-generation limit and 270-second timeout (override with
`COURT_TURN_TIMEOUT_MS`).
