import { describe, expect, it, vi } from "vitest";
import { McpClient, MCP_MAX_RESPONSE_BYTES, renderToolContent, type McpTokenSource } from "@/lib/mcp/client";
import { isAllowedUrl, mcpFetch, type Fetcher } from "@/lib/mcp/egress";
import { McpError, toNormalizedMcpError } from "@/lib/mcp/errors";
import { findMcpServer } from "@/lib/mcp/servers";

const notion = findMcpServer("notion")!;
const todoist = findMcpServer("todoist")!;

interface Sent { url: string; headers: Record<string, string>; body: { id?: number; method: string; params?: Record<string, unknown> } }

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

const event = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

/**
 * A fake MCP server: answers `initialize` with a session id, accepts the
 * initialized notification, and hands other requests to `handle`.
 */
function server(handle: (body: Sent["body"], sent: Sent) => Response | Promise<Response>, version = "2025-11-25") {
  const sent: Sent[] = [];
  const fetcher: Fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const request: Sent = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    sent.push(request);
    if (request.body.method === "initialize") {
      return json({ jsonrpc: "2.0", id: request.body.id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "fake" } } }, { "Mcp-Session-Id": "session-1" });
    }
    if (request.body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return handle(request.body, request);
  });
  return { fetcher, sent };
}

function tokens(overrides: Partial<McpTokenSource> = {}): McpTokenSource {
  return { token: vi.fn(async () => "access-1"), refresh: vi.fn(async () => "access-2"), ...overrides };
}

const signal = () => new AbortController().signal;

