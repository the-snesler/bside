import type { NormalizedError } from "@/lib/protocol";

/**
 * - `AUTH`: the server rejected bside's token (after one refresh) or sign-in failed.
 * - `REAUTH`: the saved connection can no longer be refreshed; the user must connect again.
 * - `RPC`: the server answered with a JSON-RPC error, so the request did not run.
 * - `EGRESS`: a URL outside the directory entry was refused before any request.
 */
export type McpErrorCode = "AUTH" | "REAUTH" | "NETWORK" | "TIMEOUT" | "CANCELLED" | "PROTOCOL" | "SERVER" | "TOO_LARGE" | "RPC" | "EGRESS" | "NOT_CONNECTED";

/**
 * A safe MCP failure: `message` never contains a response body, header, or
 * token. `detail` is the server's own JSON-RPC error text, bounded; it is
 * untrusted and only ever shown to the model, labeled as such.
 */
export class McpError extends Error {
  constructor(readonly code: McpErrorCode, message: string, readonly status?: number, readonly detail?: string) {
    super(message);
    this.name = "McpError";
  }
}

const NORMALIZED_CODES: Record<McpErrorCode, NormalizedError["code"]> = {
  AUTH: "AUTHENTICATION",
  REAUTH: "AUTHENTICATION",
  NOT_CONNECTED: "AUTHENTICATION",
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "TIMEOUT",
  PROTOCOL: "PROVIDER_RESPONSE_FAILED",
  SERVER: "PROVIDER_UNAVAILABLE",
  TOO_LARGE: "PROVIDER_RESPONSE_FAILED",
  RPC: "PROVIDER_RESPONSE_FAILED",
  EGRESS: "INVALID_REQUEST",
};

export function toNormalizedMcpError(error: unknown): NormalizedError {
  if (error instanceof McpError) {
    const code = NORMALIZED_CODES[error.code];
    return { code, message: error.message, retryable: code === "NETWORK" || code === "TIMEOUT" || code === "PROVIDER_UNAVAILABLE", phase: "setup",
      ...(error.status !== undefined ? { status: error.status } : {}) };
  }
  return { code: "PROTOCOL_ERROR", message: "The connection could not complete. Try again.", retryable: false, phase: "setup" };
}
