import type { generateText } from "ai";
import type { Counsel, ModelSnapshot } from "../domain/court.ts";
import type { InstructionPhase } from "../instruction/authorization.ts";

export interface CourtModel {
  id: string;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}

// These limits apply to output per generation, not the input context window.
export type CourtOutputPhase = "research" | "debate";
export function courtOutputPhase(phase: InstructionPhase): CourtOutputPhase | undefined {
  return phase === "debate" ? "debate" : phase === "instruction" || phase === "criticism" ? "research" : undefined;
}

export function courtMaxOutputTokens(phase?: CourtOutputPhase, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const override = phase === "research" ? "RESEARCH_CONTEXT_SIZE" : phase === "debate" ? "DEBATE_CONTEXT_SIZE" : undefined;
  const key = override && env[override] ? override : "CONTEXT_SIZE";
  const value = env[key];
  if (value === undefined || value === "") return 32_000;
  const tokens = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(tokens) || tokens < 1) throw new Error(`${key} must be a positive integer`);
  return tokens;
}
export const MOCK_MODEL_ID = "court-fixture";

// Only report explicitly configured effort; provider defaults are not known.
export function modelEffort(model: CourtModel): string | null {
  const options = model.providerOptions as Record<string, Record<string, unknown>> | undefined;
  const provider = model.id.split("/", 1)[0];
  const value = provider === "spacexai" ? options?.xai?.reasoningEffort
    : provider === "google" ? (options?.google?.thinkingConfig as Record<string, unknown> | undefined)?.thinkingLevel
    : provider === "anthropic" ? options?.anthropic?.effort
    : provider === "openai" ? options?.openai?.reasoningEffort
    : undefined;
  return typeof value === "string" && value ? value : null;
}

// A model's provider options without the reasoning effort that courtModel
// sets, so that the portable `reasoning` call option applies instead.
export function withoutEffort(options: CourtModel["providerOptions"]): CourtModel["providerOptions"] {
  if (!options) return undefined;
  const copy = structuredClone(options) as Record<string, Record<string, unknown>>;
  delete copy.xai?.reasoningEffort;
  delete copy.anthropic?.effort;
  delete copy.openai?.reasoningEffort;
  const thinking = copy.google?.thinkingConfig as Record<string, unknown> | undefined;
  if (thinking) { delete thinking.thinkingLevel; if (!Object.keys(thinking).length) delete copy.google!.thinkingConfig; }
  for (const [key, value] of Object.entries(copy)) if (!Object.keys(value).length) delete copy[key];
  return Object.keys(copy).length ? copy as CourtModel["providerOptions"] : undefined;
}

// The inverse of modelEffort: the provider option that carries a reasoning
// effort through AI Gateway. Other providers keep their own default.
export function courtModel(id: string, effort?: string | null): CourtModel {
  if (!effort) return { id };
  const provider = id.split("/", 1)[0];
  const providerOptions: CourtModel["providerOptions"] = provider === "spacexai" ? { xai: { reasoningEffort: effort } }
    : provider === "google" ? { google: { thinkingConfig: { thinkingLevel: effort } } }
    : provider === "anthropic" ? { anthropic: { effort } }
    : provider === "openai" ? { openai: { reasoningEffort: effort } }
    : undefined;
  return providerOptions ? { id, providerOptions } : { id };
}

export const TIERS = ["fact", "comparison", "assessment"] as const;
export type TierName = (typeof TIERS)[number];

export type ModelRole =
  | "judge"
  | `counsel.${Counsel}`
  | "classifier"
  | "image.description"
  | "language"
  | "translator"
  | "research.x"
  | "cover.chooser"
  | "cover.check"
  | "cover.image"
  | "tier.evaluator"
  | `tier.${Counsel}.${TierName}`;

export type ModelKind = "language" | "image";

export interface ModelRoleDefinition {
  key: ModelRole;
  group: "Debate" | "Soporte" | "Evaluación por niveles";
  label: string;
  description: string;
  kind: ModelKind;
  defaultId: string;
  defaultEffort: string | null;
  // Tier evals pick the effort per experiment, and image models take none here.
  configurableEffort: boolean;
  // Gateway catalog tags the role relies on.
  requires: readonly string[];
  // The only provider whose models can fill the role, when a tool of the role is native to one.
  provider?: string;
}

