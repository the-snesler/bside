import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPopup } from "@/lib/background/oauth-popup";
import { ProviderStreamError } from "@/lib/providers/openai";
import { McpAuth } from "@/lib/mcp/auth";
import { mcpFetch, type Fetcher } from "@/lib/mcp/egress";
import { McpError } from "@/lib/mcp/errors";
import { findMcpServer, type McpServer } from "@/lib/mcp/servers";
import { getMcpSecret, saveMcpSecret } from "@/lib/storage";

const notion = findMcpServer("notion")!;
const todoist = findMcpServer("todoist")!;
const signal = () => new AbortController().signal;

interface Request { url: string; method: string; body: string; init: RequestInit }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A fake directory server: RFC 9728 and RFC 8414 metadata, registration,
 * token, and revocation. `handlers` override a path; every request is
 * recorded after the egress check.
 */
function fakeServer(server: McpServer, handlers: Record<string, (request: Request) => Response | Promise<Response>> = {}) {
  const issuer = server.issuer;
  const requests: Request[] = [];
  let issued = 0;
  const defaults: Record<string, (request: Request) => Response | Promise<Response>> = {
    [`${new URL(server.endpoint).origin}/.well-known/oauth-protected-resource${new URL(server.endpoint).pathname}`]: () =>
      json({ resource: server.endpoint, authorization_servers: [issuer], scopes_supported: ["read", "write"] }),
    [`${issuer}/.well-known/oauth-authorization-server`]: () => json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`, code_challenge_methods_supported: ["S256"], response_types_supported: ["code"],
    }),
    [`${issuer}/register`]: () => json({ client_id: `client-${server.id}` }, 201),
    [`${issuer}/token`]: () => {
      issued += 1;
      return json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: "Bearer", expires_in: 3600 });
    },
    [`${issuer}/revoke`]: () => new Response(null, { status: 200 }),
  };
  const raw = vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : "", init };
    requests.push(request);
    const handler = handlers[url.split("?")[0]!] ?? defaults[url.split("?")[0]!];
    return handler ? handler(request) : new Response("not found", { status: 404 });
  });
  return { fetcher: mcpFetch(server, raw as Fetcher), raw, requests, form: (index: number) => Object.fromEntries(new URLSearchParams(requests[index]!.body)) };
}

/** A popup that approves: redirects to the callback with a code and the request's state. */
function popup(answer: (url: URL, redirectUri: string) => string = (url, redirectUri) =>
  `${redirectUri}?code=code-1&state=${url.searchParams.get("state")}`): OAuthPopup & { urls: URL[] } {
  const urls: URL[] = [];
  return {
    urls,
    getRedirectURL: () => "https://abc123.extensions.allizom.org/",
    authorize: vi.fn(async (url: string, redirectUri: string) => {
      urls.push(new URL(url));
      return answer(new URL(url), redirectUri);
    }),
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP OAuth: connect", () => {
  it("discovers metadata, registers, signs in with PKCE and resource, and seals the tokens", async () => {
    const fake = fakeServer(notion);
    const window = popup();
    const auth = new McpAuth(notion, window, fake.fetcher);
    await auth.connect();

    expect(fake.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
      "GET https://mcp.notion.com/.well-known/oauth-authorization-server",
      "POST https://mcp.notion.com/register",
      "POST https://mcp.notion.com/token",
    ]);
    expect(JSON.parse(fake.requests[2]!.body)).toEqual({
      client_name: "bside", redirect_uris: ["http://127.0.0.1/mozoauth2/abc123/mcp/notion"], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none",
    });
    const authorize = window.urls[0]!;
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://mcp.notion.com/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code", client_id: "client-notion", redirect_uri: "http://127.0.0.1/mozoauth2/abc123/mcp/notion",
      code_challenge_method: "S256", resource: "https://mcp.notion.com/mcp", scope: "read write",
    });
    expect(window.authorize).toHaveBeenCalledWith(expect.any(String), "http://127.0.0.1/mozoauth2/abc123/mcp/notion", expect.any(AbortSignal), "Notion");
    const exchange = fake.form(3);
    expect(exchange).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-notion", resource: "https://mcp.notion.com/mcp", redirect_uri: "http://127.0.0.1/mozoauth2/abc123/mcp/notion" });
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.code_verifier!)))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(authorize.searchParams.get("code_challenge")).toBe(challenge);
    expect(exchange).not.toHaveProperty("client_secret");

    expect(await auth.connected()).toBe(true);
    expect(await auth.token(signal())).toBe("access-1");
    // Every request went out without cookies and refusing redirects.
    for (const call of fake.raw.mock.calls) expect(call[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    const stored = JSON.stringify(await browser.storage.local.get(null));
    expect(stored).not.toContain("access-1");
    expect(stored).not.toContain("refresh-1");
    expect(stored).not.toContain("client-notion");
  });

  it("uses Todoist's separate authorization server and falls back to root resource metadata", async () => {
    const fake = fakeServer(todoist, {
      "https://ai.todoist.net/.well-known/oauth-protected-resource": () => json({ resource: todoist.endpoint, authorization_servers: ["https://todoist.com"] }),
      "https://ai.todoist.net/.well-known/oauth-protected-resource/mcp": () => new Response(null, { status: 404 }),
    });
    const window = popup();
    await new McpAuth(todoist, window, fake.fetcher).connect();
    expect(fake.requests.map((request) => request.url)).toEqual([
      "https://ai.todoist.net/.well-known/oauth-protected-resource/mcp",
      "https://ai.todoist.net/.well-known/oauth-protected-resource",
      "https://todoist.com/.well-known/oauth-authorization-server",
      "https://todoist.com/register",
      "https://todoist.com/token",
    ]);
    expect(window.urls[0]!.searchParams.has("scope")).toBe(false);
  });

  it("reuses a saved registration and sends a client secret when one was issued", async () => {
    const fake = fakeServer(notion, { "https://mcp.notion.com/register": () => json({ client_id: "client-x", client_secret: "secret-x" }) });
    const auth = new McpAuth(notion, popup(), fake.fetcher);
    await auth.connect();
    expect(fake.form(3)).toMatchObject({ client_id: "client-x", client_secret: "secret-x" });
    await auth.disconnect();
    fake.requests.length = 0;
    await auth.connect();
    expect(fake.requests.map((request) => request.url.replace("https://mcp.notion.com", ""))).toEqual([
      "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/token",
    ]);
  });

  it("registers again, once, when the server no longer knows a saved client", async () => {
    let registered = 0;
    const fake = fakeServer(notion, {
      "https://mcp.notion.com/register": () => json({ client_id: `client-${++registered}` }),
      "https://mcp.notion.com/token": (request) => new URLSearchParams(request.body).get("client_id") === "stale"
        ? json({ error: "invalid_client" }, 401)
        : json({ access_token: "access-new", token_type: "bearer" }),
    });
    await saveMcpSecret("registration", "notion", JSON.stringify({ version: 1, clientId: "stale", clientSecret: null, redirectUri: "http://127.0.0.1/mozoauth2/abc123/mcp/notion", issuer: notion.issuer }));
    const window = popup();
    const auth = new McpAuth(notion, window, fake.fetcher);
    await auth.connect();
    expect(window.urls.map((url) => url.searchParams.get("client_id"))).toEqual(["stale", "client-1"]);
    expect(await auth.token(signal())).toBe("access-new");
  });

  it("rejects metadata that points outside the directory entry or at another issuer", async () => {
    const cases: Record<string, () => Response>[] = [
      { "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": () => json({ resource: "https://evil.example/mcp", authorization_servers: [notion.issuer] }) },
      { "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": () => json({ resource: notion.endpoint, authorization_servers: ["https://evil.example"] }) },
      { "https://mcp.notion.com/.well-known/oauth-authorization-server": () => json({ issuer: "https://evil.example", authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://mcp.notion.com/token", code_challenge_methods_supported: ["S256"] }) },
      { "https://mcp.notion.com/.well-known/oauth-authorization-server": () => json({ issuer: notion.issuer, authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://todoist.com/token", code_challenge_methods_supported: ["S256"] }) },
      { "https://mcp.notion.com/.well-known/oauth-authorization-server": () => json({ issuer: notion.issuer, authorization_endpoint: "https://evil.example/authorize", token_endpoint: "https://mcp.notion.com/token", code_challenge_methods_supported: ["S256"] }) },
      { "https://mcp.notion.com/.well-known/oauth-authorization-server": () => json({ issuer: notion.issuer, authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://mcp.notion.com/token", code_challenge_methods_supported: ["plain"] }) },
      { "https://mcp.notion.com/.well-known/oauth-authorization-server": () => json({ issuer: notion.issuer, authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "http://mcp.notion.com/register", code_challenge_methods_supported: ["S256"] }) },
    ];
    for (const handlers of cases) {
      const fake = fakeServer(notion, handlers);
      const window = popup();
      await expect(new McpAuth(notion, window, fake.fetcher).connect()).rejects.toMatchObject({ code: "PROTOCOL" });
      expect(window.authorize).not.toHaveBeenCalled();
      expect(fake.requests.some((request) => request.url.endsWith("/token") || request.url.endsWith("/register"))).toBe(false);
    }
  });

  it("checks the callback's state and issuer, and reports a denial safely", async () => {
    const answers: [(url: URL, redirectUri: string) => string, string][] = [
      [(_url, redirectUri) => `${redirectUri}?code=c&state=wrong`, "AUTH"],
      [(url, redirectUri) => `${redirectUri}?code=c&state=${url.searchParams.get("state")}&iss=https://evil.example`, "AUTH"],
      [(url, redirectUri) => `${redirectUri}?error=access_denied&error_description=<script>&state=${url.searchParams.get("state")}`, "AUTH"],
    ];
    for (const [answer, code] of answers) {
      const fake = fakeServer(notion);
      const error = await new McpAuth(notion, popup(answer), fake.fetcher).connect().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain("script");
      expect(fake.requests.some((request) => request.url.endsWith("/token"))).toBe(false);
    }
    const fake = fakeServer(notion);
    await new McpAuth(notion, popup((url, redirectUri) => `${redirectUri}?code=c&state=${url.searchParams.get("state")}&iss=${encodeURIComponent(notion.issuer)}`), fake.fetcher).connect();
  });

  it("turns a closed popup into a safe sign-in error", async () => {
    const fake = fakeServer(notion);
    const window = popup();
    window.authorize = async () => { throw new ProviderStreamError("Notion sign-in was cancelled. Try again when ready.", "AUTHENTICATION"); };
    await expect(new McpAuth(notion, window, fake.fetcher).connect()).rejects.toMatchObject({ code: "AUTH", message: "Notion sign-in was cancelled. Try again when ready." });
    expect(await getMcpSecret("credential", "notion")).toBeNull();
  });

  it("never fetches outside the server's own origins, even when metadata is crafted to", async () => {
    const fake = fakeServer(notion);
    const window = popup();
    // Notion's egress wrapper refuses Todoist's origin, though CSP allows it.
    await expect(mcpFetch(notion, fake.raw as Fetcher)("https://todoist.com/oauth/access_token", {})).rejects.toMatchObject({ code: "EGRESS" });
    await new McpAuth(notion, window, fake.fetcher).connect();
    expect(fake.raw.mock.calls.every(([url]) => url.startsWith("https://mcp.notion.com/"))).toBe(true);
  });
});

