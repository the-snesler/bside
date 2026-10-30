/**
 * Background-owned MCP connections: one OAuth client and one Streamable HTTP
 * client per directory server, the saved tool catalog and the user's choices
 * (`local:mcpServer:<id>`), options-page `mcp.*` requests, the tool snapshot a
 * run starts with, and the calls it makes. Tokens stay inside `McpAuth`;
 * nothing here returns them. See docs/mcp.md.
 */

import { findSecret } from "@/lib/domain/memory";
import { mcpPromptCommand, type McpContentChoice, type McpContentSnapshot, type McpContentDescriptor } from "@/lib/domain/mcp-content";
import { FirefoxOAuthPopup, type OAuthPopup } from "@/lib/background/oauth-popup";
import { clipMcpError, MAX_MCP_SERVER_TOOLS, MAX_MCP_TOOLS, type McpConnectionStatus, type McpServerStateV1, type McpServerStatus, type McpTrust } from "@/lib/domain/mcp";
import type { JsonValue } from "@/lib/domain/tools";
import { McpAuth, type McpRevocation } from "@/lib/mcp/auth";
import { McpClient, type McpCallOutcome, type McpTokenSource } from "@/lib/mcp/client";
import { mcpFetch, type Fetcher } from "@/lib/mcp/egress";
import { McpError, toNormalizedMcpError } from "@/lib/mcp/errors";
import { MCP_SERVERS, type McpServer } from "@/lib/mcp/servers";
import { enabledTotals, fitsUnderCaps, toolChars, toolDefinitions, toToolInfo, type McpToolDefinition } from "@/lib/mcp/tools";
import { isMcpRequest, type McpRequest, type McpResponse, type NormalizedError } from "@/lib/protocol";
import { getMcpServerState, saveMcpServerState } from "@/lib/storage";

interface Connection {
  server: McpServer;
  auth: McpAuth;
  client: McpClient;
}

export interface McpConnectionsOptions {
  popup?: OAuthPopup;
  /** The raw fetch; each server wraps it in its own egress check. */
  fetcher?: Fetcher;
  servers?: readonly McpServer[];
  clientVersion?: string;
}

export class McpConnections {
  #connections: Connection[];
  #content = new Map<string, Promise<McpContentChoice[]>>();
  #preparedGeneration = new Map<string, number>();
  #generation = new Map<string, number>();
  #choices = new Map<string, { choice: McpContentChoice; serverId: string }>();

  #invalidateContent(id: string): void {
    this.#generation.set(id, (this.#generation.get(id) ?? 0) + 1);
    this.#content.delete(`${id}:prompt`);
    this.#content.delete(`${id}:resource`);
    for (const [key, item] of this.#choices) if (item.serverId === id) this.#choices.delete(key);
  }