describe("MCP Streamable HTTP client", () => {
  it("initializes once, then sends the session id and protocol version with every request and follows list cursors", async () => {
    const fake = server((body) => body.params?.cursor === undefined
      ? json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "Find pages", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], nextCursor: "page-2" } })
      : json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "create-page", inputSchema: { type: "object" }, annotations: { destructiveHint: false } }, { name: 42 }] } }));
    const client = new McpClient(notion, fake.fetcher, tokens(), "1.0");
    const tools = await client.listTools(signal());
    expect(tools).toEqual([
      { name: "search", description: "Find pages", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "create-page", inputSchema: { type: "object" }, annotations: { destructiveHint: false } },
    ]);
    expect(fake.sent.map((request) => request.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(fake.sent[0]!.body.params).toMatchObject({ protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bside", version: "1.0" } });
    expect(fake.sent[0]!.headers).not.toHaveProperty("Mcp-Session-Id");
    for (const request of fake.sent.slice(1)) {
      expect(request.url).toBe("https://mcp.notion.com/mcp");
      expect(request.headers).toMatchObject({ Authorization: "Bearer access-1", "Mcp-Session-Id": "session-1", "MCP-Protocol-Version": "2025-11-25", Accept: "application/json, text/event-stream" });
    }
    expect(fake.sent[3]!.body.params).toEqual({ cursor: "page-2" });
    await client.listTools(signal());
    expect(fake.sent.filter((request) => request.body.method === "initialize")).toHaveLength(1);
  });

  it("reads a tool result from an SSE stream, skipping notifications and server requests, split across chunks", async () => {
    const fake = server((body) => {
      const stream = event({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) +
        event({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} }) +
        event({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Line 1\nLine 2" }] } });
      return sse([stream.slice(0, 40), stream.slice(40, 41), stream.slice(41)]);
    });
    const client = new McpClient(notion, fake.fetcher, tokens());
    await expect(client.callTool("search", { query: "plans" }, signal())).resolves.toEqual({ isError: false, text: "Line 1\nLine 2" });
    expect(fake.sent.at(-1)!.body).toMatchObject({ method: "tools/call", params: { name: "search", arguments: { query: "plans" } } });
  });

  it("accepts an older protocol version the server picks and refuses one bside does not speak", async () => {
    const older = server((body) => json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), "2025-03-26");
    await new McpClient(notion, older.fetcher, tokens()).listTools(signal());
    expect(older.sent.at(-1)!.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
    const newer = server(() => json({}), "2099-01-01");
    await expect(new McpClient(notion, newer.fetcher, tokens()).listTools(signal())).rejects.toMatchObject({ code: "PROTOCOL", message: expect.stringContaining("does not support") });
  });

  it("starts a new session once when the server answers 404 for the old one", async () => {
    let calls = 0;
    const fake = server((body) => (calls++ === 0 ? new Response(null, { status: 404 }) : json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })));
    await new McpClient(notion, fake.fetcher, tokens()).listTools(signal());
    expect(fake.sent.map((request) => request.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "initialize", "notifications/initialized", "tools/list"]);
  });

  it("refreshes the token once after a 401, and reports AUTH if the server still refuses", async () => {
    const source = tokens();
    let refused = 1;
    const fake = server((body, sent) => sent.headers.Authorization === "Bearer access-1" || refused-- > 1
      ? new Response("{\"error\":\"invalid_token secret-detail\"}", { status: 401 })
      : json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    await new McpClient(notion, fake.fetcher, source).listTools(signal());
    expect(source.refresh).toHaveBeenCalledExactlyOnceWith(expect.anything(), "access-1");
    expect(fake.sent.at(-1)!.headers.Authorization).toBe("Bearer access-2");

    const always = server(() => new Response("nope", { status: 401 }));
    const error = await new McpClient(notion, always.fetcher, tokens()).listTools(signal()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "AUTH", status: 401 });
    expect((error as Error).message).not.toContain("nope");
  });

  it("passes a REAUTH failure from the token source through untouched", async () => {
    const fake = server(() => new Response(null, { status: 401 }));
    const source = tokens({ refresh: vi.fn(async () => { throw new McpError("REAUTH", "Reconnect Notion in settings."); }) });
    await expect(new McpClient(notion, fake.fetcher, source).listTools(signal())).rejects.toMatchObject({ code: "REAUTH" });
  });

  it("turns JSON-RPC errors and HTTP failures into safe errors without response bodies", async () => {
    const rpc = server((body) => json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: `Bad args ${"x".repeat(2_000)}` } }));
    const error = await new McpClient(notion, rpc.fetcher, tokens()).callTool("search", {}, signal()).catch((caught: unknown) => caught) as McpError;
    expect(error).toMatchObject({ code: "RPC", message: "Notion rejected the request (code -32602)." });
    expect(error.detail).toHaveLength(500);

    for (const [status, code] of [[500, "PROVIDER_UNAVAILABLE"], [429, "PROVIDER_UNAVAILABLE"], [400, "PROVIDER_UNAVAILABLE"]] as const) {
      const failing = server(() => new Response("internal secret stack trace", { status, headers: { "X-Secret": "token-123" } }));
      const failure = await new McpClient(notion, failing.fetcher, tokens()).listTools(signal()).catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ code: "SERVER", status });
      const normalized = toNormalizedMcpError(failure);
      expect(normalized).toMatchObject({ code, status, phase: "setup" });
      expect(JSON.stringify(normalized)).not.toMatch(/secret|token-123/);
    }

    const offline = server(() => { throw new TypeError("NetworkError when attempting to fetch resource with token abc"); });
    const network = await new McpClient(notion, offline.fetcher, tokens()).listTools(signal()).catch((caught: unknown) => caught) as McpError;
    expect(network).toMatchObject({ code: "NETWORK", message: "Could not reach Notion." });

    const garbage = server(() => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }));
    await expect(new McpClient(notion, garbage.fetcher, tokens()).listTools(signal())).rejects.toMatchObject({ code: "PROTOCOL" });
    expect(toNormalizedMcpError(new Error("raw"))).toMatchObject({ code: "PROTOCOL_ERROR", message: "The connection could not complete. Try again." });
  });

  it("stops reading a response past the size cap", async () => {
    const chunk = `data: ${"x".repeat(100_000)}\n`;
    const fake = server(() => sse(Array.from({ length: Math.ceil(MCP_MAX_RESPONSE_BYTES / chunk.length) + 2 }, () => chunk)));
    await expect(new McpClient(notion, fake.fetcher, tokens()).callTool("search", {}, signal())).rejects.toMatchObject({ code: "TOO_LARGE" });
    const big = server(() => json({ padding: "y".repeat(MCP_MAX_RESPONSE_BYTES) }));
    await expect(new McpClient(notion, big.fetcher, tokens()).listTools(signal())).rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("cancels a call through its signal and tells the server", async () => {
    const controller = new AbortController();
    const fake = server((body) => {
      if (body.method === "notifications/cancelled") return new Response(null, { status: 202 });
      return new Promise<Response>((_resolve, reject) => {
        const init = vi.mocked(fake.fetcher).mock.lastCall![1];
        init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        controller.abort();
      });
    });
    await expect(new McpClient(notion, fake.fetcher, tokens()).callTool("create-page", {}, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    const call = fake.sent.find((request) => request.body.method === "tools/call")!;
    await vi.waitFor(() => expect(fake.sent.at(-1)!.body).toMatchObject({ method: "notifications/cancelled", params: { requestId: call.body.id } }));
  });
});

describe("MCP egress", () => {
  it("allows only HTTPS on the entry's own origins", () => {
    expect(isAllowedUrl("https://mcp.notion.com/token", notion.origins)).toBe(true);
    expect(isAllowedUrl("https://todoist.com/oauth/access_token", todoist.origins)).toBe(true);
    for (const url of ["https://todoist.com/oauth/access_token", "http://mcp.notion.com/mcp", "https://mcp.notion.com.evil.test/mcp",
      "https://user:pass@mcp.notion.com/mcp", "https://www.notion.so/", "not a url", "https://mcp.notion.com:8443/mcp"]) {
      expect(isAllowedUrl(url, notion.origins), url).toBe(false);
    }
  });

  it("refuses foreign URLs before fetching, and never follows redirects or sends cookies", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const egress = mcpFetch(notion, fetcher);
    await expect(egress("https://ai.todoist.net/mcp", { method: "POST" })).rejects.toMatchObject({ code: "EGRESS" });
    await expect(egress("https://api.openai.com/v1/models", {})).rejects.toBeInstanceOf(McpError);
    expect(fetcher).not.toHaveBeenCalled();
    await egress("https://mcp.notion.com/mcp", { method: "POST", credentials: "include", redirect: "follow" });
    expect(fetcher).toHaveBeenCalledWith("https://mcp.notion.com/mcp", expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
  });

  it("is the client's only path to the network", async () => {
    const fetcher = vi.fn(async () => new Response("ok"));
    const client = new McpClient({ ...notion, endpoint: "https://evil.test/mcp" }, mcpFetch(notion, fetcher), tokens());
    await expect(client.listTools(signal())).rejects.toMatchObject({ code: "EGRESS" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("MCP tool content", () => {
  it("renders text, embedded text resources, and placeholders for binary content", () => {
    expect(renderToolContent({ content: [
      { type: "text", text: "Found 2 pages" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "resource", resource: { uri: "notion://page/1", text: "Page body" } },
      { type: "resource", resource: { uri: "notion://file/2", blob: "AAAA" } },
      { type: "resource_link", name: "Roadmap", uri: "https://www.notion.so/roadmap" },
    ] })).toBe("Found 2 pages\n[image image/png, about 3 bytes; not shown]\n[resource notion://page/1]\nPage body\n[binary resource notion://file/2; not shown]\n[resource link: Roadmap https://www.notion.so/roadmap]");
    expect(renderToolContent({ content: [], structuredContent: { tasks: [{ id: "1" }] } })).toBe('{\n  "tasks": [\n    {\n      "id": "1"\n    }\n  ]\n}');
  });
});
