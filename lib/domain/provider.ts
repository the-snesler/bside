/**
 * Provider-facing contracts around Pi's transport-neutral model and stream
 * types. The background runtime owns credentials; providers receive them only
 * for one request and the rest of the extension never imports a provider SDK.
 */

import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";

export type ProviderId = "openai";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

export type ProviderAuth = { providerId: "openai"; method: "api-key" | "chatgpt"; secret: string };

export interface ChatGPTStatus {
  connected: boolean;
  email: string | null;
  /** One-time "Sign in with ChatGPT again" notice after the PIN-wrapped connection was removed. */
  signInAgain: boolean;
}

/** Persisted + wire-transmittable selection of provider/model/reasoning effort. */
export interface AppSettingsV1 {
  version: 1;
  providerId: "openai";
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

/** A model as a catalog lists it; the background adds its reasoning efforts from Pi's model metadata. */
export interface ModelListing {
  id: string;
  name: string;
}

export interface ModelDefinition extends ModelListing {
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
  getModel(modelId: string): Model<Api> | null;
  streamTurn(
    request: ProviderTurnRequest,
    auth: ProviderAuth,
    signal: AbortSignal,
  ): AssistantMessageEventStream;
}

export interface ProviderTurnRequest {
  model: Model<Api>;
  reasoningEffort: ReasoningEffort;
  context: Context;
  /** Conversation id used as the provider prompt-cache key; omitted for one-off requests. */
  sessionId?: string;
}