  /** Lazy, background-only discovery after an explicit composer interaction. */
  async contentCatalog(kind: "prompt" | "resource"): Promise<{ choices: McpContentChoice[]; errors: NormalizedError[] }> {
    const choices: McpContentChoice[] = [];
    const errors: NormalizedError[] = [];
    await Promise.all(this.#connections.map(async connection => {
      const { server, auth, client } = connection;
      if (this.#busy.has(server.id) || !await auth.connected()) return;
      const key = `${server.id}:${kind}`;
      let pending = this.#content.get(key);
      if (!pending) {
        const generation = this.#generation.get(server.id) ?? 0;
        pending = (async () => {
          const descriptors: McpContentDescriptor[] = await (kind === "prompt" ? client.listPrompts(AbortSignal.timeout(60_000)) : client.listResources(AbortSignal.timeout(60_000)));
          if (generation !== (this.#generation.get(server.id) ?? 0) || this.#busy.has(server.id) || !await auth.connected()) throw new McpError("NOT_CONNECTED", "That connection changed. Open the picker again.");
          return descriptors.map(descriptor => {
            const choice: McpContentChoice = { ...descriptor, id: crypto.randomUUID(), server: server.name, command: mcpPromptCommand(server.id, descriptor.name) };
            this.#choices.set(choice.id, { choice, serverId: server.id });
            return choice;
          });
        })();
        this.#content.set(key, pending);
        void pending.catch(() => { if (this.#content.get(key) === pending) this.#content.delete(key); });
      }
      try { choices.push(...await pending); }
      catch (error) { errors.push(toNormalizedMcpError(error)); }
    }));
    return { choices, errors };
  }

  async prepareContent(id: string, args: Record<string, string>, sessionId: string): Promise<McpContentSnapshot> {
    if (Object.values(args).some(value => findSecret(value))) throw new McpError("PROTOCOL", "Prompt arguments cannot contain secrets. Remove passwords, tokens, or payment details.");
    const entry = this.#choices.get(id);
    if (!entry) throw new McpError("PROTOCOL", "That MCP item is no longer available. Open the picker again.");
    const connection = this.#connection(entry.serverId);
    if (this.#busy.has(entry.serverId) || !await connection.auth.connected()) throw new McpError("NOT_CONNECTED", "That account is no longer available. Reconnect it in settings.");
    const { choice } = entry;
    const text = choice.kind === "prompt" ? await connection.client.getPrompt(choice.name, args, AbortSignal.timeout(60_000))
      : await connection.client.readResource(choice.uri, AbortSignal.timeout(60_000));
    if (this.#choices.get(id) !== entry || !await connection.auth.connected()) throw new McpError("NOT_CONNECTED", "That connection changed while preparing content. Choose it again.");
    const preparedId = crypto.randomUUID();
    this.#preparedGeneration.set(preparedId, this.#generation.get(entry.serverId) ?? 0);
    if (this.#preparedGeneration.size > 256) this.#preparedGeneration.delete(this.#preparedGeneration.keys().next().value!);
    return { version: 1, id: preparedId, sessionId, serverId: entry.serverId, server: choice.server, kind: choice.kind, name: choice.name,
      ...(choice.kind === "resource" ? { uri: choice.uri } : {}), text };
  }

  async contentAvailable(snapshot: McpContentSnapshot): Promise<boolean> {
    return this.#preparedGeneration.get(snapshot.id) === (this.#generation.get(snapshot.serverId) ?? 0) && !this.#busy.has(snapshot.serverId) && await this.#connection(snapshot.serverId).auth.connected();
  }

  /** Servers with a sign-in or disconnect in progress. */
  #busy = new Set<string>();
  #mutations: Promise<unknown> = Promise.resolve();

  constructor(options: McpConnectionsOptions = {}) {
    const popup = options.popup ?? new FirefoxOAuthPopup();
    const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.#connections = (options.servers ?? MCP_SERVERS).map((server) => {
      const egress = mcpFetch(server, fetcher);
      const auth = new McpAuth(server, popup, egress);
      const connection: Connection = { server, auth, client: null! };
      connection.client = new McpClient(server, egress, this.#tokens(connection), options.clientVersion);
      return connection;
    });
  }

  /** Every directory server as the Connections page shows it. */
  async list(): Promise<McpServerStatus[]> {
    return Promise.all(this.#connections.map(async ({ server, auth }) => {
      const state = await getMcpServerState(server.id);
      const connected = await auth.connected();
      const status: McpConnectionStatus = connected ? (state.error ? "error" : "connected") : state.needsReauth ? "needs-reauth" : "disconnected";
      const disabled = new Set(state.disabled);
      return {
        id: server.id, name: server.name, description: server.description, icon: server.icon, status,
        error: state.error, trust: state.trust, toolsAt: state.toolsAt,
        tools: state.tools.map((tool) => ({ ...tool, enabled: tool.unavailable === null && !disabled.has(tool.name) })),
      };
    }));
  }

  /** Tools enabled across connected servers, for the page's counter. */
  async enabledCount(): Promise<number> {
    return enabledTotals(await this.#connectedStates()).tools;
  }

  /** Signs in through the popup, then lists the server's tools. */
  async connect(id: string): Promise<void> {
    const connection = this.#connection(id);
    await this.#exclusive(id, async () => {
      this.#invalidateContent(id);
      await connection.auth.connect();
      connection.client.reset();
      await this.#update(id, (state) => ({ ...state, needsReauth: false, error: null }));
      await this.#listTools(connection);
    });
  }

  /** Revokes and deletes the tokens; the catalog is cleared, and the tool choices and trust level kept. */
  async disconnect(id: string): Promise<McpRevocation> {
    const connection = this.#connection(id);
    return this.#exclusive(id, async () => {
      this.#invalidateContent(id);
      const outcome = await connection.auth.disconnect();
      connection.client.reset();
      await this.#update(id, (state) => ({ ...state, tools: [], toolsAt: null, needsReauth: false, error: null }));
      return outcome;
    });
  }

  async refresh(id: string): Promise<void> {
    const connection = this.#connection(id);
    if (!await connection.auth.connected()) throw new McpError("NOT_CONNECTED", `${connection.server.name} is not connected.`);
    this.#invalidateContent(id);
    connection.client.reset();
    await this.#listTools(connection);
  }

  /** Turns one tool on or off. Turning one on past the caps is refused. */
  async toggleTool(id: string, tool: string, enabled: boolean): Promise<void> {
    const { server } = this.#connection(id);
    await this.#serialized(async () => {
      const state = await getMcpServerState(id);
      const info = state.tools.find((candidate) => candidate.name === tool);
      if (!info) throw new McpError("PROTOCOL", `${server.name} has no tool named ${JSON.stringify(tool.slice(0, 64))}. Refresh its tools.`);
      if (enabled && info.unavailable) throw new McpError("PROTOCOL", `${info.name} cannot be turned on: ${info.unavailable}`);
      const disabled = state.disabled.filter((name) => name !== tool);
      if (enabled && state.disabled.includes(tool)) {
        const totals = enabledTotals(await this.#connectedStates());
        if (!fitsUnderCaps(totals, toolChars(id, info))) {
          throw new McpError("PROTOCOL", `bside offers at most ${MAX_MCP_TOOLS} connected-account tools at once, within a size limit. Turn another tool off first.`);
        }
      }
      await saveMcpServerState(id, { ...state, disabled: enabled ? disabled : [...disabled, tool].slice(-MAX_MCP_SERVER_TOOLS) });
    });
  }

