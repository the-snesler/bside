import type { JsonValue } from "@/lib/domain/tools";

/** Browser services a site API may use; the runtime supplies the real ones, tests fake them. */
export interface SiteEnv {
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** A cookie's value for a URL, or null when absent or unreadable. */
  cookie(url: string, name: string): Promise<string | null>;
  now(): number;
}

/** Per-call services from the interpreter: cancellation and the run digest's visited URLs. */
export interface SiteCallContext {
  signal: AbortSignal;
  visit(url: string): void;
}

export type SiteMethod = (env: SiteEnv, args: JsonValue[], context: SiteCallContext) => Promise<JsonValue>;

/**
 * A closed set of read-only methods over one site's backend, exposed to
 * browser programs as a global (e.g. `youtube`). Every request goes to
 * `origin`, which is also the API's only `connect-src` entry.
 */
export interface SiteApi {
  name: string;
  origin: string;
  methods: Readonly<Record<string, SiteMethod>>;
}

/** A failure to report to the model; `code` follows the interpreter's ToolResult codes. */
export class SiteError extends Error {
  constructor(message: string, readonly code: "TARGET_MISSING" | "NAVIGATION_INTERRUPTED" | "INVALID_TOOL_ARGUMENTS" = "NAVIGATION_INTERRUPTED") { super(message); }
}

const RESPONSE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 8_000_000;

/** Fetches text with a timeout and size cap; any transport or HTTP failure becomes a safe SiteError. */
export async function fetchText(env: SiteEnv, url: string, init: RequestInit, context: SiteCallContext, label: string): Promise<{ status: number; text: string }> {
  context.signal.throwIfAborted();
  let response: Response;
  try {
    response = await env.fetch(url, { ...init, signal: AbortSignal.any([context.signal, AbortSignal.timeout(RESPONSE_TIMEOUT_MS)]) });
  } catch (error) {
    context.signal.throwIfAborted();
    throw new SiteError(`${label} did not respond${error instanceof DOMException && error.name === "TimeoutError" ? ` within ${RESPONSE_TIMEOUT_MS / 1000} s` : ""}. Retry once.`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new SiteError(`${label} returned an oversized response.`);
  return { status: response.status, text };
}

/** Rejects unknown option keys; returns the options record. */
export function options(value: JsonValue | undefined, allowed: readonly string[], method: string): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SiteError(`${method}() options must be an object.`, "INVALID_TOOL_ARGUMENTS");
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new SiteError(`Unsupported ${method}() option ${extra}; use ${allowed.join(", ")}.`, "INVALID_TOOL_ARGUMENTS");
  return value;
}

/** Drops undefined members so results stay JSON values. */
export function compact<T extends Record<string, JsonValue | undefined>>(record: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as never;
}
