import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";

const methods = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}), dispose: vi.fn(),
  handleAutomationRequest: vi.fn(async () => ({ ok: true })),
  handleContentMessage: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/background/runtime", () => ({ BackgroundRuntime: class { constructor() { Object.assign(this, methods); } } }));
vi.mock("@/lib/sites", () => ({ registerSiteRequestHeaders: vi.fn() }));
vi.mock("@/lib/background/context-menu", () => ({ registerEntryPoints: vi.fn() }));
import background from "@/entrypoints/background";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => { fakeBrowser.reset(); vi.clearAllMocks(); });

describe("background automation adapter", () => {
  it("accepts automation only from this extension's exact options page, including hash routes", async () => {
    vi.stubGlobal("addEventListener", vi.fn());
    vi.spyOn(browser.runtime, "getManifest").mockReturnValue({ version: "0.1.0" } as Browser.runtime.Manifest);
    for (const event of [browser.runtime.onConnect, browser.browserAction.onClicked, browser.tabs.onActivated, browser.tabs.onCreated, browser.tabs.onUpdated, browser.alarms.onAlarm]) vi.spyOn(event, "addListener").mockImplementation(() => {});
    const onMessage = vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation(() => {});
    background.main();
    const listener = onMessage.mock.calls[0]![0];
    const request = { v: 1, id: "schedule", type: "automation.get" };
    const options = browser.runtime.getURL("/options.html");
    const sender = { id: browser.runtime.id, url: `${options}#/automation`, frameId: 0 };
    await listener(request, sender as Browser.runtime.MessageSender, vi.fn());
    expect(methods.handleAutomationRequest).toHaveBeenCalledOnce();
    for (const rejected of [
      { ...sender, id: "another-extension" },
      { ...sender, url: browser.runtime.getURL("/sidepanel.html") },
      { ...sender, url: `${options}?pretend=1` },
      { ...sender, url: "https://example.test/options.html", tab: { id: 1 }, frameId: 0 },
      { ...sender, url: "https://example.test/", tab: { id: 1 }, frameId: 2 },
    ]) expect(listener(request, rejected as Browser.runtime.MessageSender, vi.fn())).toBeUndefined();
    expect(methods.handleAutomationRequest).toHaveBeenCalledOnce();
    expect(methods.handleContentMessage).not.toHaveBeenCalled();
    const invalid = { ...request, type: "automation.notifications.save", enabled: "true" };
    expect(listener(invalid, sender as Browser.runtime.MessageSender, vi.fn())).toBeUndefined();
  });
});