  async setTrust(id: string, trust: McpTrust): Promise<void> {
    this.#connection(id);
    await this.#update(id, (state) => ({ ...state, trust }));
  }

  /**
   * The tools a run offers, from the catalogs saved at connect or refresh time
   * and the user's choices, for servers that are connected now. `reserved`:
   * the built-in tool names, never reused.
   */
  async toolDefinitions(reserved: readonly string[] = []): Promise<McpToolDefinition[]> {
    return toolDefinitions(await this.#connectedStates(), reserved);
  }

  /** Calls a tool a run's snapshot offered. Throws `McpError`; `RPC` means the server did not run it. */
  async call(definition: McpToolDefinition, args: Record<string, JsonValue>, signal: AbortSignal): Promise<McpCallOutcome> {
    const connection = this.#connection(definition.serverId);
    if (!await connection.auth.connected()) throw new McpError("NOT_CONNECTED", `${connection.server.name} is no longer connected. The user can connect it again in bside's settings.`);
    return connection.client.callTool(definition.tool, args, signal);
  }

  async #listTools(connection: Connection): Promise<void> {
    const { server } = connection;
    let listed;
    try {
      listed = await connection.client.listTools(AbortSignal.timeout(60_000));
    } catch (error) {
      const message = error instanceof McpError ? error.message : `Could not list ${server.name}'s tools.`;
      await this.#update(server.id, (state) => ({ ...state, error: clipMcpError(message) }));
      throw error;
    }
    await this.#serialized(async () => {
      const state = await getMcpServerState(server.id);
      const tools = listed.slice(0, MAX_MCP_SERVER_TOOLS).map((descriptor) => toToolInfo(server, descriptor));
      const known = new Set(state.tools.map((tool) => tool.name));
      const disabled = new Set(state.disabled.filter((name) => tools.some((tool) => tool.name === name)));
      // New tools start on while they fit under the caps, off past them.
      const totals = enabledTotals((await this.#connectedStates()).filter((entry) => entry.server.id !== server.id));
      for (const tool of tools) {
        if (tool.unavailable || disabled.has(tool.name)) continue;
        if (!known.has(tool.name) || state.toolsAt === null) {
          const size = toolChars(server.id, tool);
          if (!fitsUnderCaps(totals, size)) {
            disabled.add(tool.name);
            continue;
          }
        }
        totals.tools += 1;
        totals.chars += toolChars(server.id, tool);
      }
      await saveMcpServerState(server.id, { ...state, tools, toolsAt: Date.now(), disabled: [...disabled], error: null, needsReauth: false });
    });
  }

