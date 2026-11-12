import Link from "next/link";
import { connection } from "next/server";
import { submissionExcerpt, VERDICT_LABEL } from "@/domain/case.ts";
import { caseCardImageUrl } from "@/domain/case-card.ts";
import { checkType, COUNSEL, MODEL_NAME, project, seatModels, type CaseRecord, type ClaimView, type SeatModels } from "@/domain/court.ts";
import { GavelIcon, VERDICT_TEXT, VoteChip } from "@/components/marks.tsx";
import { voteId } from "@/components/case-result.tsx";
import { auth0 } from "@/lib/auth0.ts";
import { canDeleteCase } from "@/lib/case-access.ts";
import { REQUEST_PANEL_ID } from "@/lib/request-panel.ts";
import { CaseLinkStatus } from "@/components/case-link-status.tsx";
import { DeleteCaseButton } from "@/components/delete-case-button.tsx";
import { coverVersions, getEvents, listCases } from "@/store.ts";

const MAX_CLAIMS = 3;
const caseHref = (id: string) => "/c/" + id;
const shortDate = (at: string) => new Date(at).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" });

function CoverImage({ c, cover }: { c: CaseRecord; cover?: string }) {
  const src = c.status === "resolved" ? caseCardImageUrl(c.id, cover) : c.submission.kind === "image" ? caseHref(c.id) + "/image" : cover ? caseHref(c.id) + "/cover?v=" + cover : undefined;
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.03] motion-reduce:transform-none motion-reduce:transition-none" />;
  }
  return (
    <div className="flex size-full flex-col bg-paper-deep px-5 pb-20 pt-12">
      <span aria-hidden className="font-display text-7xl leading-none text-celeste-deep/50">«</span>
      <p className="mt-2 line-clamp-5 font-display text-xl italic leading-snug text-ink-soft">{submissionExcerpt(c.submission)}</p>
    </div>
  );
}

// Cases without a generated card still show their current status.
function OutcomeStamp({ c }: { c: CaseRecord }) {
  const stamp = "inline-flex items-center gap-2 rounded-sm border border-ink/80 bg-paper/95 px-3 py-1.5 shadow-[3px_3px_0_0_var(--color-ink)]";
  if (c.status === "queued" || c.status === "in_session") {
    return (
      <span className={stamp + " text-xs font-semibold uppercase tracking-wider text-seal"}>
        <span className="session-light size-2 rounded-full bg-seal" /> En curso
      </span>
    );
  }
  return c.status === "failed" ? <span className={stamp + " text-xs uppercase tracking-wider text-ink-soft"}>Interrumpido</span> : null;
}

