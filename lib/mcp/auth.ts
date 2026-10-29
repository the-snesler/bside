/**
 * OAuth 2.1 for one directory MCP server, following the MCP authorization
 * spec: protected-resource and authorization-server metadata discovery,
 * dynamic client registration, PKCE (S256) through the shared OAuth popup,
 * RFC 8707 `resource` on every grant, single-flight refresh, and RFC 7009
 * revocation. Every request goes through the egress-checked fetch, and every
 * endpoint discovered must lie inside the directory entry. Tokens and the
 * registration are sealed with the device key (`lib/storage.ts`); they never
 * leave the background. See docs/mcp.md.
 */

import type { OAuthPopup } from "@/lib/background/oauth-popup";
import { ProviderStreamError } from "@/lib/providers/openai";
import { McpError } from "@/lib/mcp/errors";
import { isAllowedUrl, type Fetcher } from "@/lib/mcp/egress";
import type { McpTokenSource } from "@/lib/mcp/client";
import type { McpServer } from "@/lib/mcp/servers";
import { deleteMcpSecret, getMcpSecret, saveMcpSecret } from "@/lib/storage";

const AUTH_REQUEST_TIMEOUT_MS = 30_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** A token this close to expiry is refreshed before use. */
const REFRESH_MARGIN_MS = 60_000;
const MAX_METADATA_BYTES = 256_000;
const MAX_TOKEN_CHARS = 16_000;
const MAX_EXPIRES_IN_S = 365 * 86_400;

/** `local:mcpCredential:<id>`, sealed. Endpoints are saved so refresh and revocation need no rediscovery; they are rechecked on read. */
interface McpCredential {
  version: 1;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, or null when the server gave no lifetime (refreshed only after a 401). */
  expiresAt: number | null;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
}

/** `local:mcpRegistration:<id>`, sealed: the dynamically registered client, reused on reconnect. */
interface McpRegistration {
  version: 1;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  issuer: string;
}

interface AuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  scopes: string[];
}

/** What disconnecting did with the server's tokens: revoked, sent but not confirmed, or the server has no revocation endpoint. */
export type McpRevocation = "revoked" | "unconfirmed" | "unsupported";

export class McpAuth implements McpTokenSource {
  #server: McpServer;
  #popup: OAuthPopup;
  #fetch: Fetcher;
  #credential: McpCredential | null = null;
  #loaded = false;
  #refreshing: Promise<string> | null = null;
  #connecting = false;
  /** Bumped whenever the saved tokens are replaced or deleted, so a stale refresh never overwrites a newer state. */
  #generation = 0;

  /** `fetcher` must be the server's egress-checked fetch (`mcpFetch(server)`). */
  constructor(server: McpServer, popup: OAuthPopup, fetcher: Fetcher) {
    this.#server = server;
    this.#popup = popup;
    this.#fetch = fetcher;
  }

