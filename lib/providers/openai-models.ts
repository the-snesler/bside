/**
 * Source-controlled API-key model/reasoning defaults. The background replaces
 * model choices with the signed-in account's catalog for ChatGPT subscriptions.
 */

import type { ProviderDefinition } from "@/lib/domain/provider";

const OPENAI_MODELS = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
] as const;

export const OPENAI_PROVIDER = {
  id: "openai",
  name: "OpenAI",
  authMethods: [
    { id: "api-key", kind: "api-key", label: "OpenAI API key" },
    { id: "chatgpt", kind: "oauth", label: "ChatGPT subscription" },
  ],
  models: OPENAI_MODELS,
} as const satisfies ProviderDefinition;

export const DEFAULT_MODEL_ID = "gpt-5.6-terra";

/** Context windows of the bundled models, for account-catalog models Pi's catalog does not list. */
export const BUNDLED_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "gpt-5.6-sol": 272_000,
  "gpt-5.6-terra": 272_000,
  "gpt-5.6-luna": 272_000,
};
/** Conservative window for a model of unknown size; it only decides when history is summarized. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_REASONING_EFFORT = "medium";