const SEAT = ["tool-use", "vision"] as const;

const TIER_DEFAULTS: Record<Counsel, Record<TierName, string>> = {
  // The live Gateway catalog offers one general-purpose Grok; its cheaper lanes lower effort instead.
  grok: { fact: "spacexai/grok-4.7", comparison: "spacexai/grok-4.7", assessment: "spacexai/grok-4.7" },
  gemini: { fact: "google/gemini-3.8-flash", comparison: "google/gemini-3.8-flash", assessment: "google/gemini-4-argon" },
  claude: { fact: "anthropic/claude-haiku-5.5", comparison: "anthropic/claude-sonnet-5.5", assessment: "anthropic/claude-opus-5.5" },
  chatgpt: { fact: "openai/gpt-6-luna", comparison: "openai/gpt-6.1-terra", assessment: "openai/gpt-6.1-sol" },
};
const TIER_LABEL: Record<TierName, string> = { fact: "hechos", comparison: "comparación", assessment: "evaluación" };
const COUNSEL_LABEL: Record<Counsel, string> = { grok: "Grok", gemini: "Gemini", claude: "Claude", chatgpt: "ChatGPT" };

// AI Gateway catalog IDs, shared by execution and the recorded case events. These are
// the defaults; an admin can override each role from /admin.
export const MODEL_ROLES: readonly ModelRoleDefinition[] = [
  { key: "judge", group: "Debate", label: "Moderador", description: "Instruye el caso, resuelve objeciones, desempata y sintetiza las respuestas a preguntas.", kind: "language", defaultId: "spacexai/grok-4.7", defaultEffort: "high", configurableEffort: true, requires: SEAT },
  { key: "counsel.grok", group: "Debate", label: "Analista Grok", description: "Asiento de Grok en el panel.", kind: "language", defaultId: "spacexai/grok-4.7", defaultEffort: "high", configurableEffort: true, requires: SEAT },
  { key: "counsel.gemini", group: "Debate", label: "Analista Gemini", description: "Asiento de Gemini en el panel.", kind: "language", defaultId: "google/gemini-4-argon", defaultEffort: "high", configurableEffort: true, requires: SEAT },
  { key: "counsel.claude", group: "Debate", label: "Analista Claude", description: "Asiento de Claude en el panel.", kind: "language", defaultId: "anthropic/claude-opus-5.5", defaultEffort: "high", configurableEffort: true, requires: SEAT },
  { key: "counsel.chatgpt", group: "Debate", label: "Analista ChatGPT", description: "Asiento de ChatGPT en el panel.", kind: "language", defaultId: "openai/gpt-6.1-sol", defaultEffort: "high", configurableEffort: true, requires: SEAT },
  // Reads the material first, a submitted link or image included: its typed answer drives what the panel does.
  { key: "classifier", group: "Soporte", label: "Clasificador", description: "Decide si el material trae afirmaciones para chequear o preguntas para responder, e identifica cada una antes de que el panel investigue.", kind: "language", defaultId: "openai/gpt-6.1-terra", defaultEffort: "medium", configurableEffort: true, requires: ["structured-output", "vision", "tool-use"] },
  { key: "image.description", group: "Soporte", label: "Descripción de imágenes", description: "Describe y transcribe una sola vez la imagen enviada; el panel trabaja con esa descripción en lugar de la imagen.", kind: "language", defaultId: "openai/gpt-6.1-terra", defaultEffort: "high", configurableEffort: true, requires: ["structured-output", "vision"] },
  { key: "language", group: "Soporte", label: "Detección de idioma", description: "Identifica el idioma del material enviado, incluidas imágenes sin descripción.", kind: "language", defaultId: "anthropic/claude-haiku-5.5", defaultEffort: null, configurableEffort: true, requires: ["structured-output", "vision"] },
  { key: "translator", group: "Soporte", label: "Traductor", description: "Traduce las fuentes descargadas y la evidencia promovida al idioma del caso.", kind: "language", defaultId: "google/gemini-3.5-flash-lite", defaultEffort: null, configurableEffort: true, requires: ["structured-output"] },
  // x_search is native to Grok: the analysts and the cover chooser call it through this researcher, whatever their own model.
  { key: "research.x", group: "Soporte", label: "Búsqueda en X", description: "Investiga en X cuando un analista o la búsqueda de portada usan x_search. La búsqueda nativa en X solo existe en Grok.", kind: "language", defaultId: "spacexai/grok-4.7", defaultEffort: null, configurableEffort: true, requires: ["tool-use"], provider: "spacexai" },
  { key: "cover.chooser", group: "Soporte", label: "Portada: búsqueda", description: "Busca una imagen real para la portada o propone la ilustración.", kind: "language", defaultId: "spacexai/grok-4.7", defaultEffort: null, configurableEffort: true, requires: SEAT },
  { key: "cover.check", group: "Soporte", label: "Portada: revisión", description: "Mira la imagen real encontrada y la aprueba antes de usarla como portada.", kind: "language", defaultId: "anthropic/claude-haiku-5.5", defaultEffort: null, configurableEffort: true, requires: ["vision"] },
  { key: "cover.image", group: "Soporte", label: "Portada: ilustración", description: "Genera la ilustración cuando no hay una imagen real adecuada.", kind: "image", defaultId: "spacexai/grok-imagine-image-2.0", defaultEffort: null, configurableEffort: false, requires: [] },
  // The moderator of the tier eval: it routes each claim and is the role its face-off compares.
  { key: "tier.evaluator", group: "Evaluación por niveles", label: "Evaluador de nivel", description: "Decide el nivel de cada afirmación (hechos, comparación o evaluación) y si la evidencia alcanza, y resuelve los vacíos cuestionados. Solo cuando pide escalar pasa a esfuerzo alto.", kind: "language", defaultId: "openai/gpt-6.1-terra", defaultEffort: "medium", configurableEffort: true, requires: ["structured-output"] },
  ...(Object.keys(TIER_DEFAULTS) as Counsel[]).flatMap((by) => TIERS.map((tier): ModelRoleDefinition => ({
    key: `tier.${by}.${tier}`,
    group: "Evaluación por niveles",
    label: `${COUNSEL_LABEL[by]} · ${TIER_LABEL[tier]}`,
    description: "Modelo del eval de niveles (npm run eval:tiers); el esfuerzo lo fija cada experimento.",
    kind: "language",
    defaultId: TIER_DEFAULTS[by][tier],
    defaultEffort: null,
    configurableEffort: false,
    requires: [],
  }))),
];

