// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { App } from "@/entrypoints/options/App";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { CredentialRequest, SettingsRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function mount(connected = false, signInAgain = false) {
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
    const request = message as CredentialRequest | SettingsRequest;
    if (request.type === "settings.get") return { v: 1, id: request.id, ok: true, notice: null, provider: OPENAI_PROVIDER,
      settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" } };
    if (request.type === "credentials.chatgpt.login") { connected = true; signInAgain = false; }
    if (request.type === "credentials.chatgpt.notice.dismiss") signInAgain = false;
    if (request.type === "credentials.chatgpt.disconnect") connected = false;
    return { v: 1, id: request.id, ok: true, configured: false, maskedSuffix: null, notice: null,
      chatgpt: { connected, email: connected ? "user@example.test" : null, signInAgain } };
  });
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(App, {}), root));
  await vi.waitFor(() => expect(root.querySelector("select")).not.toBeNull());
  return send;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
}

describe("ChatGPT settings controls", () => {
  it("signs in with a single button through the background and asks for no PIN", async () => {
    const send = await mount();
    expect(root.textContent).toContain("Not connected.");
    expect(root.textContent).not.toMatch(/PIN|unlock/i);
    expect(root.querySelector("input[inputmode=numeric]")).toBeNull();
    await act(async () => { button("Continue with ChatGPT")!.click(); });
    await vi.waitFor(() => expect(root.textContent).toContain("Connected as user@example.test."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.login" }));
    expect(JSON.stringify(send.mock.calls)).not.toContain("pin");
    expect(button("Continue with ChatGPT")).toBeUndefined();
    expect(button("Test connection")).toBeDefined();
  });

  it("keeps Disconnect for a saved connection", async () => {
    const send = await mount(true);
    expect(root.textContent).toContain("Connected as user@example.test.");
    expect(button("Lock")).toBeUndefined();
    await act(async () => { button("Disconnect")!.click(); });
    await vi.waitFor(() => expect(root.textContent).toContain("Not connected."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.disconnect" }));
    expect(button("Continue with ChatGPT")).toBeDefined();
  });

  it("shows the one-time sign-in-again notice until dismissed", async () => {
    const send = await mount(false, true);
    expect(root.textContent).toContain("Sign in with ChatGPT again.");
    await act(async () => { button("Dismiss")!.click(); });
    await vi.waitFor(() => expect(root.textContent).not.toContain("Sign in with ChatGPT again."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.notice.dismiss" }));
    expect(button("Continue with ChatGPT")).toBeDefined();
  });

  it("clears the sign-in-again notice after signing in", async () => {
    await mount(false, true);
    await act(async () => { button("Continue with ChatGPT")!.click(); });
    await vi.waitFor(() => expect(root.textContent).toContain("Connected as user@example.test."));
    expect(root.textContent).not.toContain("Sign in with ChatGPT again.");
  });
});
