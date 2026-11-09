"use client";

import { useActionState, useState } from "react";
import { saveModels, type ModelSettingsState } from "@/app/admin/actions.ts";
import type { ModelRole, ModelRoleDefinition } from "@/court/models.ts";
import type { CatalogModel } from "@/lib/gateway-catalog.ts";
import { effortField, modelField } from "@/lib/model-settings.ts";

export type ModelRow = ModelRoleDefinition & { modelId: string; effort: string | null; overridden: boolean };

const FALLBACK_EFFORTS = ["low", "medium", "high"];

function effortsFor(catalog: readonly CatalogModel[], modelId: string, current: string, kind: ModelRow["kind"]): string[] {
  const listed = catalog.find((model) => model.id === modelId && model.type === kind)?.efforts;
  const efforts = listed?.length ? listed : FALLBACK_EFFORTS;
  return current && !efforts.includes(current) ? [...efforts, current] : efforts;
}

function ModelField({ row, catalog, error, readOnly }: { row: ModelRow; catalog: readonly CatalogModel[]; error?: string; readOnly: boolean }) {
  const [modelId, setModelId] = useState(row.modelId);
  const [effort, setEffort] = useState(row.effort ?? "");
  const isDefault = modelId.trim() === row.defaultId && (!row.configurableEffort || (effort || null) === row.defaultEffort);
  const errorId = row.key + "-error";
  return (
    <div className="grid gap-x-4 gap-y-2 py-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div>
        <label htmlFor={modelField(row.key)} className="text-sm font-medium">{row.label}</label>
        <p className="mt-0.5 text-xs text-ink-soft">{row.description}</p>
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={modelField(row.key)}
            name={modelField(row.key)}
            list={"gateway-models-" + row.kind}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder={row.defaultId}
            readOnly={readOnly}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="min-w-0 flex-1 rounded-sm border border-rule bg-paper px-2.5 py-1.5 font-mono text-sm text-ink focus:border-celeste-deep focus:outline-none"
          />
          {row.configurableEffort && (
            <select
              name={effortField(row.key)}
              value={effort}
              onChange={(event) => setEffort(event.target.value)}
              disabled={readOnly}
              aria-label={"Esfuerzo de " + row.label}
              className="rounded-sm border border-rule bg-paper px-2 py-1.5 font-mono text-sm text-ink focus:border-celeste-deep focus:outline-none"
            >
              <option value="">por defecto</option>
              {effortsFor(catalog, modelId.trim(), effort, row.kind).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          )}
          {!readOnly && <button
            type="button"
            disabled={isDefault}
            onClick={() => { setModelId(row.defaultId); setEffort(row.defaultEffort ?? ""); }}
            className="rounded-sm border border-rule px-2.5 py-1.5 text-xs text-ink-soft transition hover:bg-paper-deep disabled:opacity-40"
          >
            Restablecer
          </button>}
        </div>
        <p className="mt-1 font-mono text-[11px] text-ink-soft">
          Predeterminado: {row.defaultId}{row.configurableEffort ? " · esfuerzo " + (row.defaultEffort ?? "por defecto") : ""}
          {row.overridden && <span className="ml-2 rounded-sm bg-celeste/15 px-1.5 py-0.5 text-celeste-deep">personalizado</span>}
        </p>
        {error && <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-falso">{error}</p>}
      </div>
    </div>
  );
}

export function ModelSettingsForm({ rows, catalog, readOnly = false }: { rows: ModelRow[]; catalog: CatalogModel[]; readOnly?: boolean }) {
  const [state, action, pending] = useActionState<ModelSettingsState, FormData>(saveModels, {});
  const groups = [...new Set(rows.map((row) => row.group))];
  return (
    <form action={readOnly ? undefined : action} className="mt-4">
      {(["language", "image"] as const).map((kind) => (
        <datalist key={kind} id={"gateway-models-" + kind}>
          {catalog.filter((model) => model.type === kind).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </datalist>
      ))}
      {groups.map((group) => (
        <fieldset key={group} className="mt-6 first:mt-0">
          <legend className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-soft">{group}</legend>
          <div className="divide-y divide-rule/60">
            {rows.filter((row) => row.group === group).map((row) => (
              // Remount after a save so each field starts from the stored value.
              <ModelField key={row.key + "=" + row.modelId + ":" + (row.effort ?? "")} row={row} catalog={catalog} error={state.errors?.[row.key as ModelRole]} readOnly={readOnly} />
            ))}
          </div>
        </fieldset>
      ))}
      {!readOnly && <div className="sticky bottom-0 mt-6 flex items-center gap-4 border-t border-rule bg-paper py-4">
        <button type="submit" disabled={pending} className="btn-primary rounded-sm px-4 py-2 text-sm font-medium disabled:opacity-60">
          {pending ? "Guardando…" : "Guardar"}
        </button>
        <p role="status" className="text-sm text-ink-soft">
          {state.error ?? (state.errors ? "Revisá los campos marcados." : state.saved === undefined ? "" : state.saved ? "Configuración guardada." : "No había cambios.")}
        </p>
      </div>}
    </form>
  );
}