export const MODEL_ROLE = Object.fromEntries(MODEL_ROLES.map((role) => [role.key, role])) as Record<ModelRole, ModelRoleDefinition>;

export type ModelConfig = Record<ModelRole, CourtModel>;

export interface ModelSetting {
  role: string;
  modelId: string;
  effort: string | null;
}

// Stored overrides on top of the defaults; rows for retired roles are ignored.
export function resolveModels(settings: readonly ModelSetting[] = []): ModelConfig {
  const config = Object.fromEntries(MODEL_ROLES.map((role) => [role.key, courtModel(role.defaultId, role.defaultEffort)])) as ModelConfig;
  for (const setting of settings) {
    const role = MODEL_ROLE[setting.role as ModelRole];
    if (role) config[role.key] = courtModel(setting.modelId, role.configurableEffort ? setting.effort : null);
  }
  return config;
}

export const DEFAULT_MODELS: ModelConfig = resolveModels();

// What a case records of the configuration: every role a session uses, not the tier evals.
export function modelSnapshot(config: ModelConfig): ModelSnapshot {
  return Object.fromEntries(MODEL_ROLES.filter((role) => role.group !== "Evaluación por niveles").map((role) => [role.key, { id: config[role.key].id, effort: modelEffort(config[role.key]) }]));
}

export function seatModel(models: ModelConfig, seat: Counsel | "judge"): CourtModel {
  return seat === "judge" ? models.judge : models[`counsel.${seat}`];
}

export function counselModels(models: ModelConfig): Record<Counsel, CourtModel> {
  return { grok: models["counsel.grok"], gemini: models["counsel.gemini"], claude: models["counsel.claude"], chatgpt: models["counsel.chatgpt"] };
}

export const JUDGE_MODEL: CourtModel = DEFAULT_MODELS.judge;
export const COUNSEL_MODELS: Record<Counsel, CourtModel> = counselModels(DEFAULT_MODELS);
