export const USAGE_ROLES = ["moderator", "classifier", "analyst", "translator", "interpreter", "captioner", "x", "coverSearch", "coverReview", "imagine", "evaluator"] as const;
export type UsageRole = typeof USAGE_ROLES[number];

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageCall extends TokenUsage {
  provider: string;
  model: string;
  effort: string | null;
  role: UsageRole;
}

export interface UsageTotal extends UsageCall {
  calls: number;
  unknownUsageCalls: number;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tokens = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

// SDK usage has numeric totals; the raw Gateway protocol has nested totals.
// Missing totals stay unknown, never silently turn a paid call into a free one.
export function normalizeUsage(value: unknown): TokenUsage {
  const usage = object(value), input = object(usage.inputTokens), output = object(usage.outputTokens), details = object(usage.inputTokenDetails);
  const read = tokens(details.cacheReadTokens) ?? tokens(input.cacheRead) ?? 0;
  const write = tokens(details.cacheWriteTokens) ?? tokens(input.cacheWrite) ?? 0;
  return {
    inputTokens: tokens(usage.inputTokens) ?? tokens(input.total) ?? (tokens(input.noCache) !== null ? Number(input.noCache) + read + write : null),
    outputTokens: tokens(usage.outputTokens) ?? tokens(output.total) ?? (tokens(output.text) !== null ? Number(output.text) + (tokens(output.reasoning) ?? 0) : null),
    cacheReadTokens: read, cacheWriteTokens: write,
  };
}

export function usageCalls(records: readonly unknown[]): UsageCall[] {
  const seen = new Set<string>();
  return records.flatMap((value) => {
    const record = object(value), data = object(record.data);
    if (record.kind !== "model_step" || typeof record.modelId !== "string") return [];
    if (typeof record.id === "string") { if (seen.has(record.id)) return []; seen.add(record.id); }
    const role = USAGE_ROLES.includes(data.role as UsageRole) ? data.role as UsageRole
      : record.seat === "judge" ? "moderator" : record.seat === "classifier" ? "classifier" : typeof record.seat === "string" ? "analyst" : undefined;
    if (!role) return [];
    return [{ provider: record.modelId.includes("/") ? record.modelId.split("/")[0]! : "unknown", model: record.modelId, effort: typeof record.effort === "string" ? record.effort : null, role, ...normalizeUsage(data.usage) }];
  });
}

export function aggregateUsage(calls: readonly UsageCall[]): UsageTotal[] {
  const totals = new Map<string, UsageTotal>();
  for (const call of calls) {
    const key = JSON.stringify([call.provider, call.model, call.effort, call.role]);
    const row = totals.get(key) ?? { ...call, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, unknownUsageCalls: 0 };
    row.calls++;
    if (call.inputTokens === null || call.outputTokens === null) row.unknownUsageCalls++;
    row.inputTokens = row.inputTokens === null || call.inputTokens === null ? null : row.inputTokens + call.inputTokens;
    row.outputTokens = row.outputTokens === null || call.outputTokens === null ? null : row.outputTokens + call.outputTokens;
    row.cacheReadTokens += call.cacheReadTokens;
    row.cacheWriteTokens += call.cacheWriteTokens;
    totals.set(key, row);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

export function caseUsageArtifact(caseId: string, records: readonly unknown[]) {
  return { schemaVersion: 1, caseId, usage: aggregateUsage(usageCalls(records)) };
}
