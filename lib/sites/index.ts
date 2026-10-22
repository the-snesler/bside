import type { SiteApi, SiteEnv } from "./site-api";
import { youtube } from "./youtube";

/** Every site API browser programs can call; each origin also needs its own `connect-src` entry in wxt.config.ts. */
export const SITE_APIS: readonly SiteApi[] = [youtube];

/** The background page's real fetch and cookie store. */
export function browserSiteEnv(): SiteEnv {
  return {
    fetch: (url, init) => fetch(url, init),
    cookie: async (url, name) => {
      try { return (await browser.cookies.get({ url, name }))?.value ?? null; }
      catch { return null; }
    },
    now: Date.now,
  };
}

type HttpHeader = { name: string; value?: string };
type HeadersListener = (details: { tabId: number; requestHeaders?: HttpHeader[] }) => { requestHeaders?: HttpHeader[] };

export interface SiteRequestApi {
  runtime: { getURL(path: string): string };
  webRequest: {
    onBeforeSendHeaders: {
      addListener(listener: HeadersListener, filter: { urls: string[]; types: ["xmlhttprequest"] }, extra: ["blocking", "requestHeaders"]): void;
    };
  };
}

/**
 * Firefox stamps background-page fetches with `Origin: moz-extension://…`,
 * which InnerTube rejects with 403. For this extension's own background
 * requests to a site API's origin, present that origin instead and drop the
 * extension Referer. Page and other extensions' requests are left alone.
 */
export function registerSiteRequestHeaders(api: SiteRequestApi): void {
  const extensionOrigin = api.runtime.getURL("/").replace(/\/$/, "");
  for (const site of SITE_APIS) {
    api.webRequest.onBeforeSendHeaders.addListener((details) => {
      const headers = details.requestHeaders;
      if (details.tabId !== -1 || !headers?.some((header) => header.name.toLowerCase() === "origin" && header.value === extensionOrigin)) return {};
      return {
        requestHeaders: headers.flatMap((header) => {
          const name = header.name.toLowerCase();
          if (name === "origin") return [{ name: header.name, value: site.origin }];
          if (name === "referer" && header.value?.startsWith(`${extensionOrigin}/`)) return [];
          return [header];
        }),
      };
    }, { urls: [`${site.origin}/*`], types: ["xmlhttprequest"] }, ["blocking", "requestHeaders"]);
  }
}
