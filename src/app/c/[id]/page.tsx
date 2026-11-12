import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import CaseLoading from "@/components/case-loading.tsx";
import { notFound, permanentRedirect } from "next/navigation";
import { connection } from "next/server";
import { unstable_cache } from "next/cache";
import { Suspended } from "@/components/suspended.tsx";
import { Case, SessionDialogue } from "@/components/case.tsx";
import { EvidencePanel } from "@/components/evidence-panel.tsx";
import { CaseUpdates } from "@/components/case-updates.tsx";
import { GavelIcon } from "@/components/marks.tsx";
import { CaseResult } from "@/components/case-result.tsx";
import { SessionProgress } from "@/components/session-progress.tsx";
import { caseShareMetadata, submissionExcerpt } from "@/domain/case.ts";
import { caseDate, formatCaseDate } from "@/domain/case-date.ts";
import { caseCardImageUrl } from "@/domain/case-card.ts";
import { checkType, COUNSEL_NAMES, seatModels, type CaseRecord, type RecordedEvent } from "@/domain/court.ts";
import { project, sharedPipeline } from "@/domain/court.ts";
import type { ToolActivity } from "@/domain/tool-activity.ts";
import { displayHistoricalCitations } from "@/domain/historical-citations.ts";
import { blobConfigured, caseStorageExists, findEvidenceArchive, hasEvidenceBase } from "@/evidence/blob.ts";
import { auth0 } from "@/lib/auth0.ts";
import { canViewCaseCost } from "@/lib/case-access.ts";
import { detectMissingCaseStorage } from "@/lib/case-storage.ts";
import { caseProgressVersion } from "@/lib/case-event-stream.ts";
import { coverVersions, failResolvedCase, findCaseAlias, getCase, getCaseAuditRecords, getCaseToolActivities, getEvents, type StoredCaseRecord } from "@/store.ts";
import { usageCalls } from "@/domain/usage.ts";
import { caseCosts } from "@/domain/cost.ts";
import { loadTokenPrices } from "@/lib/model-costs.ts";

export async function generateMetadata(props: PageProps<"/c/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const c = await getCase(id);
  if (!c) return { title: "Che, bot" };
  const [events, covers] = c.status === "resolved"
    ? await Promise.all([getResolvedEvents(id, c.revision), coverVersions([id])])
    : [[], new Map<string, string>()];
  const { title, description } = caseShareMetadata(c, events);
  const image = c.status === "resolved" ? caseCardImageUrl(c.id, covers.get(c.id)) : undefined;
  return {
    metadataBase: new URL(process.env.APP_BASE_URL || "https://che.bot"),
    title,
    description,
    openGraph: { title, description, type: "article", ...(image && { images: [{ url: image, width: 720, height: 720, type: "image/jpeg", alt: title }] }) },
    twitter: { card: image ? "summary_large_image" : "summary", title, description, ...(image && { images: [image] }) },
  };
}

const date = (at: string) => new Date(at).toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" });

function InSession({ c, events, activities }: { c: StoredCaseRecord; events: RecordedEvent[]; activities: ToolActivity[] }) {
  const check = checkType(c.submission);
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <CaseUpdates caseId={c.id} version={caseProgressVersion({ status: c.status, revision: c.revision, seq: events.at(-1)?.seq ?? 0, activity: activities.length })} />
      <div className="inline-flex items-center gap-2 rounded-full border border-seal/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-seal">
        <span className="session-light size-2.5 rounded-full bg-seal" /> En curso
      </div>
      <div className="mx-auto mt-8 grid size-28 place-items-center rounded-full border-2 border-ink bg-paper/60">
        <GavelIcon className="gavel size-14 text-ink" />
      </div>
      <h1 className="mt-8 font-display text-5xl sm:text-6xl">El panel está analizando</h1>
      <blockquote className="mx-auto mt-5 line-clamp-3 max-w-lg break-words font-display text-2xl italic leading-snug text-ink">«{submissionExcerpt(c.submission)}»</blockquote>
      <p className="mt-2 text-sm text-ink-soft"> - <time dateTime={caseDate(c.createdAt)}>{formatCaseDate(caseDate(c.createdAt), c.submission.resolvedLanguage ?? (c.submission.language && c.submission.language !== "auto" ? c.submission.language : "es"))}</time></p>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">
        {COUNSEL_NAMES} están respondiendo tu consulta, cada uno con su propia búsqueda. Podés seguir el diálogo abajo; cuando terminen vas a ver el resultado y el registro completo.
      </p>
      <SessionProgress events={events} queued={c.status === "queued"} check={check} collectionProgress={c.pipelineVersion === 4 || c.pipelineVersion === 5} />
      <p className="mx-auto mt-6 max-w-md text-xs text-ink-soft">
        Esta página se actualiza sola. Podés cerrarla: el análisis sigue y el resultado queda en esta misma dirección.{" "}
        <Link href="/method" className="text-celeste-deep underline underline-offset-4">Cómo trabaja el panel</Link>
      </p>
      <p className="mt-6 font-mono text-xs text-ink-soft">Caso Nº {c.id}</p>
      {c.status === "in_session" && <SessionDialogue events={events} caseId={c.id} models={seatModels(c, events)} activities={activities} />}
    </section>
  );
}

