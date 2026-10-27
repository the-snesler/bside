/**
 * A small MCP client over Streamable HTTP: JSON-RPC POSTs answered with JSON
 * or an SSE stream, a session id and protocol version on every request after
 * `initialize`, bounded reads, timeouts, and cancellation. Every request goes
 * through the egress-checked fetch it is given. bside declares no client
 * capabilities, so server-to-client requests in a stream are ignored.
 */

import { MCP_CONTENT_LIMITS, readMcpPrompt, readMcpResource, validPromptArguments, contentRecord, type McpPrompt, type McpResource } from "@/lib/domain/mcp-content";
import type { JsonValue } from "@/lib/domain/tools";
import { McpError } from "@/lib/mcp/errors";
import type { Fetcher } from "@/lib/mcp/egress";
import type { McpServer } from "@/lib/mcp/servers";

/** Newest first; the first is offered, any is accepted in the reply. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_CALL_TIMEOUT_MS = 120_000;
export const MCP_MAX_RESPONSE_BYTES = 2_000_000;
const MAX_LIST_PAGES = 10;
const MAX_LISTED_TOOLS = 200;
const MAX_DETAIL_CHARS = 500;

/** A tool as the server lists it, shape-checked; descriptions and schemas are bounded later (see `lib/mcp/tools.ts`). */
export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallOutcome {
  /** The tool ran and reported failure (`isError`). */
  isError: boolean;
  /** Text content, structured content as JSON when there is no text, and placeholders for binary content. */
  text: string;
}

/** Bearer tokens for one server; `refresh` is called once after a 401 and fails with `REAUTH` when it cannot. */
export interface McpTokenSource {
  token(signal: AbortSignal): Promise<string>;
  refresh(signal: AbortSignal): Promise<string>;
}

interface Session {
  id: string | null;
  version: string;
  capabilities: Record<string, unknown>;
}

type RpcMessage = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };

class SessionExpired extends Error {}

export class McpClient {
  #server: McpServer;
  #fetch: Fetcher;
  #tokens: McpTokenSource;
  #clientVersion: string;
  #session: Session | null = null;
  #opening: Promise<Session> | null = null;
  #nextId = 1;
  #prompts: McpPrompt[] = [];
  #resources: McpResource[] = [];
  #generation = 0;

  constructor(server: McpServer, fetcher: Fetcher, tokens: McpTokenSource, clientVersion = "0") {
    this.#server = server;
    this.#fetch = fetcher;
    this.#tokens = tokens;
    this.#clientVersion = clientVersion;
  }

  /** Explicit connection/catalog reset (refresh, connect, disconnect). HTTP session recovery keeps authorization. */
  reset(): void {
    this.#generation++;
    this.#session = null;
    this.#opening = null;
    this.#prompts = [];
    this.#resources = [];
  }

