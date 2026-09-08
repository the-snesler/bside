/**
 * OpenAI boundary implemented with Pi AI. The adapter preserves the existing
 * privacy/request invariants and replaces Pi's detailed provider failures with
 * a small safe envelope before they can cross the background protocol.
 */

import {
  createAssistantMessageEventStream,
  hasApi,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type {
  ProviderAdapter,
  ProviderAuth,
  ProviderDefinition,
  ProviderTurnRequest,
} from "@/lib/domain/provider";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 8192;
const API_BASE_URL = "https://api.openai.com/v1";
const SAFE_ERROR_PREFIX = "bside-provider-error:";

export type ProviderErrorCode =
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "INVALID_REQUEST"
  | "TIMEOUT"
  | "NETWORK"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_FAILED";

interface SafeProviderError {
  code: ProviderErrorCode;
  message: string;
  status?: number;
  requestId?: string;
}

/** Already-normalized provider failure; never contains a raw response body. */
export class ProviderStreamError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;

  constructor(message: string, code: ProviderErrorCode, status?: number, requestId?: string) {
    super(message);
    this.name = "ProviderStreamError";
    this.code = code;
    this.retryable = code === "RATE_LIMIT" || code === "TIMEOUT" || code === "NETWORK" || code === "PROVIDER_UNAVAILABLE";
    this.status = status;
    this.requestId = requestId;
  }
}

const provider = openaiProvider();

export class OpenAIProvider implements ProviderAdapter {
  readonly definition: ProviderDefinition = OPENAI_PROVIDER;

  getModel(modelId: string): Model<Api> | null {
    return provider.getModels().find((candidate) => candidate.id === modelId) ?? null;
  }

  async validateAuth(auth: ProviderAuth, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${auth.secret}` },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new ProviderStreamError("The request was cancelled.", "TIMEOUT");
      throw new ProviderStreamError(error instanceof TypeError ? "Could not reach OpenAI." : "OpenAI authentication failed.", "NETWORK");
    }
    if (!response.ok) throw fromStatus(response.status, response.headers.get("x-request-id") ?? undefined);
  }

  streamTurn(request: ProviderTurnRequest, auth: ProviderAuth, signal: AbortSignal) {
    const output = createAssistantMessageEventStream();
    const responseMeta: { status?: number; requestId?: string } = {};
    let networkFailed = false;

    const safeFetch: typeof fetch = async (input, init) => {
      try {
        const response = await fetch(input, init);
        responseMeta.status = response.status;
        responseMeta.requestId = response.headers.get("x-request-id") ?? undefined;
        return response;
      } catch (error) {
        networkFailed = !signal.aborted;
        throw error;
      }
    };

    if (!hasApi(request.model, "openai-responses")) {
      throw new ProviderStreamError("The selected model is not compatible with OpenAI Responses.", "INVALID_REQUEST");
    }
    const source = provider.streamSimple(request.model, request.context, {
      apiKey: auth.secret,
      signal,
      fetch: safeFetch,
      reasoning: request.reasoningEffort === "none" ? undefined : request.reasoningEffort,
      maxTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      transport: "sse",
      onPayload: enforceRequestPolicy,
    });

    void (async () => {
      for await (const event of source) {
        if (event.type !== "error") {
          output.push(event);
          continue;
        }
        const normalized = signal.aborted
          ? new ProviderStreamError("The request was cancelled.", "TIMEOUT")
          : networkFailed
            ? new ProviderStreamError("Could not reach OpenAI.", "NETWORK")
            : responseMeta.status !== undefined
              ? fromStatus(responseMeta.status, responseMeta.requestId)
              : new ProviderStreamError("OpenAI did not complete the response.", "PROVIDER_RESPONSE_FAILED");
        output.push({ ...event, error: withSafeError(event.error, normalized) });
      }
      output.end();
    })();

    return output;
  }
}

/** Decode only envelopes produced here; arbitrary provider text stays generic. */
export function decodeProviderError(message: string | undefined): ProviderStreamError {
  if (message?.startsWith(SAFE_ERROR_PREFIX)) {
    try {
      const value = JSON.parse(message.slice(SAFE_ERROR_PREFIX.length)) as SafeProviderError;
      if (typeof value.message === "string" && isProviderErrorCode(value.code)) {
        return new ProviderStreamError(value.message, value.code, value.status, value.requestId);
      }
    } catch {
      // Fall through to the generic, non-sensitive message.
    }
  }
  return new ProviderStreamError("The provider did not complete the response.", "PROVIDER_RESPONSE_FAILED");
}

export function encodeProviderErrorMessage(error: ProviderStreamError): string {
  const safe: SafeProviderError = { code: error.code, message: error.message };
  if (error.status !== undefined) safe.status = error.status;
  if (error.requestId !== undefined) safe.requestId = error.requestId;
  return `${SAFE_ERROR_PREFIX}${JSON.stringify(safe)}`;
}

function enforceRequestPolicy(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  return { ...payload, store: false, parallel_tool_calls: false };
}

function withSafeError(message: AssistantMessage, error: ProviderStreamError): AssistantMessage {
  return { ...message, errorMessage: encodeProviderErrorMessage(error) };
}

function fromStatus(status: number, requestId?: string): ProviderStreamError {
  if (status === 401 || status === 403) return new ProviderStreamError("The OpenAI API key was rejected.", "AUTHENTICATION", status, requestId);
  if (status === 429) return new ProviderStreamError("OpenAI is rate limiting requests. Try again shortly.", "RATE_LIMIT", status, requestId);
  if (status === 408) return new ProviderStreamError("The OpenAI request timed out.", "TIMEOUT", status, requestId);
  if (status >= 400 && status < 500) return new ProviderStreamError("OpenAI rejected the request.", "INVALID_REQUEST", status, requestId);
  if (status >= 500) return new ProviderStreamError("OpenAI is temporarily unavailable.", "PROVIDER_UNAVAILABLE", status, requestId);
  return new ProviderStreamError("OpenAI did not complete the response.", "PROVIDER_RESPONSE_FAILED", status, requestId);
}

function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === "string" && [
    "AUTHENTICATION",
    "RATE_LIMIT",
    "INVALID_REQUEST",
    "TIMEOUT",
    "NETWORK",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_RESPONSE_FAILED",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
