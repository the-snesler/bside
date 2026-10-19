/** Capture an OAuth callback before it reaches a loopback HTTP server. */
import { ProviderStreamError } from "@/lib/providers/openai";

type RequestListener = (details: { url: string; tabId: number; type: string }) => { cancel?: boolean };
type TabRemovedListener = (tabId: number) => void;

export interface ChatGPTBrowserApi {
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

export interface ChatGPTAuthBrowser {
  getRedirectURL(): string;
  authorize(url: string, redirectUri: string, signal: AbortSignal): Promise<string>;
}

export class FirefoxChatGPTAuthBrowser implements ChatGPTAuthBrowser {
  constructor(private api: ChatGPTBrowserApi = browser) {}

  getRedirectURL(): string { return this.api.identity.getRedirectURL(); }

  async authorize(url: string, redirectUri: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const window = await this.api.windows.create({ url: "about:blank", type: "popup", width: 520, height: 720 });
    const tabId = window?.tabs?.[0]?.id;
    let requestListener: RequestListener | undefined;
    let removedListener: TabRemovedListener | undefined;
    let abortListener: (() => void) | undefined;
    try {
      if (window?.id === undefined || tabId === undefined) throw new ProviderStreamError("Firefox could not open the ChatGPT sign-in window.", "AUTHENTICATION");
      const callback = Promise.withResolvers<string>();
      requestListener = (details) => {
        if (details.tabId !== tabId || details.type !== "main_frame") return {};
        const returned = new URL(details.url);
        if (`${returned.origin}${returned.pathname}` !== redirectUri) return {};
        callback.resolve(details.url);
        return { cancel: true };
      };
      removedListener = (removedTabId) => {
        if (removedTabId === tabId) callback.reject(new ProviderStreamError("ChatGPT sign-in was cancelled. Try again when ready.", "AUTHENTICATION"));
      };
      abortListener = () => callback.reject(new ProviderStreamError("ChatGPT sign-in timed out. Try again.", "TIMEOUT"));
      // Bind both listeners before navigating: existing OpenAI sessions can
      // redirect immediately. No other tab's callback is observed or cancelled.
      this.api.webRequest.onBeforeRequest.addListener(requestListener,
        { urls: [`http://127.0.0.1${new URL(redirectUri).pathname}*`], types: ["main_frame"], tabId }, ["blocking"]);
      this.api.tabs.onRemoved.addListener(removedListener);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
      else void this.api.tabs.update(tabId, { url }).catch(() => callback.reject(new ProviderStreamError("Firefox could not load ChatGPT sign-in.", "NETWORK")));
      return await callback.promise;
    } finally {
      if (requestListener) this.api.webRequest.onBeforeRequest.removeListener(requestListener);
      if (removedListener) this.api.tabs.onRemoved.removeListener(removedListener);
      if (abortListener) signal.removeEventListener("abort", abortListener);
      if (window?.id !== undefined) await this.api.windows.remove(window.id).catch(() => {});
    }
  }
}