  async listTools(signal: AbortSignal): Promise<McpToolDescriptor[]> {
    if (!contentRecord((await this.#open(signal)).capabilities.tools)) return [];
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.#request("tools/list", cursor === undefined ? {} : { cursor }, signal, MCP_REQUEST_TIMEOUT_MS);
      if (!isRecord(result) || !Array.isArray(result.tools)) throw this.#protocol("listed its tools in an unexpected format");
      for (const tool of result.tools) {
        const descriptor = readTool(tool);
        if (descriptor && !tools.some((other) => other.name === descriptor.name)) tools.push(descriptor);
        if (tools.length >= MAX_LISTED_TOOLS) return tools;
      }
      if (typeof result.nextCursor !== "string" || !result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async listPrompts(signal: AbortSignal): Promise<McpPrompt[]> {
    const generation = this.#generation;
    const prompts = await this.#listContent("prompts", readMcpPrompt, signal);
    if (generation !== this.#generation) throw this.#protocol("changed its catalog while loading; choose it again");
    return this.#prompts = prompts;
  }

  async listResources(signal: AbortSignal): Promise<McpResource[]> {
    const generation = this.#generation;
    const resources = await this.#listContent("resources", readMcpResource, signal);
    if (generation !== this.#generation) throw this.#protocol("changed its catalog while loading; choose it again");
    return this.#resources = resources;
  }

  async #listContent<T extends McpPrompt | McpResource>(kind: "prompts" | "resources", read: (v: unknown) => T | null, signal: AbortSignal): Promise<T[]> {
    if (!contentRecord((await this.#open(signal)).capabilities[kind])) return [];
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_CONTENT_LIMITS.pages; page++) {
      const result = await this.#request(`${kind}/list`, cursor === undefined ? {} : { cursor }, signal, MCP_REQUEST_TIMEOUT_MS);
      if (!isRecord(result) || !Array.isArray(result[kind])) throw this.#protocol("returned an invalid content catalog");
      for (const raw of result[kind]) {
        const item = read(raw);
        if (!item) continue;
        const key = item.kind === "prompt" ? item.name : item.uri;
        if (!seen.has(key)) { seen.add(key); items.push(item); }
        if (items.length >= MCP_CONTENT_LIMITS.entries) return items;
      }
      if (result.nextCursor === undefined) return items;
      if (typeof result.nextCursor !== "string" || result.nextCursor.length > 2_048) throw this.#protocol("returned an invalid catalog cursor");
      if (!result.nextCursor || result.nextCursor === cursor) return items;
      cursor = result.nextCursor;
    }
    return items;
  }

  async getPrompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<string> {
    const prompt = this.#prompts.find(p => p.name === name);
    if (!prompt || !validPromptArguments(prompt, args)) throw this.#protocol("cannot prepare that prompt with these arguments; choose it again");
    const result = await this.#request("prompts/get", { name, arguments: args }, signal, MCP_REQUEST_TIMEOUT_MS);
    if (!isRecord(result) || !Array.isArray(result.messages) || result.messages.length > 100) throw this.#protocol("returned an invalid prompt");
    const parts: string[] = [];
    for (const message of result.messages) {
      if (!isRecord(message) || !isRecord(message.content)) throw this.#protocol("returned an invalid prompt message");
      // Roles are deliberately discarded: this is one user-selected data snapshot.
      parts.push(renderSelectedContent(message.content));
    }
    return boundedSelectedText(parts.join("\n"));
  }

  async readResource(uri: string, signal: AbortSignal): Promise<string> {
    if (!this.#resources.some(r => r.uri === uri)) throw this.#protocol("cannot read a resource outside the selected catalog");
    // A resource URI is an MCP identifier, never a fetch destination.
    const result = await this.#request("resources/read", { uri }, signal, MCP_REQUEST_TIMEOUT_MS);
    if (!isRecord(result) || !Array.isArray(result.contents) || result.contents.length > 100) throw this.#protocol("returned an invalid resource");
    return boundedSelectedText(result.contents.map(item => {
      if (!isRecord(item) || typeof item.uri !== "string") throw this.#protocol("returned invalid resource contents");
      return typeof item.text === "string" ? item.text : "[Binary resource; not shown]";
    }).join("\n"));
  }

  /**
   * Calls a tool. A JSON-RPC error throws `RPC` (the server did not run it);
   * cancelling sends a best-effort `notifications/cancelled`.
   */
  async callTool(name: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<McpCallOutcome> {
    const result = await this.#request("tools/call", { name, arguments: args }, signal, MCP_CALL_TIMEOUT_MS);
    if (!isRecord(result) || !Array.isArray(result.content ?? [])) throw this.#protocol("returned a tool result in an unexpected format");
    return { isError: result.isError === true, text: renderToolContent(result) };
  }

  async #request(method: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.#open(signal);
      try {
        return await this.#rpc(session, method, params, signal, timeoutMs);
      } catch (error) {
        // The server dropped the session: start a new one, once.
        if (!(error instanceof SessionExpired) || attempt > 0) throw error instanceof SessionExpired ? this.#protocol("ended the session") : error;
        if (this.#session === session) {
          // Protocol sessions expire independently of the directory catalog.
          // Keep the authorized selections; explicit reset (refresh/disconnect) revokes them.
          this.#session = null;
          this.#opening = null;
        }
      }
    }
  }

  #open(signal: AbortSignal): Promise<Session> {
    if (this.#session) return Promise.resolve(this.#session);
    if (this.#opening) return this.#opening;
    const generation = this.#generation;
    const pending: Promise<Session> = this.#initialize(signal).then((session) => {
      if (generation !== this.#generation) throw this.#protocol("changed its connection while opening; try again");
      this.#session = session;
      return session;
    }).finally(() => {
      // An obsolete initialization must not clear a newer single-flight request.
      if (this.#opening === pending) this.#opening = null;
    });
    this.#opening = pending;
    return pending;
  }

  async #initialize(signal: AbortSignal): Promise<Session> {
    const pending: Session = { id: null, version: MCP_PROTOCOL_VERSIONS[0], capabilities: {} };
    const result = await this.#rpc(null, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: "bside", version: this.#clientVersion },
    }, signal, MCP_REQUEST_TIMEOUT_MS, pending);
    if (!isRecord(result) || typeof result.protocolVersion !== "string") throw this.#protocol("answered initialize in an unexpected format");
    if (!(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) throw this.#protocol("uses an MCP version which bside does not support");
    const session: Session = { id: pending.id, version: result.protocolVersion, capabilities: isRecord(result.capabilities) ? result.capabilities : {} };
    await this.#notify(session, "notifications/initialized", undefined, signal);
    return session;
  }

  async #notify(session: Session, method: string, params: Record<string, unknown> | undefined, signal: AbortSignal): Promise<void> {
    const response = await this.#post(session, { jsonrpc: "2.0", method, ...(params ? { params } : {}) },
      AbortSignal.any([signal, AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS)]), MCP_REQUEST_TIMEOUT_MS, signal);
    await response.body?.cancel().catch(() => {});
  }

  /** One JSON-RPC request and its response. `initialize` passes `capture` to receive the session id. */
  async #rpc(session: Session | null, method: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs: number, capture?: Session): Promise<unknown> {
    const id = this.#nextId++;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await this.#post(session, { jsonrpc: "2.0", id, method, params }, combined, timeoutMs, signal);
      if (capture) {
        const sessionId = response.headers.get("mcp-session-id");
        if (sessionId !== null && !/^[\x21-\x7e]{1,256}$/.test(sessionId)) throw this.#protocol("sent an invalid session id");
        capture.id = sessionId;
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const message = contentType.startsWith("text/event-stream") ? await this.#readStream(response, id)
        : contentType.startsWith("application/json") ? findResponse(parseJson(await readBounded(response, this.#server)), id)
        : null;
      if (!message) throw this.#protocol("sent no answer to the request");
      if (message.error !== undefined) {
        const detail = isRecord(message.error) && typeof message.error.message === "string" ? message.error.message.slice(0, MAX_DETAIL_CHARS) : undefined;
        const code = isRecord(message.error) && Number.isSafeInteger(message.error.code) ? ` (code ${message.error.code})` : "";
        throw new McpError("RPC", `${this.#server.name} rejected the request${code}.`, undefined, detail);
      }
      return message.result;
    } catch (error) {
      if (method === "tools/call" && signal.aborted) this.#cancelRemote(session, id);
      throw this.#readFailure(error, signal, timeout);
    }
  }

  /** POSTs one message, refreshing the token once after a 401. */
  async #post(session: Session | null, message: RpcMessage, signal: AbortSignal, timeoutMs: number, callerSignal: AbortSignal = signal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = attempt === 0 ? await this.#tokens.token(signal) : await this.#tokens.refresh(signal);
      const headers: Record<string, string> = {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`,
      };
      if (session?.id) headers["Mcp-Session-Id"] = session.id;
      if (session) headers["MCP-Protocol-Version"] = session.version;
      let response: Response;
      try {
        response = await this.#fetch(this.#server.endpoint, { method: "POST", headers, body: JSON.stringify(message), signal });
      } catch (error) {
        if (error instanceof McpError) throw error;
        if (callerSignal.aborted) throw new McpError("CANCELLED", `The ${this.#server.name} request was cancelled.`);
        if (signal.aborted) throw new McpError("TIMEOUT", `${this.#server.name} did not respond within ${Math.round(timeoutMs / 1000)} s.`);
        throw new McpError("NETWORK", `Could not reach ${this.#server.name}.`);
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        if (attempt === 0) continue;
        throw new McpError("AUTH", `${this.#server.name} rejected bside's sign-in. Reconnect it in settings.`, 401);
      }
      if (response.status === 404 && session?.id) {
        await response.body?.cancel().catch(() => {});
        throw new SessionExpired();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new McpError("SERVER", `${this.#server.name} is rate limiting requests. Try again shortly.`, 429);
        if (response.status >= 500) throw new McpError("SERVER", `${this.#server.name} is temporarily unavailable.`, response.status);
        throw new McpError("SERVER", `${this.#server.name} refused the request.`, response.status);
      }
      return response;
    }
  }

  /** Reads SSE events until the response to `id` arrives; notifications and server requests are skipped. */
  async #readStream(response: Response, id: number): Promise<RpcMessage | null> {
    let buffer = "";
    let data: string[] = [];
    for await (const text of readChunks(response, this.#server)) {
      buffer += text;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          const found = data.length ? findResponse(parseJson(data.join("\n")), id) : null;
          data = [];
          if (found) {
            await response.body?.cancel().catch(() => {});
            return found;
          }
        } else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
    return data.length ? findResponse(parseJson(data.join("\n")), id) : null;
  }

  #cancelRemote(session: Session | null, requestId: number): void {
    if (!session) return;
    void this.#notify(session, "notifications/cancelled", { requestId, reason: "The user cancelled the request." }, AbortSignal.timeout(5_000)).catch(() => {});
  }

  #readFailure(error: unknown, signal: AbortSignal, timeout: AbortSignal): unknown {
    if (error instanceof McpError || error instanceof SessionExpired) return error;
    if (signal.aborted) return new McpError("CANCELLED", `The ${this.#server.name} request was cancelled.`);
    if (timeout.aborted) return new McpError("TIMEOUT", `${this.#server.name} did not finish answering in time.`);
    return new McpError("NETWORK", `The connection to ${this.#server.name} broke before it answered.`);
  }

  #protocol(what: string): McpError {
    return new McpError("PROTOCOL", `${this.#server.name} ${what}.`);
  }
}

/** Decoded text of a response body, at most `MCP_MAX_RESPONSE_BYTES` bytes, read as it arrives. */
async function* readChunks(response: Response, server: McpServer): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MCP_MAX_RESPONSE_BYTES) throw tooLarge(server);
    yield text;
    return;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MCP_MAX_RESPONSE_BYTES) throw tooLarge(server);
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readBounded(response: Response, server: McpServer): Promise<string> {
  let text = "";
  for await (const chunk of readChunks(response, server)) text += chunk;
  return text;
}

