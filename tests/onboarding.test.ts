// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { registerOnboarding } from "@/lib/background/onboarding";
import { App } from "@/entrypoints/onboarding/App";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("first-run onboarding", () => {
  it("opens only the local welcome page on install, never on update or startup", async () => {
    const listeners: ((details: { reason: string }) => void)[] = [];
    const create = vi.fn(async () => ({}));
    registerOnboarding({ runtime: { getURL: (path) => `moz-extension://fixture${path}`, onInstalled: { addListener: (fn) => { listeners.push(fn); } } }, tabs: { create } });
    expect(create).not.toHaveBeenCalled();
    listeners[0]!({ reason: "update" });
    expect(create).not.toHaveBeenCalled();
    listeners[0]!({ reason: "install" });
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: "moz-extension://fixture/onboarding.html" });
  });

  it("needs a click to open the sidebar and never starts sign-in or the sample", async () => {
    const open = vi.fn(async () => {});
    // WXT's fake Chrome-compatible API has no Firefox sidebarAction.
    Object.defineProperty(browser, "sidebarAction", { configurable: true, value: { open } });
    const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
    const root = document.createElement("div"); document.body.append(root);
    await act(async () => render(h(App, {}), root));
    expect(open).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLAnchorElement>('a[href="/options.html#/account"]')).not.toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>("#welcome-sample")!.readOnly).toBe(true);
    const button = root.querySelector("button")!;
    button.click();
    // Called synchronously, before a promise/timer could lose the gesture.
    expect(open).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    render(null, root);
    Reflect.deleteProperty(browser, "sidebarAction");
  });
});
