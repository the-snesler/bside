/**
 * The shared OAuth sign-in popup: opens the authorization page in a popup
 * window and captures its redirect to a loopback callback before the request
 * leaves Firefox. Nothing listens on the loopback address. Used by Sign in
 * with ChatGPT and by MCP connections.
 */
import { ProviderStreamError } from "@/lib/providers/openai";

type RequestListener = (details: { url: string; tabId: number; type: string }) => { cancel?: boolean };
type TabRemovedListener = (tabId: number) => void;

export interface OAuthPopupApi {
  identity: { getRedirectURL(): string };
  windows: {
    create(details: { url: string; type: "popup"; width: number; height: number }): Promise<{ id?: number; tabs?: { id?: number }[] } | undefined>;
    remove(windowId: number): Promise<void>;
  };
  tabs: {
    update(tabId: number, details: { url: string }): Promise<unknown>;
    onRemoved: { addListener(listener: TabRemovedListener): void; removeListener(listener: TabRemovedListener): void };
  };
  webRequest: {
    onBeforeRequest: {
      addListener(listener: RequestListener, filter: { urls: string[]; types: ["main_frame"]; tabId: number }, extra: ["blocking"]): void;
      removeListener(listener: RequestListener): void;
    };
  };
}

export interface OAuthPopup {
  /** Firefox's per-add-on redirect URL; its subdomain names this add-on in loopback callback paths. */
  getRedirectURL(): string;
  /**
   * Opens `url` in a popup and resolves with the full callback URL once the
   * popup is redirected to `redirectUri` (an `http://127.0.0.1` URL; scheme,
   * host, port, and path must match). `label` names the service in errors.
   */
  authorize(url: string, redirectUri: string, signal: AbortSignal, label: string): Promise<string>;
}

export class FirefoxOAuthPopup implements OAuthPopup {
  constructor(private api: OAuthPopupApi = browser) {}

  getRedirectURL(): string { return this.api.identity.getRedirectURL(); }

  async authorize(url: string, redirectUri: string, signal: AbortSignal, label: string): Promise<string> {
    signal.throwIfAborted();
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") throw new ProviderStreamError(`${label} sign-in needs a loopback callback.`, "INVALID_REQUEST");
    const window = await this.api.windows.create({ url: "about:blank", type: "popup", width: 520, height: 720 });
    const tabId = window?.tabs?.[0]?.id;
    let requestListener: RequestListener | undefined;
    let removedListener: TabRemovedListener | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (window?.id === undefined || tabId === undefined) throw new ProviderStreamError(`Firefox could not open the ${label} sign-in window.`, "AUTHENTICATION");
      const callback = Promise.withResolvers<string>();
      requestListener = (details) => {
        if (details.tabId !== tabId || details.type !== "main_frame") return {};
        const returned = new URL(details.url);
        if (`${returned.origin}${returned.pathname}` !== redirectUri) return {};
        callback.resolve(details.url);
        return { cancel: true };
      };
      removedListener = (removedTabId) => {
        if (removedTabId === tabId) callback.reject(new ProviderStreamError(`${label} sign-in was cancelled. Try again when ready.`, "AUTHENTICATION"));
      };
      abortListener = () => callback.reject(new ProviderStreamError(`${label} sign-in timed out. Try again.`, "TIMEOUT"));
      // Bind both listeners before navigating: an existing session can
      // redirect immediately. No other tab's callback is observed or cancelled.
      // Match patterns ignore the port; the listener checks it.
      this.api.webRequest.onBeforeRequest.addListener(requestListener,
        { urls: [`http://127.0.0.1${redirect.pathname}*`], types: ["main_frame"], tabId }, ["blocking"]);
      this.api.tabs.onRemoved.addListener(removedListener);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
      else void this.api.tabs.update(tabId, { url }).catch(() => callback.reject(new ProviderStreamError(`Firefox could not load ${label} sign-in.`, "NETWORK")));
      return await callback.promise;
    } finally {
      if (requestListener) this.api.webRequest.onBeforeRequest.removeListener(requestListener);
      if (removedListener) this.api.tabs.onRemoved.removeListener(removedListener);
      if (abortListener) signal.removeEventListener("abort", abortListener);
      if (window?.id !== undefined) await this.api.windows.remove(window.id).catch(() => {});
    }
  }
}
