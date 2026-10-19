import { describe, expect, it, vi } from "vitest";
import { FirefoxChatGPTAuthBrowser, type ChatGPTBrowserApi } from "@/lib/background/chatgpt-browser-auth";

const REDIRECT = "http://127.0.0.1:1455/mozoauth2/test-addon";

function harness() {
  let request: Parameters<ChatGPTBrowserApi["webRequest"]["onBeforeRequest"]["addListener"]>[0] | undefined;
  let removed: Parameters<ChatGPTBrowserApi["tabs"]["onRemoved"]["addListener"]>[0] | undefined;
  const api: ChatGPTBrowserApi = {
    identity: { getRedirectURL: () => "https://test-addon.extensions.allizom.org/" },
    windows: { create: vi.fn(async () => ({ id: 7, tabs: [{ id: 42 }] })), remove: vi.fn(async () => {}) },
    tabs: { update: vi.fn(async () => { expect(request).toBeDefined(); expect(removed).toBeDefined(); }),
      onRemoved: { addListener: vi.fn((listener) => { removed = listener; }), removeListener: vi.fn() } },
    webRequest: { onBeforeRequest: { addListener: vi.fn((listener) => { request = listener; }), removeListener: vi.fn() } },
  };
  return { api, auth: new FirefoxChatGPTAuthBrowser(api), callback: (url: string, tabId = 42, type = "main_frame") => request!({ url, tabId, type }),
    close: (tabId = 42) => removed!(tabId) };
}

async function ready() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

describe("Firefox OAuth callback interception", () => {
  it("registers before navigation, cancels the exact callback, and removes listeners and the popup", async () => {
    const h = harness();
    const result = h.auth.authorize("https://auth.openai.com/api/accounts/authorize", REDIRECT, new AbortController().signal);
    await ready();
    expect(h.api.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: "about:blank", type: "popup" }));
    expect(h.api.webRequest.onBeforeRequest.addListener).toHaveBeenCalledWith(expect.any(Function),
      { urls: ["http://127.0.0.1/mozoauth2/test-addon*"], types: ["main_frame"], tabId: 42 }, ["blocking"]);
    const returned = `${REDIRECT}?code=test-code&state=test-state`;
    expect(h.callback(returned)).toEqual({ cancel: true });
    await expect(result).resolves.toBe(returned);
    expect(h.api.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledOnce();
    expect(h.api.tabs.onRemoved.removeListener).toHaveBeenCalledOnce();
    expect(h.api.windows.remove).toHaveBeenCalledWith(7);
  });

  it("ignores other tabs, ports, paths, and subframes", async () => {
    const h = harness();
    const result = h.auth.authorize("https://auth.openai.com/", REDIRECT, new AbortController().signal);
    await ready();
    expect(h.callback(REDIRECT, 99)).toEqual({});
    expect(h.callback(REDIRECT, 42, "sub_frame")).toEqual({});
    expect(h.callback(REDIRECT.replace(":1455", ":54321"))).toEqual({});
    expect(h.callback(`${REDIRECT}-forged`)).toEqual({});
    h.close(99);
    expect(h.api.windows.remove).not.toHaveBeenCalled();
    h.callback(`${REDIRECT}?error=access_denied&state=test-state`);
    await expect(result).resolves.toContain("access_denied");
  });

  it("rejects a closed popup and cleans up", async () => {
    const h = harness();
    const result = h.auth.authorize("https://auth.openai.com/", REDIRECT, new AbortController().signal);
    await ready(); h.close();
    await expect(result).rejects.toMatchObject({ code: "AUTHENTICATION", message: expect.stringContaining("cancelled") });
    expect(h.api.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledOnce();
  });

  it("closes the popup and removes listeners on timeout", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.auth.authorize("https://auth.openai.com/", REDIRECT, controller.signal);
    await ready(); controller.abort();
    await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(h.api.windows.remove).toHaveBeenCalledWith(7);
    expect(h.api.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledOnce();
  });

  it("cleans up when navigation fails without forwarding browser error text", async () => {
    const h = harness();
    vi.mocked(h.api.tabs.update).mockRejectedValue(new Error("private URL?code=test-secret"));
    await expect(h.auth.authorize("https://auth.openai.com/", REDIRECT, new AbortController().signal)).rejects.toMatchObject({ code: "NETWORK", message: expect.not.stringContaining("test-secret") });
    expect(h.api.windows.remove).toHaveBeenCalledWith(7);
    expect(h.api.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledOnce();
  });
});
