/** OAuth and PIN encryption live only in the persistent background page. */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { ChatGPTStatus, ModelDefinition, ProviderAuth } from "@/lib/domain/provider";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import { ProviderStreamError } from "@/lib/providers/openai";
import { FirefoxChatGPTAuthBrowser, type ChatGPTAuthBrowser } from "@/lib/background/chatgpt-browser-auth";
import {
  deleteChatGPTCredential, getChatGPTCredential, getChatGPTRegistration,
  saveChatGPTCredential, saveChatGPTRegistration,
  type ChatGPTCredentialV1, type ChatGPTRegistrationV1,
} from "@/lib/storage";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PIN_ITERATIONS = 600_000;
const ENCRYPTION_CONTEXT = new TextEncoder().encode("bside:chatgpt-credential:v1");

interface ChatGPTCredential {
  clientId: string;
  subject: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
}

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function randomValue(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pinKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!/^\d{8,64}$/.test(pin)) throw new ProviderStreamError("Use a PIN with at least 8 digits.", "INVALID_REQUEST");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PIN_ITERATIONS }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export class ChatGPTAuth {
  #browser: ChatGPTAuthBrowser;
  #fetch: typeof fetch;
  #credential: ChatGPTCredential | null = null;
  #key: CryptoKey | null = null;
  #salt: string | null = null;
  #busy = false;
  #refresh: Promise<ProviderAuth> | null = null;

  constructor(authBrowser: ChatGPTAuthBrowser = new FirefoxChatGPTAuthBrowser(), fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.#browser = authBrowser;
    this.#fetch = fetcher;
  }

  async status(): Promise<ChatGPTStatus> {
    const connected = (await getChatGPTCredential()) !== null;
    return { connected, locked: connected && this.#credential === null, email: this.#credential?.email ?? null };
  }

  async models(): Promise<ModelDefinition[] | null> {
    return (await getChatGPTCredential())?.models ?? null;
  }

  async login(pin: string): Promise<void> {
    return this.#operation(async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await pinKey(pin, salt);
      const subdomain = new URL(this.#browser.getRedirectURL()).hostname.split(".")[0];
      const redirectUri = `http://127.0.0.1:1455/mozoauth2/${subdomain}`;
      const saved = await getChatGPTRegistration();
      // Only the port may change on an existing registration. Preserve the
      // original host ID and issued client ID from the portless prototype.
      if (saved && new URL(saved.redirectUri).pathname !== new URL(redirectUri).pathname)
        throw new ProviderStreamError("The extension's login callback changed. Reinstall this extension with its original add-on ID.", "AUTHENTICATION");
      const registration: ChatGPTRegistrationV1 = saved ? { ...saved, redirectUri } : {
        version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, clientId: null, subject: null, redirectUri,
      };
      await saveChatGPTRegistration(registration);
      const state = randomValue();
      const nonce = randomValue();
      const verifier = randomValue();
      const challenge = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: registration.clientId ?? "dynamic_agent_client",
        ext_agent_host_id: registration.hostId, response_type: "code", redirect_uri: redirectUri,
        scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: challenge,
        ...(!registration.clientId ? { agent_name_hint: "bside" } : {}),
      }).toString();
      const returned = await this.#browser.authorize(url.href, redirectUri, AbortSignal.timeout(10 * 60_000));
      const callback = new URL(returned);
      if (`${callback.origin}${callback.pathname}` !== redirectUri || callback.searchParams.get("state") !== state)
        throw new ProviderStreamError("ChatGPT sign-in returned an invalid callback.", "AUTHENTICATION");
      if (callback.searchParams.has("error")) throw new ProviderStreamError("ChatGPT plan access was not authorized. Try signing in again and allow plan usage.", "AUTHENTICATION");
      const code = callback.searchParams.get("code");
      const clientId = callback.searchParams.get("client_id") ?? registration.clientId;
      if (!code || !clientId || !/^[\w-]{1,200}$/.test(clientId) || clientId === "dynamic_agent_client" ||
        (registration.clientId !== null && clientId !== registration.clientId))
        throw new ProviderStreamError("ChatGPT did not return a valid client registration.", "AUTHENTICATION");
      // Retain the issued ID even if the one-time code exchange fails.
      await saveChatGPTRegistration({ ...registration, clientId });
      const token = await this.#tokens({ grant_type: "authorization_code", client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
      const idToken = typeof token.id_token === "string" ? token.id_token : "";
      const identity = await this.#verifyIdentity(idToken, clientId, nonce);
      if (registration.subject !== null && registration.subject !== identity.subject)
        throw new ProviderStreamError("ChatGPT returned a different account for this registration.", "AUTHENTICATION");
      const credential = this.#readTokens(token, { clientId, ...identity, idToken });
      const models = await this.#loadModels(credential.accessToken);
      await this.#save(credential, key, base64(salt), models);
      await saveChatGPTRegistration({ ...registration, clientId, subject: identity.subject });
      this.#credential = credential;
      this.#key = key;
      this.#salt = base64(salt);
    });
  }

  async unlock(pin: string): Promise<void> {
    return this.#operation(async () => {
      const saved = await getChatGPTCredential();
      if (!saved) throw new ProviderStreamError("Sign in with ChatGPT first.", "AUTHENTICATION");
      const key = await pinKey(pin, bytes(saved.salt));
      let credential: ChatGPTCredential;
      try {
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(saved.iv), additionalData: ENCRYPTION_CONTEXT }, key, bytes(saved.ciphertext));
        credential = JSON.parse(new TextDecoder().decode(plaintext)) as ChatGPTCredential;
        if (!credential || typeof credential.accessToken !== "string" || typeof credential.refreshToken !== "string" ||
          typeof credential.idToken !== "string" || typeof credential.clientId !== "string" || typeof credential.subject !== "string" ||
          !(credential.email === null || typeof credential.email === "string") || !Number.isFinite(credential.expiresAt) ||
          !Array.isArray(credential.scopes) || !credential.scopes.includes("chatgpt.tokens.use.direct")) throw new Error();
      } catch {
        throw new ProviderStreamError("Incorrect PIN or damaged saved connection. Sign in again if you forgot your PIN.", "AUTHENTICATION");
      }
      this.#credential = credential;
      this.#key = key;
      this.#salt = saved.salt;
    });
  }

  async lock(): Promise<void> {
    return this.#operation(async () => { this.#credential = null; this.#key = null; this.#salt = null; });
  }

  async disconnect(): Promise<boolean> {
    return this.#operation(async () => {
      let revoked = false;
      if (this.#credential) {
        try {
          const response = await this.#request(`${ISSUER}/api/accounts/oauth/revoke`, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: this.#credential.refreshToken, token_type_hint: "refresh_token", client_id: this.#credential.clientId }),
          });
          revoked = response.ok;
        } catch { /* Local disconnect must still work offline. */ }
      }
      await deleteChatGPTCredential();
      this.#credential = null; this.#key = null; this.#salt = null;
      return revoked;
    });
  }

  async getAuth(signal: AbortSignal): Promise<ProviderAuth> {
    signal.throwIfAborted();
    if (!this.#credential) throw new ProviderStreamError("Unlock ChatGPT in settings before starting a conversation.", "AUTHENTICATION");
    if (this.#refresh) return this.#refresh;
    if (this.#credential.expiresAt > Date.now() + 60_000) return { providerId: "openai", method: "chatgpt", secret: this.#credential.accessToken };
    this.#refresh = this.#operation(async () => {
      const current = this.#credential!;
      const token = await this.#tokens({ grant_type: "refresh_token", client_id: current.clientId, refresh_token: current.refreshToken, resource: RESOURCE }, signal);
      let identity = { subject: current.subject, email: current.email };
      if (typeof token.id_token === "string") identity = await this.#verifyIdentity(token.id_token, current.clientId);
      if (identity.subject !== current.subject) throw new ProviderStreamError("ChatGPT refresh returned a different account. Reconnect in settings.", "AUTHENTICATION");
      const credential = this.#readTokens(token, { ...current, ...identity, idToken: typeof token.id_token === "string" ? token.id_token : current.idToken });
      const models = (await getChatGPTCredential())!.models;
      await this.#save(credential, this.#key!, this.#salt!, models);
      this.#credential = credential;
      return { providerId: "openai", method: "chatgpt", secret: credential.accessToken } as const;
    });
    try { return await this.#refresh; } finally { this.#refresh = null; }
  }

  async #operation<T>(action: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new ProviderStreamError("Another ChatGPT account operation is in progress.", "INVALID_REQUEST");
    this.#busy = true;
    try { return await action(); }
    catch (error) {
      if (error instanceof ProviderStreamError) {
        console.warn("[bside] ChatGPT authentication failed:", error.code, error.message);
        throw error;
      }
      console.warn("[bside] ChatGPT authentication failed:", "Unrecognized authentication error");
      throw new ProviderStreamError("ChatGPT authentication could not complete. Try again.", "AUTHENTICATION");
    } finally { this.#busy = false; }
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    try { return await this.#fetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) }); }
    catch { throw new ProviderStreamError("Could not reach OpenAI for ChatGPT authentication.", "NETWORK"); }
  }

  async #tokens(params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.#request(`${ISSUER}/api/accounts/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal,
    });
    if (!response.ok) throw new ProviderStreamError("ChatGPT token exchange failed. Reconnect in settings.",
      response.status === 429 ? "RATE_LIMIT" : response.status >= 500 ? "PROVIDER_UNAVAILABLE" : "AUTHENTICATION", response.status,
      response.headers.get("x-request-id") ?? undefined);
    return await response.json() as Record<string, unknown>;
  }

  #readTokens(token: Record<string, unknown>, identity: Pick<ChatGPTCredential, "clientId" | "subject" | "email" | "idToken">): ChatGPTCredential {
    if (typeof token.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" || !token.refresh_token ||
      typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 86_400 ||
      typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" || typeof token.scope !== "string")
      throw new ProviderStreamError("ChatGPT returned invalid credentials.", "AUTHENTICATION");
    const scopes = token.scope.split(/\s+/);
    if (!scopes.includes("chatgpt.tokens.use.direct")) throw new ProviderStreamError("Allow ChatGPT plan usage when signing in.", "AUTHENTICATION");
    return { ...identity, accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000, scopes };
  }

  async #verifyIdentity(idToken: string, clientId: string, nonce?: string): Promise<{ subject: string; email: string | null }> {
    const response = await this.#request(`${ISSUER}/.well-known/jwks.json`);
    if (!response.ok) throw new ProviderStreamError("Could not validate the ChatGPT account.", "AUTHENTICATION");
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(await response.json() as JSONWebKeySet), {
      issuer: ISSUER, audience: clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", ...(nonce ? ["nonce"] : [])], clockTolerance: 5,
    });
    if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new ProviderStreamError("ChatGPT returned an invalid account identity.", "AUTHENTICATION");
    return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : null };
  }

  async #loadModels(accessToken: string): Promise<ModelDefinition[]> {
    const response = await this.#request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new ProviderStreamError("Could not load models for this ChatGPT account.", "AUTHENTICATION", response.status);
    const catalog = await response.json() as { models?: unknown };
    if (!Array.isArray(catalog.models)) throw new ProviderStreamError("ChatGPT returned an invalid model catalog.", "AUTHENTICATION");
    const models = catalog.models.flatMap((entry: unknown): ModelDefinition[] => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as Record<string, unknown>;
      if (model.visibility !== "list" || typeof model.slug !== "string" || !/^[\w.:-]{1,200}$/.test(model.slug) ||
        typeof model.display_name !== "string" || model.display_name.length > 200) return [];
      const known = OPENAI_PROVIDER.models.find((candidate) => candidate.id === model.slug);
      return [{ id: model.slug, name: model.display_name, reasoningEfforts: known?.reasoningEfforts ?? ["none"],
        defaultReasoningEffort: known?.defaultReasoningEffort ?? "none" }];
    }).slice(0, 200);
    if (!models.length) throw new ProviderStreamError("No models are available for this ChatGPT account.", "AUTHENTICATION");
    return models;
  }

  async #save(credential: ChatGPTCredential, key: CryptoKey, salt: string, models: ModelDefinition[]): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ENCRYPTION_CONTEXT }, key,
      new TextEncoder().encode(JSON.stringify(credential)));
    const record: ChatGPTCredentialV1 = { version: 1, salt, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)), models };
    await saveChatGPTCredential(record);
  }
}
