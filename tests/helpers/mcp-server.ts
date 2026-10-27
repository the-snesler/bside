import { vi } from "vitest";
import type { OAuthPopup } from "@/lib/background/oauth-popup";
import type { Fetcher } from "@/lib/mcp/egress";
import { MCP_SERVERS } from "@/lib/mcp/servers";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface FakeRequest { url: string; method: string; body: string; headers: Record<string, string> }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/**
 * Fake directory servers behind one raw fetch: OAuth metadata, registration,
 * token, and revocation at each issuer, and a JSON-RPC MCP endpoint that
 * lists `tools[id]` and answers calls with `call(id, name, args)`.
 */
export function fakeMcpServers(options: {
  tools?: Record<string, FakeTool[]>;
  capabilities?: Record<string, unknown>;
  content?: (server: string, method: string, params: Record<string, unknown>) => unknown;
  call?: (server: string, name: string, args: unknown) => unknown;
  override?: (request: FakeRequest) => Response | Promise<Response> | undefined;
} = {}) {
  const requests: FakeRequest[] = [];
  const tools = options.tools ?? {};
  let issued = 0;
  const fetcher: Fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const request: FakeRequest = { url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : "", headers: (init.headers ?? {}) as Record<string, string> };
    requests.push(request);
    const overridden = await options.override?.(request);
    if (overridden) return overridden;
    const path = url.split("?")[0]!;
    for (const server of MCP_SERVERS) {
      const issuer = server.issuer;
      if (path === `${new URL(server.endpoint).origin}/.well-known/oauth-protected-resource${new URL(server.endpoint).pathname}`)
        return json({ resource: server.endpoint, authorization_servers: [issuer] });
      if (path === `${issuer}/.well-known/oauth-authorization-server`) return json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
        revocation_endpoint: `${issuer}/revoke`, code_challenge_methods_supported: ["S256"],
      });
      if (path === `${issuer}/register`) return json({ client_id: `client-${server.id}` });
      if (path === `${issuer}/token`) return json({ access_token: `access-${server.id}-${++issued}`, refresh_token: `refresh-${server.id}`, token_type: "bearer", expires_in: 3600 });
      if (path === `${issuer}/revoke`) return new Response(null, { status: 200 });
      if (path === server.endpoint) {
        const body = JSON.parse(request.body) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
        if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: options.capabilities ?? { tools: {} } } }, 200, { "Mcp-Session-Id": `s-${server.id}` });
        if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
        if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: (tools[server.id] ?? []).map((tool) => ({ inputSchema: { type: "object" }, ...tool })) } });
        if (/^(prompts|resources)\//.test(body.method)) {
          const result = options.content?.(server.id, body.method, (body.params ?? {}) as Record<string, unknown>) ?? {};
          return json({ jsonrpc: "2.0", id: body.id, ...(isRpcError(result) ? { error: result.error } : { result }) });
        }
        if (body.method === "tools/call") {
          const result = options.call?.(server.id, body.params!.name!, body.params!.arguments) ?? { content: [{ type: "text", text: "done" }] };
          return json({ jsonrpc: "2.0", id: body.id, ...(isRpcError(result) ? { error: result.error } : { result }) });
        }
      }
    }
    return new Response("not found", { status: 404 });
  });
  return { fetcher, requests };
}

function isRpcError(value: unknown): value is { error: unknown } {
  return typeof value === "object" && value !== null && "error" in value;
}

/** A sign-in popup that approves immediately. */
export function approvingPopup(): OAuthPopup {
  return {
    getRedirectURL: () => "https://abc123.extensions.allizom.org/",
    authorize: vi.fn(async (url: string, redirectUri: string) => `${redirectUri}?code=code&state=${new URL(url).searchParams.get("state")}`),
  };
}
