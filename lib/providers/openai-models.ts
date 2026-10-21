/**
 * Source-controlled API-key model list and defaults. The background replaces
 * the list with the signed-in account's catalog for ChatGPT subscriptions, and
 * adds each model's reasoning efforts from Pi's model metadata
 * (`describeModels` in `openai.ts`). This module stays free of Pi so the
 * sidebar and options pages can import it.
 */

import type { ModelListing, ProviderDefinition } from "@/lib/domain/provider";

export const OPENAI_MODELS: readonly ModelListing[] = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
];

/** The provider without its models; the background fills them in. Pages show it until the first settings response. */
export const OPENAI_PROVIDER = {
  id: "openai",
  name: "OpenAI",
  authMethods: [
    { id: "api-key", kind: "api-key", label: "OpenAI API key" },
    { id: "chatgpt", kind: "oauth", label: "ChatGPT subscription" },
  ],
  models: [],
} as const satisfies ProviderDefinition;

export const DEFAULT_MODEL_ID = "gpt-5.6-terra";

/** Conservative window for a model Pi's catalog does not list; it only decides when history is summarized. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_REASONING_EFFORT = "medium";
