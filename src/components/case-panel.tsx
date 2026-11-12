import { MODEL_ROLES } from "@/court/models.ts";
import { COUNSEL, modelDetail, type CaseRecord, type ModelUse, type SeatModels } from "@/domain/court.ts";
import { GavelIcon, ModelName } from "./marks.tsx";
import { CaseCost } from "./case-cost.tsx";
import type { CaseCosts } from "../domain/cost.ts";

function PanelModel({ model }: { model: ModelUse }) {
  return (
    <span className="block min-w-0">
      <span className="font-medium"><ModelName model={model} /></span>
      <span className="mt-0.5 block break-words font-mono text-[10px] leading-relaxed text-ink-soft">{modelDetail(model)}</span>
    </span>
  );
}

function PanelMember({ role, model }: { role: string; model: ModelUse }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
      <dt className="pt-0.5 text-xs text-ink-soft">{role}:</dt>
      <dd><PanelModel model={model} /></dd>
    </div>
  );
}

// The snapshot is a configuration, not a claim that every optional support role ran.
export function CasePanel({ c, models, costs, label = "Chequeo" }: { c: CaseRecord; models: SeatModels; costs?: CaseCosts; label?: string }) {
  const analysts = COUNSEL.flatMap((seat) => models[seat] ? [{ seat, model: models[seat]! }] : []);
  const support = MODEL_ROLES.filter((role) => role.group === "Soporte" && (role.key !== "image.description" || c.submission.kind === "image"))
    .flatMap((role) => c.models?.[role.key] ? [{ role, model: c.models[role.key]! }] : []);
  if (!models.judge && !analysts.length && !support.length) return null;

  return (
    <section aria-labelledby="case-panel-title" className="min-w-0 rounded-sm border border-rule bg-paper/60 p-5 text-sm">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-rule text-seal"><GavelIcon className="size-5" /></span>
        <div>
          <h2 id="case-panel-title" className="font-display text-2xl">Panel</h2>
          <p className="font-mono text-[10px] text-ink-soft">{label}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-3">
        {models.judge && <PanelMember role="Moderador" model={models.judge} />}
        {analysts.length > 0 && (
          <div className="border-t border-rule pt-3">
            <dt className="mb-2 text-xs text-ink-soft">Analistas:</dt>
            <dd className="grid grid-cols-2 gap-x-4 gap-y-3">
              {analysts.map(({ seat, model }) => <PanelModel key={seat} model={model} />)}
            </dd>
          </div>
        )}
      </dl>
      {support.length > 0 && (
        <details className="mt-4 border-t border-rule pt-3">
          <summary className="cursor-pointer text-xs text-celeste-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">Modelos de apoyo ({support.length})</summary>
          <p className="mt-2 text-xs text-ink-soft">Las funciones de apoyo se usan cuando hacen falta.</p>
          <dl className="mt-3 space-y-3">
            {support.map(({ role, model }) => <PanelMember key={role.key} role={role.label} model={model} />)}
          </dl>
        </details>
      )}
      {costs && <CaseCost costs={costs} />}
    </section>
  );
}
