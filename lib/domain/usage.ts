/**
 * Token usage and estimated cost. Each run that reported tokens persists one
 * `run-usage` item when it ends; a turn's usage is the sum of its runs
 * (retries and steered rounds included), and each session's index entry keeps
 * a running total so the history list never rescans items.
 *
 * Dollars are estimates for the API-key path only, priced per provider
 * response from Pi's bundled model catalog (list prices, including its
 * long-context tiers) and fixed at run end, so later price changes never
 * reprice history. A ChatGPT-plan run, or an API-key run on a model without a
 * bundled price, records tokens with no cost.
 */

/** Usage of one run, all its provider responses (a compaction summary included). */
export interface RunUsageV1 {
  version: 1;
  runId: string;
  billing: "api-key" | "chatgpt";
  modelId: string;
  responses: number;
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output tokens, reasoning included. */
  output: number;
  reasoning: number;
  /** Estimated USD; `null` on the ChatGPT plan or for a model without a bundled price. */
  costUsd: number | null;
}

/** Summed usage of several runs: a turn's, or a session's running total. */
export interface UsageTotals {
  responses: number;
  /** Every input token, cached and cache-write ones included. */
  input: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  /** Estimated USD of the priced runs. */
  costUsd: number;
  pricedRuns: number;
  /** Runs billed to a ChatGPT plan. */
  planRuns: number;
  /** API-key runs on a model without a bundled price. */
  unpricedRuns: number;
}

export const EMPTY_USAGE: UsageTotals = Object.freeze({
  responses: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, costUsd: 0, pricedRuns: 0, planRuns: 0, unpricedRuns: 0,
});

/** A fresh, empty run usage. */
export function newRunUsage(runId: string, billing: RunUsageV1["billing"], modelId: string, priced: boolean): RunUsageV1 {
  return { version: 1, runId, billing, modelId, responses: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: priced ? 0 : null };
}

/** Whether a run reported any tokens; runs that did not leave no usage record. */
export function hasTokens(usage: RunUsageV1): boolean {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output > 0;
}

export function addRunUsage(totals: UsageTotals, usage: RunUsageV1): UsageTotals {
  return {
    responses: totals.responses + usage.responses,
    input: totals.input + usage.input + usage.cacheRead + usage.cacheWrite,
    cacheRead: totals.cacheRead + usage.cacheRead,
    output: totals.output + usage.output,
    reasoning: totals.reasoning + usage.reasoning,
    costUsd: totals.costUsd + (usage.costUsd ?? 0),
    pricedRuns: totals.pricedRuns + (usage.costUsd !== null ? 1 : 0),
    planRuns: totals.planRuns + (usage.billing === "chatgpt" ? 1 : 0),
    unpricedRuns: totals.unpricedRuns + (usage.billing === "api-key" && usage.costUsd === null ? 1 : 0),
  };
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const usd = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function isValidRunUsage(value: unknown): value is RunUsageV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.runId === "string" && v.runId.length <= 200 && (v.billing === "api-key" || v.billing === "chatgpt") &&
    typeof v.modelId === "string" && v.modelId.length <= 200 && [v.responses, v.input, v.cacheRead, v.cacheWrite, v.output, v.reasoning].every(count) &&
    (v.costUsd === null || (usd(v.costUsd) && v.billing === "api-key"));
}

export function isValidUsageTotals(value: unknown): value is UsageTotals {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return [v.responses, v.input, v.cacheRead, v.output, v.reasoning, v.pricedRuns, v.planRuns, v.unpricedRuns].every(count) && usd(v.costUsd);
}
