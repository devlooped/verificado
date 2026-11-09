import assert from "node:assert/strict";
import test from "node:test";
import { resolveFamilyModels, resolveLatestModels } from "./model-config.ts";
import { MODEL_ROLES, modelSnapshot } from "./models.ts";
import type { CatalogModel } from "../lib/gateway-catalog.ts";

const catalog: CatalogModel[] = MODEL_ROLES.map((role) => ({ id: role.defaultId, name: role.defaultId, type: role.kind, tags: [], efforts: [] }));
const entry = (id: string): CatalogModel => ({ id, name: id, type: "language", tags: [], efforts: [] });

test("legacy versions are read as families and resolved once for the case snapshot", () => {
  const settings = [{ role: "counsel.claude", modelId: "anthropic/claude-opus-4.7", effort: "high" },
    { role: "translator", modelId: "deepseek/deepseek-v4-flash", effort: null }];
  assert.equal(resolveFamilyModels(settings)["counsel.claude"].id, "anthropic/opus");
  assert.equal(resolveFamilyModels(settings).translator.id, "deepseek/deepseek-flash");
  const versions = [...catalog, entry("deepseek/deepseek-v4.1-flash"), entry("deepseek/deepseek-v9-pro")];
  const snapshot = modelSnapshot(resolveLatestModels(settings, versions));
  assert.equal(snapshot["counsel.claude"]?.id, "anthropic/claude-opus-5.5");
  assert.equal(snapshot.translator?.id, "deepseek/deepseek-v4.1-flash");
  assert.equal(snapshot["counsel.claude"]?.effort, "high");
  const next = modelSnapshot(resolveLatestModels(settings, [...versions, entry("deepseek/deepseek-v4.2-flash")]));
  assert.equal(next.translator?.id, "deepseek/deepseek-v4.2-flash");
  assert.equal(snapshot.translator?.id, "deepseek/deepseek-v4.1-flash");
});

test("a missing or wrong-kind family fails rather than falling back to another flavor", () => {
  assert.throws(() => resolveLatestModels([{ role: "translator", modelId: "deepseek/deepseek-flash", effort: null }], [...catalog, entry("deepseek/deepseek-v9-pro")]), /deepseek\/deepseek-flash/);
  const image = { ...entry("deepseek/deepseek-v9-flash"), type: "image" };
  assert.throws(() => resolveLatestModels([{ role: "translator", modelId: "deepseek/deepseek-flash", effort: null }], [...catalog, image]), /deepseek\/deepseek-flash/);
});
