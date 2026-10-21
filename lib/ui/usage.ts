/** Compact token and cost labels for turn footers and history rows. */

import type { UsageTotals } from "@/lib/domain/usage";

/** "950", "1.2k", "12.3k", "123k", "1.2M". */
export function formatTokens(tokens: number): string {
  const compact = (value: number, unit: string) => `${value < 100 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`;
  if (tokens < 1000) return String(tokens);
  if (tokens < 999_500) return compact(tokens / 1000, "k");
  return compact(tokens / 1_000_000, "M");
}

/** "$1.23", "$0.43", "$0.012", "$0.0004"; two significant digits below ten cents. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return "<$0.0001";
  const rounded = Number(usd.toPrecision(2));
  return rounded >= 0.1 ? `$${usd.toFixed(2)}` : `$${rounded}`;
}

const exact = (tokens: number) => tokens.toLocaleString("en-US");

/** Multi-line breakdown for a title tooltip. */
function breakdown(usage: UsageTotals): string {
  const lines = [
    `Input: ${exact(usage.input)} tokens${usage.cacheRead ? ` (${exact(usage.cacheRead)} cached)` : ""}`,
    `Output: ${exact(usage.output)} tokens${usage.reasoning ? ` (${exact(usage.reasoning)} reasoning)` : ""}`,
    `${usage.responses} ${usage.responses === 1 ? "response" : "responses"}`,
  ];
  if (usage.pricedRuns) lines.push(`Estimated cost: ${formatUsd(usage.costUsd)} at bundled list prices`);
  if (usage.planRuns) lines.push("Billed to your ChatGPT plan's usage, not in dollars");
  if (usage.unpricedRuns) lines.push("No price is bundled for the model of some runs, so they are not in the estimate");
  return lines.join("\n");
}

/** A turn's footer: "12.3k in (8.1k cached) · 1.2k out · ~$0.012", or "… · plan usage" on a ChatGPT plan. */
export function describeTurnUsage(usage: UsageTotals): { text: string; title: string } {
  const parts = [`${formatTokens(usage.input)} in${usage.cacheRead ? ` (${formatTokens(usage.cacheRead)} cached)` : ""}`, `${formatTokens(usage.output)} out`];
  if (usage.pricedRuns) parts.push(`~${formatUsd(usage.costUsd)}`);
  if (usage.planRuns) parts.push("plan usage");
  return { text: parts.join(" · "), title: breakdown(usage) };
}

/** A history row's total: "~$0.43" when any run was priced, else "1.2M tokens"; `null` before any usage. */
export function describeSessionUsage(usage: UsageTotals): { text: string; title: string } | null {
  if (usage.input + usage.output === 0) return null;
  const text = usage.pricedRuns ? `~${formatUsd(usage.costUsd)}` : `${formatTokens(usage.input + usage.output)} tokens`;
  return { text, title: `This chat's usage\n${breakdown(usage)}` };
}