function tooLarge(server: McpServer): McpError {
  return new McpError("TOO_LARGE", `${server.name} sent a response larger than ${MCP_MAX_RESPONSE_BYTES / 1_000_000} MB.`);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return undefined; }
}

/** The JSON-RPC response to `id` in a message or batch. */
function findResponse(value: unknown, id: number): RpcMessage | null {
  for (const message of Array.isArray(value) ? value : [value]) {
    if (isRecord(message) && message.jsonrpc === "2.0" && message.id === id && message.method === undefined &&
      ("result" in message || "error" in message)) return message as RpcMessage;
  }
  return null;
}

function readTool(value: unknown): McpToolDescriptor | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 128 || !isRecord(value.inputSchema)) return null;
  const annotations = isRecord(value.annotations) ? value.annotations : {};
  const hints: McpToolDescriptor["annotations"] = {};
  if (typeof annotations.readOnlyHint === "boolean") hints.readOnlyHint = annotations.readOnlyHint;
  if (typeof annotations.destructiveHint === "boolean") hints.destructiveHint = annotations.destructiveHint;
  const title = typeof value.title === "string" ? value.title : typeof annotations.title === "string" ? annotations.title : undefined;
  return {
    name: value.name,
    ...(title ? { title: title.slice(0, 120) } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    inputSchema: value.inputSchema,
    annotations: hints,
  };
}

