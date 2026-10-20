import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { DeviceKey } from "@/lib/background/device-key";
import { MemoryDeviceKeyStore } from "@/tests/helpers/memory-key-store";
import type { ChatGPTAuthBrowser } from "@/lib/background/chatgpt-browser-auth";
import { getChatGPTCredential, getChatGPTRegistration, saveChatGPTRegistration, saveOpenAICredential, getOpenAICredential } from "@/lib/storage";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => { keys = await generateKeyPair("RS256"); jwk = await exportJWK(keys.publicKey); });
beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => {}); });

function harness(options: { callback?: (url: URL) => void; nonce?: string; scopes?: string; refreshStatus?: number; revokeStatus?: number; issuer?: string; audience?: string; browserError?: string } = {}) {
  let authorization: URL;
  const tokenRequests: URLSearchParams[] = [];
  const authBrowser: ChatGPTAuthBrowser = {
    getRedirectURL: () => "https://test-addon.extensions.allizom.org/",
    authorize: vi.fn(async (url, redirectUri) => {
      if (options.browserError) throw { message: options.browserError };
      authorization = new URL(url);
      expect(redirectUri).toBe("http://127.0.0.1:1455/mozoauth2/test-addon");
      expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUri);
      const callback = new URL(redirectUri);
      callback.search = new URLSearchParams({ code: "test-code", state: authorization.searchParams.get("state")!, client_id: "oaiapp_test" }).toString();
      options.callback?.(callback);
      return callback.href;
    }),
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      const request = new URLSearchParams(init?.body as URLSearchParams);
      tokenRequests.push(request);
      const refresh = request.get("grant_type") === "refresh_token";
      if (refresh && options.refreshStatus) return new Response("private token error", { status: options.refreshStatus });
      const idToken = await new SignJWT({ email: "user@example.test", nonce: options.nonce ?? authorization.searchParams.get("nonce") })
        .setProtectedHeader({ alg: "RS256" }).setSubject("test-user").setIssuer(options.issuer ?? "https://auth.openai.com")
        .setAudience(options.audience ?? "oaiapp_test").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
      return Response.json({ access_token: refresh ? "test-access-rotated" : "test-access", refresh_token: refresh ? "test-refresh-rotated" : "test-refresh",
        ...(refresh ? {} : { id_token: idToken }), token_type: "Bearer", expires_in: 3600,
        scope: options.scopes ?? "openid email offline_access resource.invoke chatgpt.tokens.use.direct" });
    }
    if (url.endsWith("/jwks.json")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", visibility: "list" },
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
    ] });
    if (url.endsWith("/oauth/revoke")) return new Response("", { status: options.revokeStatus ?? 200 });
    throw new Error("unexpected authentication request");
  });
  return { authBrowser, fetcher, tokenRequests, auth: new ChatGPTAuth(authBrowser, fetcher), authorization: () => authorization };
}

