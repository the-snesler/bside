/**
 * Provider-agnostic types for LLM inference: model/reasoning catalogs, auth,
 * and the streaming turn contract. Independent of WXT, Preact, Firefox, and
 * any specific provider SDK — a later provider adds one adapter and
 * definition here, never conditionals in sidebar/storage/agent-loop code.
 */

import type { ConversationItem } from "@/lib/domain/conversation";
import type { ContextArtifact, JsonValue, ToolCall, ToolDefinition } from "@/lib/domain/tools";

export type ProviderId = "openai";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderAuth = { providerId: "openai"; method: "api-key"; secret: string };

/** Persisted + wire-transmittable selection of provider/model/reasoning effort. */
export interface AppSettingsV1 {
  version: 1;
  providerId: "openai";
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export interface ModelDefinition {
  id: string;
  name: string;
  reasoningEfforts: readonly ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export interface AuthMethodDefinition {
  id: string;
  kind: "api-key" | "oauth" | "session";
  label: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  authMethods: readonly AuthMethodDefinition[];
  models: readonly ModelDefinition[];
}

export interface ProviderAdapter {
  readonly definition: ProviderDefinition;
  validateAuth(auth: ProviderAuth, signal: AbortSignal): Promise<void>;
  streamTurn(
    request: ProviderTurnRequest,
    auth: ProviderAuth,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}

export type ProviderEvent =
  | { type: "text.delta"; delta: string }
  | { type: "tool.call"; call: ToolCall }
  | { type: "turn.completed"; replayState: JsonValue };

export interface ProviderTurnRequest {
  modelId: string;
  reasoningEffort: ReasoningEffort;
  transcript: readonly ConversationItem[];
  contextArtifacts: readonly ContextArtifact[];
  replayState: JsonValue | null;
  tools: readonly ToolDefinition[];
}
