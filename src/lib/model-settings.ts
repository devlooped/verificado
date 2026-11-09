import { MODEL_ROLES, modelEffort, type ModelConfig, type ModelRole } from "../court/models.ts";
import type { CatalogModel } from "./gateway-catalog.ts";
import { modelFamily } from "./model-families.ts";

export type ModelChange = { role: ModelRole; setting: { modelId: string; effort: string | null } | null };
export type ModelSettingsResult = { ok: true; changes: ModelChange[] } | { ok: false; errors: Partial<Record<ModelRole, string>> };

const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i;
const EFFORT = /^[a-z]{1,16}$/;
const KIND_LABEL = { language: "de lenguaje", image: "de imagen" } as const;

export const modelField = (role: ModelRole) => role + ":model";
export const effortField = (role: ModelRole) => role + ":effort";

// Only roles whose value changed are checked against the catalog, so a model
// later retired from Gateway never blocks saving the others. A value equal to
// the default removes the override.
export function parseModelSettings(form: FormData, current: ModelConfig, catalog?: readonly CatalogModel[]): ModelSettingsResult {
  const changes: ModelChange[] = [];
  const errors: Partial<Record<ModelRole, string>> = {};
  for (const role of MODEL_ROLES) {
    const now = current[role.key];
    // An absent field keeps the current value; an empty one means the default
    // model, or the provider's own effort.
    const field = (name: string) => form.has(name) ? String(form.get(name)).trim() : undefined;
    const typedId = field(modelField(role.key));
    const defaultId = modelFamily(role.defaultId);
    const modelId = modelFamily(typedId === undefined ? now.id : typedId || defaultId);
    const typedEffort = role.configurableEffort ? field(effortField(role.key)) : null;
    const effort = typedEffort === undefined ? modelEffort(now) : typedEffort || null;
    if (modelId === modelFamily(now.id) && effort === (role.configurableEffort ? modelEffort(now) : null)) continue;
    if (modelId === defaultId && effort === role.defaultEffort) {
      changes.push({ role: role.key, setting: null });
      continue;
    }
    if (!MODEL_ID.test(modelId)) { errors[role.key] = "Usá un ID de AI Gateway, como proveedor/modelo."; continue; }
    if (role.provider && !modelId.startsWith(role.provider + "/")) { errors[role.key] = "Este rol solo admite modelos de " + role.provider + "."; continue; }
    if (effort && !EFFORT.test(effort)) { errors[role.key] = "Esfuerzo no válido."; continue; }
    const entry = catalog?.find((model) => model.id === modelId && model.type === role.kind)
      ?? catalog?.find((model) => model.id === modelId);
    if (catalog && !entry) { errors[role.key] = modelId + " no está en el catálogo de AI Gateway."; continue; }
    if (entry) {
      if (entry.type !== role.kind) { errors[role.key] = "Elegí un modelo " + KIND_LABEL[role.kind] + "."; continue; }
      const missing = entry.tags.length ? role.requires.filter((tag) => !entry.tags.includes(tag)) : [];
      if (missing.length) { errors[role.key] = "El modelo no declara: " + missing.join(", ") + "."; continue; }
      if (effort && entry.efforts.length && !entry.efforts.includes(effort)) { errors[role.key] = "El modelo acepta esfuerzo " + entry.efforts.join(", ") + "."; continue; }
    }
    changes.push({ role: role.key, setting: { modelId, effort } });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, changes };
}