  async connected(): Promise<boolean> {
    return (await this.#load()) !== null;
  }

  /**
   * Signs in through the popup and saves the tokens. A saved registration is
   * reused; if the server no longer knows it (`invalid_client`), it is
   * dropped and the flow runs once more with a fresh one.
   */
  async connect(): Promise<void> {
    if (this.#connecting) throw new McpError("AUTH", `${this.#server.name} sign-in is already open.`);
    this.#connecting = true;
    try {
      const signal = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS);
      const metadata = await this.#discover(signal);
      for (let attempt = 0; ; attempt++) {
        const { registration, reused } = await this.#registration(metadata, signal);
        try {
          await this.#authorize(metadata, registration, signal);
          return;
        } catch (error) {
          if (!(error instanceof InvalidClient) || !reused || attempt > 0) throw error instanceof InvalidClient ? this.#authError("did not accept bside's registration") : error;
          await deleteMcpSecret("registration", this.#server.id);
        }
      }
    } finally {
      this.#connecting = false;
    }
  }

  /** Revokes the tokens where the server supports it, then deletes them locally whatever the outcome. The registration is kept for reconnecting. */
  async disconnect(): Promise<McpRevocation> {
    const credential = await this.#load();
    let outcome: McpRevocation = "unsupported";
    if (credential?.revocationEndpoint) {
      outcome = "revoked";
      const tokens = [...(credential.refreshToken ? [[credential.refreshToken, "refresh_token"]] : []), [credential.accessToken, "access_token"]];
      for (const [token, hint] of tokens) {
        try {
          const response = await this.#post(credential.revocationEndpoint, { token: token!, token_type_hint: hint!, ...clientParams(credential) }, AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS));
          await response.body?.cancel().catch(() => {});
          if (!response.ok) outcome = "unconfirmed";
        } catch { outcome = "unconfirmed"; }
      }
    }
    await this.forget();
    return outcome;
  }

  /** Deletes the saved tokens (not the registration). */
  async forget(): Promise<void> {
    this.#generation++;
    this.#credential = null;
    this.#loaded = true;
    await deleteMcpSecret("credential", this.#server.id);
  }

  /** The current access token, refreshed first when it is about to expire. */
  async token(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const credential = await this.#load();
    if (!credential) throw new McpError("NOT_CONNECTED", `${this.#server.name} is not connected. Connect it in settings.`);
    if (this.#refreshing || (credential.expiresAt !== null && credential.expiresAt - Date.now() < REFRESH_MARGIN_MS)) return this.refresh(signal);
    return credential.accessToken;
  }

  /**
   * Refreshes the access token (single-flight; concurrent callers share one
   * request). `rejected`: the token a server refused. If the saved token has
   * changed since (another caller already refreshed it), that one is used
   * instead of refreshing again, so several requests refused at once rotate
   * the tokens only once. If the server refuses the refresh token, or there
   * is none, the saved tokens are deleted and this fails with `REAUTH`. A
   * network failure leaves them in place.
   */
  async refresh(signal: AbortSignal, rejected?: string): Promise<string> {
    if (!this.#refreshing && rejected !== undefined) {
      const credential = await this.#load();
      if (credential && credential.accessToken !== rejected) return this.token(signal);
    }
    this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = null; });
    return raceSignal(this.#refreshing, signal, this.#server);
  }

  async #refresh(): Promise<string> {
    const credential = await this.#load();
    if (!credential) throw new McpError("NOT_CONNECTED", `${this.#server.name} is not connected. Connect it in settings.`);
    if (!credential.refreshToken) {
      await this.forget();
      throw this.#reauth();
    }
    const generation = this.#generation;
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(credential.tokenEndpoint, {
        grant_type: "refresh_token", refresh_token: credential.refreshToken, resource: this.#server.endpoint, ...clientParams(credential),
      }, AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS));
    } catch (error) {
      if (error instanceof InvalidClient) await deleteMcpSecret("registration", this.#server.id);
      if (error instanceof InvalidClient || error instanceof Refused) {
        if (generation === this.#generation) await this.forget();
        throw this.#reauth();
      }
      throw error;
    }
    if (generation !== this.#generation) throw new McpError("NOT_CONNECTED", `${this.#server.name} was disconnected.`);
    const next: McpCredential = { ...credential, accessToken: token.accessToken, refreshToken: token.refreshToken ?? credential.refreshToken, expiresAt: token.expiresAt };
    await this.#save(next);
    return next.accessToken;
  }

  /** Protected-resource metadata, then the authorization server's, each held to the directory entry. */
  async #discover(signal: AbortSignal): Promise<AuthServerMetadata> {
    const endpoint = new URL(this.#server.endpoint);
    const path = endpoint.pathname === "/" ? "" : endpoint.pathname.replace(/\/$/, "");
    const resource = await this.#metadata([
      `${endpoint.origin}/.well-known/oauth-protected-resource${path}`,
      `${endpoint.origin}/.well-known/oauth-protected-resource`,
    ], signal, "protected resource");
    if (resource.resource !== this.#server.endpoint) throw this.#protocol("names a different protected resource");
    if (!Array.isArray(resource.authorization_servers) || !resource.authorization_servers.some((issuer) => sameIssuer(issuer, this.#server.issuer)))
      throw this.#protocol("names an authorization server bside does not expect");
    const scopes = Array.isArray(resource.scopes_supported) ? resource.scopes_supported.filter((scope): scope is string => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(scope)).slice(0, 32) : [];

    const issuer = new URL(this.#server.issuer);
    const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
    const server = await this.#metadata([
      `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    ], signal, "authorization server");
    if (typeof server.issuer !== "string" || !sameIssuer(server.issuer, this.#server.issuer)) throw this.#protocol("sent metadata for a different issuer");
    if (!Array.isArray(server.code_challenge_methods_supported) || !server.code_challenge_methods_supported.includes("S256")) throw this.#protocol("does not support PKCE (S256)");
    if (Array.isArray(server.response_types_supported) && !server.response_types_supported.includes("code")) throw this.#protocol("does not support the authorization code flow");
    const authorizationEndpoint = this.#endpoint(server.authorization_endpoint, this.#server.authorizeOrigins);
    const tokenEndpoint = this.#endpoint(server.token_endpoint, this.#server.origins);
    if (!authorizationEndpoint || !tokenEndpoint) throw this.#protocol("names sign-in endpoints outside its allowed origins");
    const registrationEndpoint = server.registration_endpoint === undefined ? null : this.#endpoint(server.registration_endpoint, this.#server.origins);
    const revocationEndpoint = server.revocation_endpoint === undefined ? null : this.#endpoint(server.revocation_endpoint, this.#server.origins);
    if ((server.registration_endpoint !== undefined && !registrationEndpoint) || (server.revocation_endpoint !== undefined && !revocationEndpoint))
      throw this.#protocol("names sign-in endpoints outside its allowed origins");
    return { authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint, scopes };
  }

  /** The first of `urls` that answers 200 with a JSON object. */
  async #metadata(urls: string[], signal: AbortSignal, what: string): Promise<Record<string, unknown>> {
    for (const url of urls) {
      const response = await this.#send(url, { method: "GET", headers: { Accept: "application/json" } }, signal);
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw this.#status(response.status, `could not describe its ${what}`);
      }
      const body = await readJson(response, this.#server);
      if (isRecord(body)) return body;
      throw this.#protocol(`described its ${what} in an unexpected format`);
    }
    throw this.#protocol(`does not describe its ${what}`);
  }

  #endpoint(value: unknown, origins: readonly string[]): string | null {
    return typeof value === "string" && isAllowedUrl(value, origins) && !new URL(value).hash ? value : null;
  }

  async #redirectUri(): Promise<string> {
    const subdomain = new URL(this.#popup.getRedirectURL()).hostname.split(".")[0];
    return `http://127.0.0.1/mozoauth2/${subdomain}/mcp/${this.#server.id}`;
  }

  /** The saved registration if it still matches, else a new one. */
  async #registration(metadata: AuthServerMetadata, signal: AbortSignal): Promise<{ registration: McpRegistration; reused: boolean }> {
    const redirectUri = await this.#redirectUri();
    const saved = parseRegistration(await getMcpSecret("registration", this.#server.id));
    if (saved && saved.redirectUri === redirectUri && saved.issuer === this.#server.issuer) return { registration: saved, reused: true };
    if (!metadata.registrationEndpoint) throw this.#protocol("does not let bside register as a client");
    const response = await this.#send(metadata.registrationEndpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "bside", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none",
      }),
    }, signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw this.#status(response.status, "refused bside's client registration");
    }
    const body = await readJson(response, this.#server);
    if (!isRecord(body) || !isToken(body.client_id, 500) || (body.client_secret !== undefined && !isToken(body.client_secret, 2_000)))
      throw this.#protocol("returned an invalid client registration");
    const registration: McpRegistration = {
      version: 1, clientId: body.client_id, clientSecret: typeof body.client_secret === "string" ? body.client_secret : null, redirectUri, issuer: this.#server.issuer,
    };
    await saveMcpSecret("registration", this.#server.id, JSON.stringify(registration));
    return { registration, reused: false };
  }

  /** The popup's authorization code flow with PKCE, then the code exchange. */
  async #authorize(metadata: AuthServerMetadata, registration: McpRegistration, signal: AbortSignal): Promise<void> {
    const state = randomValue();
    const verifier = randomValue();
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const url = new URL(metadata.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: "code", client_id: registration.clientId, redirect_uri: registration.redirectUri, state,
      code_challenge: challenge, code_challenge_method: "S256", resource: this.#server.endpoint,
      ...(metadata.scopes.length ? { scope: metadata.scopes.join(" ") } : {}),
    })) url.searchParams.set(key, value);
    let returned: string;
    try { returned = await this.#popup.authorize(url.href, registration.redirectUri, signal, this.#server.name); }
    catch (error) { throw fromPopupError(error, this.#server); }
    const callback = new URL(returned);
    if (`${callback.origin}${callback.pathname}` !== registration.redirectUri || callback.searchParams.get("state") !== state) throw this.#authError("returned an invalid sign-in callback");
    const iss = callback.searchParams.get("iss");
    if (iss !== null && !sameIssuer(iss, this.#server.issuer)) throw this.#authError("returned a sign-in callback from a different issuer");
    const error = callback.searchParams.get("error");
    if (error === "invalid_client" || error === "unauthorized_client") throw new InvalidClient();
    if (error !== null) throw new McpError("AUTH", error === "access_denied" ? `${this.#server.name} access was not allowed.` : `${this.#server.name} sign-in did not complete. Try again.`);
    const code = callback.searchParams.get("code");
    if (!code || code.length > 4_000) throw this.#authError("returned no authorization code");
    let token: TokenResponse;
    try {
      token = await this.#tokenRequest(metadata.tokenEndpoint, {
        grant_type: "authorization_code", code, redirect_uri: registration.redirectUri, code_verifier: verifier,
        resource: this.#server.endpoint, ...clientParams(registration),
      }, signal);
    } catch (error) {
      if (error instanceof Refused) throw this.#authError("refused the sign-in code");
      throw error;
    }
    this.#generation++;
    await this.#save({
      version: 1, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt,
      clientId: registration.clientId, clientSecret: registration.clientSecret,
      tokenEndpoint: metadata.tokenEndpoint, revocationEndpoint: metadata.revocationEndpoint,
    });
  }

  /** A token-endpoint grant. 400/401 become `InvalidClient` or `Refused`; other failures safe `McpError`s. */
  async #tokenRequest(endpoint: string, params: Record<string, string>, signal: AbortSignal): Promise<TokenResponse> {
    const response = await this.#post(endpoint, params, signal);
    if (response.status === 400 || response.status === 401) {
      const body = await readJson(response, this.#server).catch(() => null);
      throw isRecord(body) && body.error === "invalid_client" ? new InvalidClient() : new Refused();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw this.#status(response.status, "could not issue a token");
    }
    const body = await readJson(response, this.#server);
    if (!isRecord(body) || !isToken(body.access_token, MAX_TOKEN_CHARS) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" ||
      (body.refresh_token !== undefined && !isToken(body.refresh_token, MAX_TOKEN_CHARS)) ||
      (body.expires_in !== undefined && !(typeof body.expires_in === "number" && body.expires_in > 0 && body.expires_in <= MAX_EXPIRES_IN_S)))
      throw this.#protocol("returned invalid credentials");
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : null,
    };
  }

  #post(url: string, params: Record<string, string>, signal: AbortSignal): Promise<Response> {
    return this.#send(url, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(params).toString(),
    }, signal);
  }

  /** One egress-checked request with a timeout; network failures become safe errors. */
  async #send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
    try {
      return await this.#fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) });
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (timeout.aborted || signal.aborted) throw new McpError("TIMEOUT", `${this.#server.name} sign-in did not respond in time.`);
      throw new McpError("NETWORK", `Could not reach ${this.#server.name}.`);
    }
  }

