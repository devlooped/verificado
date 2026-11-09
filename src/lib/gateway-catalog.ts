export interface CatalogModel {
  id: string;
  name: string;
  type: string;
  tags: string[];
  efforts: string[];
}

const MODELS_URL = "https://models.dev/api.json";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/models";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// Gateway metadata adds effort choices and capability tags; it does not determine
// which models belong to the models.dev Vercel catalog.
export function parseCatalog(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("El catálogo de AI Gateway no tiene el formato esperado.");
  return data.flatMap((entry): CatalogModel[] => {
    const model = entry as Record<string, unknown> | null;
    if (typeof model?.id !== "string") return [];
    const effort = Array.isArray(model.reasoning_options)
      ? (model.reasoning_options as Array<Record<string, unknown>>).find((option) => option?.type === "effort")
      : undefined;
    return [{ id: model.id, name: typeof model.name === "string" ? model.name : model.id,
      type: typeof model.type === "string" ? model.type : "", tags: strings(model.tags),
      efforts: strings(effort?.values).filter((value) => value !== "none") }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function parseModelsDev(body: unknown, gateway: readonly CatalogModel[] = []): CatalogModel[] {
  const models = (body as { vercel?: { models?: unknown } } | null)?.vercel?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("El catálogo de models.dev no tiene el formato esperado.");
  const metadata = new Map(gateway.map((model) => [model.id, model]));
  return Object.entries(models).flatMap(([id, value]): CatalogModel[] => {
    if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id) || !value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    const output = strings((model.modalities as { output?: unknown } | undefined)?.output);
    const extra = metadata.get(id);
    const type = extra?.type || (output.includes("image") ? "image" : output.includes("text") ? "language" : "");
    if (type !== "language" && type !== "image") return [];
    return [{ id, name: typeof model.name === "string" ? model.name : id, type, tags: extra?.tags ?? [], efforts: extra?.efforts ?? [] }];
  });
}

export async function fetchModelsDev(fetch: typeof globalThis.fetch = globalThis.fetch): Promise<CatalogModel[]> {
  const get = async (url: string) => {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("El catálogo respondió " + response.status + ".");
    return response.json();
  };
  const [body, gateway] = await Promise.all([get(MODELS_URL), get(GATEWAY_URL).then(parseCatalog).catch(() => [])]);
  const models = parseModelsDev(body, gateway);
  if (!models.length) throw new Error("El catálogo de models.dev está vacío.");
  return models;
}

// Shared per process, including CLI/workflow steps; coalesce concurrent reads.
// Keep the last successful snapshot on refresh failure, never cache a failure.
export function cachedCatalog(read: () => Promise<CatalogModel[]>, ttl = 3_600_000, now = Date.now): () => Promise<CatalogModel[]> {
  let value: CatalogModel[] | undefined, expires = 0, pending: Promise<CatalogModel[]> | undefined;
  return async () => {
    if (value && now() < expires) return value;
    if (!pending) pending = read().then((models) => {
      value = models; expires = now() + ttl; return models;
    }).catch((error: unknown) => {
      if (!value) throw error;
      console.warn("No se pudo actualizar el catálogo de modelos; se usa la última copia disponible.");
      expires = now() + Math.min(ttl, 60_000);
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

export const fetchGatewayModels = cachedCatalog(fetchModelsDev);
