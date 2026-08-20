/**
 * Static, source-controlled OpenAI model/reasoning catalog. Provider
 * capabilities — not UI branches — supply model choices; the sidebar and
 * options selects read this definition rather than hardcoding options.
 *
 * Do not query `/models` to populate this catalog; `OpenAIProvider.validateAuth`
 * calls `models.list()` only to validate a new key.
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
  authMethods: [{ id: "api-key", kind: "api-key", label: "OpenAI API key" }],
  models: OPENAI_MODELS,
} as const satisfies ProviderDefinition;

export const DEFAULT_MODEL_ID = "gpt-5.6-terra";
export const DEFAULT_REASONING_EFFORT = "medium";
