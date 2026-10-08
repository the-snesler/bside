// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { App } from "@/entrypoints/options/App";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { CredentialRequest, SettingsRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function mount(locked = false) {
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
    const request = message as CredentialRequest | SettingsRequest;
    if (request.type === "settings.get") return { v: 1, id: request.id, ok: true, notice: null, provider: OPENAI_PROVIDER,
      settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" } };
    return { v: 1, id: request.id, ok: true, configured: false, maskedSuffix: null, notice: null,
      chatgpt: { connected: locked || request.type === "credentials.chatgpt.login", locked: locked && request.type !== "credentials.chatgpt.unlock", email: null } };
  });
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(App, {}), root));
  await vi.waitFor(() => expect(root.querySelector("select")).not.toBeNull());
  return send;
}

describe("ChatGPT settings controls", () => {
  it("requires a valid PIN, opens login through the background, and clears the input", async () => {
    const send = await mount();
    const pin = root.querySelector<HTMLInputElement>("input[inputmode=numeric]")!;
    const connect = root.querySelector<HTMLButtonElement>("button[type=submit]")!;
    expect(connect.disabled).toBe(true);
    await act(async () => { pin.value = "12345678"; pin.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(connect.disabled).toBe(false);
    await act(async () => { connect.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(root.textContent).toContain("Connected."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.login", pin: "12345678" }));
    expect(root.textContent).toContain("Connected.");
    expect(root.textContent).toContain("Test connection");
    expect(root.querySelector("input[inputmode=numeric]")).toBeNull();
    expect(root.innerHTML).not.toContain("12345678");
  });

  it("unlocks a saved connection and offers sign-in recovery for a forgotten PIN", async () => {
    const send = await mount(true);
    expect(root.textContent).toContain("Locked. Enter your PIN to continue.");
    expect(root.textContent).toContain("Sign in again");
    expect(root.textContent).not.toContain("Test connection");
    const pin = root.querySelector<HTMLInputElement>("input[inputmode=numeric]")!;
    await act(async () => { pin.value = "12345678"; pin.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { pin.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(root.textContent).toContain("Test connection"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.unlock", pin: "12345678" }));
    expect(root.textContent).toContain("Test connection");
    expect(root.textContent).not.toContain("12345678");
  });
});
