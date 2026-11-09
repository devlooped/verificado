import { databaseConfigured, getModelSettings } from "../store.ts";
import { fetchGatewayModels, type CatalogModel } from "../lib/gateway-catalog.ts";
import { latestModel, modelFamily } from "../lib/model-families.ts";
import { courtModel, MODEL_ROLES, modelEffort, resolveModels, type ModelConfig, type ModelSetting } from "./models.ts";

// Without a database (unit tests, some scripts) every role uses its default.
export async function loadModelSettings(): Promise<ModelSetting[]> {
  return databaseConfigured() ? getModelSettings() : [];
}

export async function loadModels(): Promise<ModelConfig> {
  const [settings, catalog] = await Promise.all([loadModelSettings(), fetchGatewayModels()]);
  return resolveLatestModels(settings, catalog);
}

// Settings and built-in defaults may still contain an old version. Their family
// is the configuration; only the concrete IDs returned here enter a case snapshot.
export function resolveFamilyModels(settings: readonly ModelSetting[]): ModelConfig {
  const models = resolveModels(settings);
  return Object.fromEntries(MODEL_ROLES.map((role) => {
    const model = models[role.key];
    return [role.key, courtModel(modelFamily(model.id), modelEffort(model))];
  })) as ModelConfig;
}

export function resolveLatestModels(settings: readonly ModelSetting[], catalog: readonly CatalogModel[]): ModelConfig {
  const families = resolveFamilyModels(settings);
  return Object.fromEntries(MODEL_ROLES.map((role) => {
    const configured = families[role.key];
    const latest = latestModel(configured.id, catalog.filter((model) => model.type === role.kind));
    if (!latest) throw new Error("No hay un modelo disponible para la familia " + configured.id + " (" + role.key + ").");
    return [role.key, courtModel(latest.id, modelEffort(configured))];
  })) as ModelConfig;
}