  /** Bearer tokens for one server's client; a refresh that needs the user marks the server so settings can say so. */
  #tokens(connection: Connection): McpTokenSource {
    const marking = async <T>(action: () => Promise<T>): Promise<T> => {
      try { return await action(); }
      catch (error) {
        if (error instanceof McpError && error.code === "REAUTH") await this.#update(connection.server.id, (state) => ({ ...state, needsReauth: true }));
        throw error;
      }
    };
    return {
      token: (signal) => marking(() => connection.auth.token(signal)),
      refresh: (signal, rejected) => marking(() => connection.auth.refresh(signal, rejected)),
    };
  }

  async #connectedStates(): Promise<{ server: McpServer; state: McpServerStateV1 }[]> {
    const entries = await Promise.all(this.#connections.map(async ({ server, auth }) =>
      await auth.connected() ? [{ server, state: await getMcpServerState(server.id) }] : []));
    return entries.flat();
  }

  #connection(id: string): Connection {
    const connection = this.#connections.find((candidate) => candidate.server.id === id);
    if (!connection) throw new McpError("PROTOCOL", "bside does not know that connection.");
    return connection;
  }

  async #exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new McpError("AUTH", "That connection is already being changed. Wait for it to finish.");
    this.#busy.add(id);
    try { return await task(); }
    finally { this.#busy.delete(id); }
  }

  #update(id: string, change: (state: McpServerStateV1) => McpServerStateV1): Promise<void> {
    return this.#serialized(async () => saveMcpServerState(id, change(await getMcpServerState(id))));
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#mutations.then(task);
    this.#mutations = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

const REVOCATION_NOTICES: Record<McpRevocation, (name: string) => string | null> = {
  revoked: () => null,
  unconfirmed: (name) => `Disconnected. ${name} did not confirm that bside's access was revoked; you can also remove bside in ${name}'s own settings.`,
  unsupported: (name) => `Disconnected. ${name} offers no way for bside to revoke its access; you can remove bside in ${name}'s own settings.`,
};

/** Options-page `mcp.*` requests. Failures become safe messages; tokens are never part of a response. */
export async function handleMcpRequest(connections: McpConnections, request: McpRequest): Promise<McpResponse> {
  const { id } = request;
  if (!isMcpRequest(request)) return { v: 1, id, ok: false, error: { code: "INVALID_REQUEST", message: "Invalid connection request.", retryable: false, phase: "setup" } };
  let notice: string | null = null;
  try {
    if (request.type === "mcp.connect") await connections.connect(request.server);
    else if (request.type === "mcp.disconnect") {
      const name = MCP_SERVERS.find((server) => server.id === request.server)?.name ?? "The server";
      notice = REVOCATION_NOTICES[await connections.disconnect(request.server)](name);
    } else if (request.type === "mcp.refresh") await connections.refresh(request.server);
    else if (request.type === "mcp.tool.toggle") await connections.toggleTool(request.server, request.tool, request.enabled);
    else if (request.type === "mcp.trust.save") await connections.setTrust(request.server, request.trust);
    return { v: 1, id, ok: true, servers: await connections.list(), enabledTools: await connections.enabledCount(), maxTools: MAX_MCP_TOOLS, notice };
  } catch (error) {
    const normalized: NormalizedError = error instanceof McpError ? toNormalizedMcpError(error)
      : { code: "PROTOCOL_ERROR", message: "The connection could not be read or saved. Try again.", retryable: true, phase: "persistence" };
    if (!(error instanceof McpError)) console.warn("[bside] MCP request failed:", request.type);
    return { v: 1, id, ok: false, error: normalized };
  }
}