  async #load(): Promise<McpCredential | null> {
    if (this.#loaded) return this.#credential;
    const generation = this.#generation;
    const credential = parseCredential(await getMcpSecret("credential", this.#server.id), this.#server);
    if (generation !== this.#generation) return this.#credential;
    this.#credential = credential;
    this.#loaded = true;
    return credential;
  }

  async #save(credential: McpCredential): Promise<void> {
    await saveMcpSecret("credential", this.#server.id, JSON.stringify(credential));
    this.#credential = credential;
    this.#loaded = true;
  }

  #reauth(): McpError {
    return new McpError("REAUTH", `${this.#server.name} needs you to connect it again in settings.`);
  }

  #protocol(what: string): McpError {
    return new McpError("PROTOCOL", `${this.#server.name} ${what}.`);
  }

  #authError(what: string): McpError {
    return new McpError("AUTH", `${this.#server.name} ${what}. Try connecting again.`);
  }

  #status(status: number, what: string): McpError {
    return new McpError("SERVER", status === 429 ? `${this.#server.name} is rate limiting sign-in. Try again shortly.`
      : status >= 500 ? `${this.#server.name} is temporarily unavailable.` : `${this.#server.name} ${what}.`, status);
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

/** The token endpoint said `invalid_client`: the registration is gone. */
class InvalidClient extends Error {}
/** The token endpoint refused the grant (400/401). */
class Refused extends Error {}

function clientParams(client: { clientId: string; clientSecret: string | null }): Record<string, string> {
  return { client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) };
}