export default async function CasePage(props: PageProps<"/c/[id]">) {
  await connection();
  const { id } = await props.params;
  const found = await getCase(id);
  if (!found) {
    const renamed = await findCaseAlias(id);
    if (renamed) permanentRedirect("/c/" + renamed);
    notFound();
  }
  const c = await detectMissingCaseStorage(found, { configured: blobConfigured, exists: caseStorageExists, fail: failResolvedCase });
  if (c.status === "queued" || c.status === "in_session") {
    const [events, activities] = c.status === "queued" ? [[], []] : await Promise.all([getEvents(id), getCaseToolActivities(id)]);
    return <div className="case-enter"><InSession c={c} events={events} activities={activities} /></div>;
  }
  if (c.status === "failed") {
    const session = await auth0.getSession();
    return <div className="case-enter"><Suspended c={c} user={session?.user} /></div>;
  }

  return <Suspense fallback={<CaseLoading />}><ResolvedCase c={c} id={id} revision={c.revision} /></Suspense>;
}

// Only closed cases use this cache; both the id and revision are part of the key.
const getResolvedEvents = unstable_cache(async (id: string, revision: number) => {
  void revision;
  return getEvents(id);
}, ["resolved-case-events-v1"], { revalidate: 3600 });

async function ResolvedCase({ c, id, revision }: { c: CaseRecord; id: string; revision: number }) {
  const [recordedEvents, session] = await Promise.all([getResolvedEvents(id, revision), auth0.getSession()]);
  const { events, aliases } = displayHistoricalCitations(recordedEvents);
  let costs;
  if (canViewCaseCost(session?.user)) {
    const calls = usageCalls(await getCaseAuditRecords(id));
    costs = caseCosts(calls, calls.length ? await loadTokenPrices() : {});
  }
  const hasEvidence = blobConfigured() && Boolean(await findEvidenceArchive(id) || await hasEvidenceBase(id));
  const simulated = events.some((e) => e.type === "session_opened" && e.simulated);
  const view = project(events);
  const models = seatModels(c, events);
  const quick = checkType(c.submission) === "quick";
  const questions = view.contentKind === "question";

  return (
    <div className="case-enter">
      <header className="reveal pt-4">
        <h1 className="font-mono text-xs uppercase tracking-widest text-ink-soft">Caso Nº {c.id} · {date(c.createdAt)}</h1>
        {view.dismissal && <p className="mt-2 font-display text-5xl">Caso descartado</p>}
      </header>

      {simulated && <p role="status" className="mt-4 rounded-sm border border-seal/40 bg-seal/5 p-4 text-sm text-seal">Simulación local: las fuentes, respuestas y el resultado son ficticios y solo sirven para probar el flujo.</p>}

      <CaseResult c={c} view={view} events={events} models={models} costs={costs} />

      <section className="mt-16">
        <div className="rule-double pt-4">
          <h2 className="font-display text-4xl">{quick ? "Respuestas de los analistas" : "Registro del debate"}</h2>
          <p className="mt-1 text-sm text-ink-soft">{questions ? "Cada respuesta completa, con las fuentes que citó su proveedor." : quick ? "Cada respuesta completa, con las fuentes que citó su proveedor, y luego los votos." : "Todo lo que pasó en el debate, completo y en orden."}</p>
        </div>
        <div className="mt-8">
          <Case events={events} view={view} caseId={id} sourceAliases={aliases} models={models} />
        </div>
      </section>

      {hasEvidence && <EvidencePanel caseId={id} settled={sharedPipeline(c.pipelineVersion)} quick={quick} />}
    </div>
  );
}