/**
 * A tool result as text: text items in order, embedded text resources with
 * their URI, placeholders for images, audio, blobs, and links; structured
 * content as JSON when nothing else had text.
 */
export function renderToolContent(result: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image" || item.type === "audio") {
      const size = typeof item.data === "string" ? `, about ${Math.floor(item.data.length * 0.75).toLocaleString("en-US")} bytes` : "";
      parts.push(`[${item.type} ${typeof item.mimeType === "string" ? item.mimeType.slice(0, 64) : ""}${size}; not shown]`);
    } else if (item.type === "resource_link") parts.push(`[resource link: ${String(item.name ?? "").slice(0, 200)} ${String(item.uri ?? "").slice(0, 500)}]`);
    else if (item.type === "resource" && isRecord(item.resource)) {
      const uri = String(item.resource.uri ?? "").slice(0, 500);
      parts.push(typeof item.resource.text === "string" ? `[resource ${uri}]\n${item.resource.text}` : `[binary resource ${uri}; not shown]`);
    }
  }
  if (!parts.some((part) => part.trim()) && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2) ?? "";
  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderSelectedContent(item: Record<string, unknown>): string {
  if (item.type === "text" && typeof item.text === "string") return item.text;
  if (item.type === "resource" && isRecord(item.resource) && typeof item.resource.text === "string") return item.resource.text;
  return "[Non-text MCP content; not shown]";
}
function boundedSelectedText(text: string): string {
  if (text.length > MCP_CONTENT_LIMITS.text) throw new McpError("TOO_LARGE", "The selected MCP content exceeds 8,000 characters. Choose a smaller item.");
  return text || "[No text content]";
}