function parseCredential(plaintext: string | null, server: McpServer): McpCredential | null {
  const value = parseJson(plaintext);
  if (!isRecord(value) || value.version !== 1 || !isToken(value.accessToken, MAX_TOKEN_CHARS) ||
    !(value.refreshToken === null || isToken(value.refreshToken, MAX_TOKEN_CHARS)) ||
    !(value.expiresAt === null || Number.isFinite(value.expiresAt)) || !isToken(value.clientId, 500) ||
    !(value.clientSecret === null || isToken(value.clientSecret, 2_000)) ||
    typeof value.tokenEndpoint !== "string" || !isAllowedUrl(value.tokenEndpoint, server.origins) ||
    !(value.revocationEndpoint === null || (typeof value.revocationEndpoint === "string" && isAllowedUrl(value.revocationEndpoint, server.origins)))) return null;
  return value as unknown as McpCredential;
}

function parseRegistration(plaintext: string | null): McpRegistration | null {
  const value = parseJson(plaintext);
  if (!isRecord(value) || value.version !== 1 || !isToken(value.clientId, 500) || !(value.clientSecret === null || isToken(value.clientSecret, 2_000)) ||
    typeof value.redirectUri !== "string" || typeof value.issuer !== "string") return null;
  return value as unknown as McpRegistration;
}

function fromPopupError(error: unknown, server: McpServer): McpError {
  if (error instanceof ProviderStreamError) return new McpError(error.code === "TIMEOUT" ? "TIMEOUT" : error.code === "NETWORK" ? "NETWORK" : "AUTH", error.message);
  return new McpError("AUTH", `${server.name} sign-in did not complete. Try again.`);
}

/** Issuer identifiers compare exactly, ignoring one trailing slash. */
function sameIssuer(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.replace(/\/$/, "") === expected.replace(/\/$/, "");
}

function isToken(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

async function readJson(response: Response, server: McpServer): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return parseJson(await response.text());
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_METADATA_BYTES) throw new McpError("TOO_LARGE", `${server.name} sent an oversized sign-in response.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJson(new TextDecoder().decode(all));
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try { return JSON.parse(text); }
  catch { return undefined; }
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal, server: McpServer): Promise<T> {
  if (signal.aborted) return Promise.reject(new McpError("CANCELLED", `The ${server.name} request was cancelled.`));
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(new McpError("CANCELLED", `The ${server.name} request was cancelled.`));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