describe("MCP OAuth: tokens", () => {
  async function connected(handlers: Record<string, (request: Request) => Response | Promise<Response>> = {}, now = 1_000_000) {
    vi.setSystemTime(now);
    const fake = fakeServer(notion, handlers);
    const auth = new McpAuth(notion, popup(), fake.fetcher);
    await auth.connect();
    fake.requests.length = 0;
    return { fake, auth };
  }

  it("refreshes a token close to expiry once for concurrent callers, keeping resource and the client", async () => {
    const { fake, auth } = await connected();
    vi.setSystemTime(1_000_000 + 3_600_000 - 30_000);
    const [a, b] = await Promise.all([auth.token(signal()), auth.token(signal())]);
    expect([a, b]).toEqual(["access-2", "access-2"]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.form(0)).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", resource: notion.endpoint, client_id: "client-notion" });
    expect(await auth.token(signal())).toBe("access-2");
    // A fresh instance reads the refreshed tokens back from sealed storage.
    expect(await new McpAuth(notion, popup(), fake.fetcher).token(signal())).toBe("access-2");
  });

  it("keeps the old refresh token when the server does not rotate it", async () => {
    await connected({ "https://mcp.notion.com/token": () => json({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 3600 }) });
    const fake = fakeServer(notion, { "https://mcp.notion.com/token": () => json({ access_token: "b", token_type: "bearer" }) });
    const later = new McpAuth(notion, popup(), fake.fetcher);
    expect(await later.refresh(signal())).toBe("b");
    expect(await later.refresh(signal())).toBe("b");
    expect(fake.form(1).refresh_token).toBe("r");
  });

  it("deletes the tokens and asks to reconnect when the refresh token is refused", async () => {
    await connected();
    const fake = fakeServer(notion, { "https://mcp.notion.com/token": () => json({ error: "invalid_grant" }, 400) });
    const later = new McpAuth(notion, popup(), fake.fetcher);
    await expect(later.refresh(signal())).rejects.toMatchObject({ code: "REAUTH" });
    expect(await getMcpSecret("credential", "notion")).toBeNull();
    await expect(later.token(signal())).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    // The registration stays for reconnecting.
    expect(await getMcpSecret("registration", "notion")).not.toBeNull();
  });

  it("keeps the tokens when a refresh fails on the network or with a server error", async () => {
    await connected();
    for (const handler of [() => { throw new TypeError("offline"); }, () => new Response("<html>oops</html>", { status: 503 })]) {
      const fake = fakeServer(notion, { "https://mcp.notion.com/token": handler });
      const error = await new McpAuth(notion, popup(), fake.fetcher).refresh(signal()).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: expect.stringMatching(/NETWORK|SERVER/) });
      expect((error as Error).message).not.toContain("oops");
      expect(await getMcpSecret("credential", "notion")).not.toBeNull();
    }
  });

  it("revokes both tokens on disconnect and deletes them whatever the answer", async () => {
    const { fake, auth } = await connected();
    expect(await auth.disconnect()).toBe("revoked");
    expect(fake.requests.map((request) => new URLSearchParams(request.body).get("token_type_hint"))).toEqual(["refresh_token", "access_token"]);
    expect(fake.form(0)).toMatchObject({ token: "refresh-1", client_id: "client-notion" });
    expect(await auth.connected()).toBe(false);
    expect(await getMcpSecret("credential", "notion")).toBeNull();

    const failing = await connected({ "https://mcp.notion.com/revoke": () => { throw new TypeError("offline"); } });
    expect(await failing.auth.disconnect()).toBe("unconfirmed");
    expect(await failing.auth.connected()).toBe(false);
  });

  it("reports revocation as unsupported when the server has no endpoint", async () => {
    const { fake, auth } = await connected({
      "https://mcp.notion.com/.well-known/oauth-authorization-server": () => json({
        issuer: notion.issuer, authorization_endpoint: `${notion.issuer}/authorize`, token_endpoint: `${notion.issuer}/token`,
        registration_endpoint: `${notion.issuer}/register`, code_challenge_methods_supported: ["S256"],
      }),
    });
    expect(await auth.disconnect()).toBe("unsupported");
    expect(fake.requests).toHaveLength(0);
  });

  it("reads a record whose endpoints left the directory entry as disconnected", async () => {
    await saveMcpSecret("credential", "notion", JSON.stringify({
      version: 1, accessToken: "a", refreshToken: null, expiresAt: null, clientId: "c", clientSecret: null,
      tokenEndpoint: "https://evil.example/token", revocationEndpoint: null,
    }));
    const auth = new McpAuth(notion, popup(), fakeServer(notion).fetcher);
    expect(await auth.connected()).toBe(false);
  });
});