function ClaimLine({ c, claim, voted, models }: { c: CaseRecord; claim: ClaimView; voted: boolean; models: SeatModels }) {
  const j = claim.judgment;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <Link href={caseHref(c.id) + "#" + claim.id} className="line-clamp-3 font-display text-lg leading-snug transition hover:text-celeste-deep">
        {claim.text}<CaseLinkStatus />
      </Link>
      {voted && (
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-label="Votos de los analistas">
            {COUNSEL.map((m) => {
              const vote = claim.votes[m];
              return vote ? (
                <Link key={m} href={caseHref(c.id) + "#" + voteId(claim.id, m)} aria-label={"Fundamento de " + MODEL_NAME[m] + ": " + VERDICT_LABEL[vote.verdict]} className="rounded-full transition hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep">
                  <VoteChip model={m} verdict={vote.verdict} used={models[m]} /><CaseLinkStatus />
                </Link>
              ) : (
                <VoteChip key={m} model={m} used={models[m]} />
              );
            })}
          </div>
          {j && (
            <Link href={caseHref(c.id) + "#" + claim.id} className="flex shrink-0 items-center gap-1.5 text-right hover:underline">
              {j.method === "judge" && (
                <span title="Desempate del moderador" className="text-seal">
                  <GavelIcon className="size-4" />
                </span>
              )}
              <span className={"font-display text-xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</span><CaseLinkStatus />
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

async function CaseCard({ c, cover, index, admin }: { c: CaseRecord; cover?: string; index: number; admin: boolean }) {
  const events = c.status === "queued" ? [] : await getEvents(c.id);
  const view = c.status === "queued" ? undefined : project(events);
  const models = seatModels(c, events);
  const voted = c.status === "resolved";
  const claims = view?.claims ?? [];
  const hidden = claims.length - MAX_CLAIMS;
  return (
    <li className="reveal" style={{ animationDelay: Math.min(index, 4) * 45 + "ms" }}>
      <article className="relative flex h-full flex-col overflow-hidden rounded-sm border border-rule bg-paper/70 shadow-[0_1px_0_0_var(--color-rule)]">
        {admin && <DeleteCaseButton caseId={c.id} active={c.status === "queued" || c.status === "in_session"} rerunnable={checkType(c.submission) === "quick"} />}
        <Link href={caseHref(c.id)} aria-label={"Ver el caso Nº " + c.id} className="group relative block aspect-square overflow-hidden border-b border-rule bg-paper-deep">
          <CoverImage c={c} cover={cover} />
          <CaseLinkStatus />
          {c.status !== "resolved" && (
            <>
              <span className="absolute left-3 top-3 rounded-sm bg-paper/90 px-2 py-1 font-mono text-[11px] text-ink-soft">Nº {c.id}</span>
              <span className="absolute bottom-3 left-3 right-3">
                <OutcomeStamp c={c} />
              </span>
            </>
          )}
        </Link>
        <div className="flex flex-1 flex-col p-4">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">
            {shortDate(c.createdAt)} · {view?.contentKind === "question" ? (view.questions.length ? view.questions.length + (view.questions.length === 1 ? " pregunta" : " preguntas") : "Consulta") : claims.length ? claims.length + (claims.length === 1 ? " afirmación" : " afirmaciones") : "Material"}
          </p>
          <div className="mt-2 flex-1">
            {view?.dismissal ? (
              <p className="line-clamp-4 text-sm leading-relaxed text-ink-soft">{view.dismissal}</p>
            ) : claims.length ? (
              <ol className="divide-y divide-rule">
                {claims.slice(0, MAX_CLAIMS).map((claim) => <ClaimLine key={claim.id} c={c} claim={claim} voted={voted} models={models} />)}
              </ol>
            ) : view?.questions.length ? (
              <ol className="divide-y divide-rule">
                {view.questions.slice(0, MAX_CLAIMS).map((question) => (
                  <li key={question.id} className="py-3 first:pt-0 last:pb-0">
                    <Link href={caseHref(c.id) + "#" + question.id} className="line-clamp-3 font-display text-lg leading-snug transition hover:text-celeste-deep">
                      {question.text}<CaseLinkStatus />
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="line-clamp-3 font-display text-lg italic leading-snug text-ink-soft">«{submissionExcerpt(c.submission)}»</p>
            )}
          </div>
          <Link href={caseHref(c.id)} className="mt-4 self-start text-sm text-celeste-deep hover:underline">
            {view?.contentKind === "question" ? "Ver respuestas y síntesis →" : hidden > 0 ? "Ver " + hidden + (hidden === 1 ? " afirmación más" : " afirmaciones más") + " y el debate →" : "Ver fundamentos y debate →"}<CaseLinkStatus />
          </Link>
        </div>
      </article>
    </li>
  );
}

export default async function Home() {
  await connection();
  const [cases, session] = await Promise.all([listCases(24), auth0.getSession()]);
  const covers = await coverVersions(cases.map((c) => c.id));
  return (
    <section className="pt-8">
      {cases.length === 0 ? (
        <p className="mt-4 text-ink-soft">
          Todavía no hay casos.{" "}
          <button type="button" popoverTarget={REQUEST_PANEL_ID} className="text-celeste-deep underline underline-offset-4">
            Pedí el primero.
          </button>
        </p>
      ) : (
        <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {cases.map((c, i) => (
            <CaseCard key={c.id} c={c} cover={covers.get(c.id)} index={i} admin={canDeleteCase(session?.user)} />
          ))}
        </ul>
      )}
    </section>
  );
}