describe("ChatGPT subscription OAuth and encrypted storage", () => {
  it("does not expose arbitrary browser errors in the UI or console", async () => {
    const h = harness({ browserError: "private callback?code=test-secret&state=test-state" });
    await expect(h.auth.login()).rejects.toMatchObject({ code: "AUTHENTICATION", message: expect.not.stringContaining("test-secret") });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("test-secret");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(await getChatGPTCredential()).toBeNull();
  });

  it("uses PKCE, validates the signed account, encrypts all tokens, and publishes only safe status", async () => {
    const h = harness();
    await h.auth.login();
    const url = h.authorization();
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("bside");
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    const verifier = h.tokenRequests[0]!.get("code_verifier")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(Array.from(digest, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(h.tokenRequests[0]!.get("client_id")).toBe("oaiapp_test");
    expect(h.tokenRequests[0]!.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    const stored = JSON.stringify(await browser.storage.local.get(null));
    for (const secret of ["test-access", "test-refresh", "user@example.test", "id_token", "salt"]) expect(stored).not.toContain(secret);
    expect(await getChatGPTCredential()).toMatchObject({ version: 2 });
    const status = await h.auth.status();
    expect(status).toEqual({ connected: true, email: "user@example.test", signInAgain: false });
    expect(JSON.stringify(status)).not.toContain("test-access");
    expect((await h.auth.models())?.map((model) => model.id)).toEqual(["gpt-5.6-terra", "gpt-6.1-sol"]);
    expect(await h.auth.getAuth(new AbortController().signal)).toMatchObject({ method: "chatgpt", secret: "test-access" });
  });

  it("clears the sign-in-again notice after a successful sign-in", async () => {
    await browser.storage.local.set({ chatgptCredential: { version: 1, salt: "A".repeat(24), iv: "B".repeat(16), ciphertext: "C".repeat(64), models: [] } });
    const h = harness();
    expect(await h.auth.status()).toEqual({ connected: false, email: null, signInAgain: true });
    await h.auth.login();
    expect(await h.auth.status()).toEqual({ connected: true, email: "user@example.test", signInAgain: false });
  });

  it("reconnects silently after restart with the device key", async () => {
    const h = harness();
    await h.auth.login();
    const restarted = new ChatGPTAuth(h.authBrowser, h.fetcher);
    expect(await restarted.status()).toEqual({ connected: true, email: "user@example.test", signInAgain: false });
    expect(await restarted.getAuth(new AbortController().signal)).toMatchObject({ secret: "test-access" });
    expect(h.authBrowser.authorize).toHaveBeenCalledTimes(1);
  });

  it("deletes tokens the device key cannot open and reports not connected instead of failing", async () => {
    const h = harness();
    await h.auth.login();
    const lostKey = new ChatGPTAuth(h.authBrowser, h.fetcher, new DeviceKey(new MemoryDeviceKeyStore()));
    expect(await lostKey.status()).toEqual({ connected: false, email: null, signInAgain: false });
    expect(await getChatGPTCredential()).toBeNull();
    expect(await lostKey.models()).toBeNull();
    await expect(lostKey.getAuth(new AbortController().signal)).rejects.toMatchObject({ code: "AUTHENTICATION", message: expect.stringContaining("Sign in with ChatGPT") });
  });

  it("serializes rotating refresh tokens and saves a new IV with the replacement tokens", async () => {
    const h = harness();
    await h.auth.login();
    const saved = await getChatGPTCredential();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    const [first, second] = await Promise.all([h.auth.getAuth(new AbortController().signal), h.auth.getAuth(new AbortController().signal)]);
    expect(first.secret).toBe("test-access-rotated");
    expect(second).toEqual(first);
    expect(h.tokenRequests).toHaveLength(2);
    expect(h.tokenRequests[1]!.get("refresh_token")).toBe("test-refresh");
    const replacement = await getChatGPTCredential();
    expect(replacement?.iv).not.toBe(saved?.iv);
    const restarted = new ChatGPTAuth(h.authBrowser, h.fetcher);
    expect((await restarted.getAuth(new AbortController().signal)).secret).toBe("test-access-rotated");
  });

  it.each([
    { callback: (url: URL) => url.searchParams.set("state", "wrong-state") },
    { callback: (url: URL) => { url.pathname += "-forged"; } },
    { callback: (url: URL) => url.searchParams.delete("client_id") },
    { nonce: "wrong-nonce" },
    { issuer: "https://attacker.example" },
    { audience: "wrong-client" },
    { scopes: "openid email" },
  ])("rejects invalid callbacks, identity, or missing plan consent before saving credentials", async (options) => {
    const h = harness(options);
    await expect(h.auth.login()).rejects.toMatchObject({ code: "AUTHENTICATION" });
    expect(await getChatGPTCredential()).toBeNull();
  });

  it("reuses the registration and host ID when reconnecting", async () => {
    const h = harness();
    await h.auth.login();
    const registration = await getChatGPTRegistration();
    await h.auth.disconnect();
    await h.auth.login();
    expect(h.authorization().searchParams.get("client_id")).toBe("oaiapp_test");
    expect(h.authorization().searchParams.has("agent_name_hint")).toBe(false);
    expect(await getChatGPTRegistration()).toEqual(registration);
    expect(await h.auth.status()).toMatchObject({ connected: true });
  });

  it("adds an explicit port to a saved prototype registration without replacing its identity", async () => {
    const h = harness();
    const registration = { version: 1 as const, hostId: `urn:uuid:${crypto.randomUUID()}`, clientId: null, subject: null,
      redirectUri: "http://127.0.0.1/mozoauth2/test-addon" };
    await saveChatGPTRegistration(registration);
    await h.auth.login();
    expect(h.authorization().searchParams.get("ext_agent_host_id")).toBe(registration.hostId);
    expect(await getChatGPTRegistration()).toMatchObject({ hostId: registration.hostId, redirectUri: "http://127.0.0.1:1455/mozoauth2/test-addon" });
  });

  it("discards a registration and credential from a different add-on ID and registers fresh", async () => {
    const h = harness();
    await h.auth.login();
    const stale = { version: 1 as const, hostId: `urn:uuid:${crypto.randomUUID()}`, clientId: "oaiapp_old", subject: "old-user",
      redirectUri: "http://127.0.0.1:1455/mozoauth2/old-addon" };
    await saveChatGPTRegistration(stale);
    const failed = harness({ browserError: "cancelled" });
    await expect(failed.auth.login()).rejects.toMatchObject({ code: "AUTHENTICATION" });
    expect(await getChatGPTCredential()).toBeNull();
    expect(await getChatGPTRegistration()).toMatchObject({ clientId: null, subject: null, redirectUri: "http://127.0.0.1:1455/mozoauth2/test-addon" });

    await saveChatGPTRegistration(stale);
    await h.auth.login();
    expect(h.authorization().searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(h.authorization().searchParams.get("ext_agent_host_id")).not.toBe(stale.hostId);
    expect(await getChatGPTRegistration()).toMatchObject({ clientId: "oaiapp_test", subject: "test-user", redirectUri: "http://127.0.0.1:1455/mozoauth2/test-addon" });
    expect(await h.auth.getAuth(new AbortController().signal)).toMatchObject({ secret: "test-access" });
  });

  it("retains saved credentials on refresh failure and sanitizes upstream error bodies", async () => {
    const h = harness({ refreshStatus: 500 });
    await h.auth.login();
    const saved = await getChatGPTCredential();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    await expect(h.auth.getAuth(new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, message: expect.not.stringContaining("private token error") });
    expect(await getChatGPTCredential()).toEqual(saved);
  });

  it("revokes the saved refresh token remotely when disconnecting after a restart", async () => {
    const h = harness();
    await h.auth.login();
    const restarted = new ChatGPTAuth(h.authBrowser, h.fetcher);
    expect(await restarted.disconnect()).toBe(true);
    const revoke = h.fetcher.mock.calls.find(([url]) => String(url).endsWith("/oauth/revoke"));
    expect(new URLSearchParams(revoke?.[1]?.body as URLSearchParams).get("token")).toBe("test-refresh");
    expect(await getChatGPTCredential()).toBeNull();
    expect(await restarted.status()).toEqual({ connected: false, email: null, signInAgain: false });
  });

  it("disconnects locally when revocation fails and leaves an existing API key intact", async () => {
    const h = harness({ revokeStatus: 503 });
    await saveOpenAICredential("sk-test-existing-key");
    await h.auth.login();
    expect(await h.auth.disconnect()).toBe(false);
    expect(await h.auth.status()).toEqual({ connected: false, email: null, signInAgain: false });
    expect(await getChatGPTCredential()).toBeNull();
    expect((await getOpenAICredential())?.apiKey).toBe("sk-test-existing-key");
  });
});
