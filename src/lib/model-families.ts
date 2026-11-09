import type { CatalogModel } from "./gateway-catalog.ts";

// Some providers attach the version directly to the name (qwen3, kimi-k2).
// Parameter sizes such as 70b are not versions. The o/v suffixes are flavors.
const VERSION = /(?:^|[-_.]|(?<=[a-z]))v?(\d+(?:[._-]\d+)*)([ov](?=-|$))?(?=-|$)/i;

// Strip the version, not the words around it: flash, lite, fast, vision, etc.
// A four-digit suffix is a dated revision, not a separate flavor.
export function modelFamily(id: string): string {
  const slash = id.indexOf("/");
  if (slash < 0) return id;
  const provider = id.slice(0, slash + 1);
  const model = id.slice(slash + 1)
    .replace(VERSION, (_match, _number: string, flavor: string | undefined) => flavor ? "-" + flavor : "")
    .replace(/-\d{4}(?=-|$)/g, "")
    .replace(/^-+|-+$/g, "");
  // Claude's Gateway IDs include the brand, while the configured families
  // use the familiar opus/sonnet/haiku names (also accept older short IDs).
  return provider + (provider === "anthropic/" ? model.replace(/^claude-/, "") : model);
}

function version(id: string): { parts: number[]; revision: number } {
  const model = id.slice(id.indexOf("/") + 1);
  const first = VERSION.exec(model);
  const revision = [...model.matchAll(/-(\d{4})(?=-|$)/g)].map((match) => Number(match[1])).at(-1) ?? 0;
  return { parts: first ? first[1]!.split(/[._-]/).map(Number) : [], revision };
}

// Version numbers are compared numerically, not lexicographically or by release date.
function newest(a: CatalogModel, b: CatalogModel): number {
  const av = version(a.id), bv = version(b.id);
  if (!av.parts.length || !bv.parts.length) return bv.parts.length - av.parts.length || a.id.localeCompare(b.id);
  for (let i = 0; i < Math.max(av.parts.length, bv.parts.length); i++) {
    const diff = (bv.parts[i] ?? 0) - (av.parts[i] ?? 0);
    if (diff) return diff;
  }
  return bv.revision - av.revision || a.id.localeCompare(b.id);
}

export function latestFamilyModels(catalog: readonly CatalogModel[]): CatalogModel[] {
  const families = new Map<string, CatalogModel>();
  for (const model of [...catalog].sort(newest)) {
    const id = modelFamily(model.id);
    const key = model.type + ":" + id;
    if (!families.has(key)) families.set(key, model);
  }
  return [...families.values()].map((model) => {
    const id = modelFamily(model.id);
    return { ...model, id, name: id };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function latestModel(id: string, catalog: readonly CatalogModel[]): CatalogModel | undefined {
  const family = modelFamily(id);
  return catalog.filter((model) => modelFamily(model.id) === family).sort(newest)[0];
}
