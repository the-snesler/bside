// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { App } from "@/entrypoints/options/App";
import { OPENAI_API_KEY_PROVIDER } from "@/lib/providers/openai";
import type { CredentialRequest, HistoryRequest, SettingsRequest, SkillsRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function mount(connected = false, signInAgain = false) {
  let retention = "forever";
  let sessionCount = 3;
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
    const request = message as CredentialRequest | SettingsRequest | HistoryRequest | SkillsRequest;
    if (request.type === "skills.list") return { v: 1, id: request.id, ok: true, skills: [], builtinNames: [] };
    if (request.type.startsWith("history.")) {
      let notice: string | null = null;
      if (request.type === "history.retention.save") retention = request.retention;
      if (request.type === "history.deleteAll") { notice = `Deleted ${sessionCount} chats.`; sessionCount = 1; }
      return { v: 1, id: request.id, ok: true, settings: { version: 1, retention }, sessionCount, notice };
    }
    if (request.type === "settings.get") return { v: 1, id: request.id, ok: true, notice: null, provider: OPENAI_API_KEY_PROVIDER,
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
    expect(root.textContent).not.toMatch(/\bPIN\b|unlock/i);
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

describe("History settings", () => {
  const retentionSelect = () => [...root.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Keep chats"))!.querySelector("select")!;

  it("states that history is local and contains page text, and saves retention through the background", async () => {
    const send = await mount();
    await vi.waitFor(() => expect(root.textContent).toContain("3 chats saved."));
    expect(root.textContent).toContain("only in this Firefox profile");
    expect(root.textContent).toContain("text from pages bside read");
    expect(root.textContent).toContain("Pinned chats");
    expect(retentionSelect().value).toBe("forever");
    expect([...retentionSelect().options].map((option) => option.textContent)).toEqual(["Forever", "30 days", "7 days"]);
    await act(async () => {
      retentionSelect().value = "7d";
      retentionSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "history.retention.save", retention: "7d" }));
    await vi.waitFor(() => expect(retentionSelect().value).toBe("7d"));
  });

  it("deletes all history only after an inline confirmation", async () => {
    const send = await mount();
    await vi.waitFor(() => expect(button("Delete all history")).toBeDefined());
    await act(async () => { button("Delete all history")!.click(); });
    expect(root.textContent).toContain("Delete 3 chats, including pinned ones?");
    await act(async () => { button("Cancel")!.click(); });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "history.deleteAll" }));
    await act(async () => { button("Delete all history")!.click(); });
    await act(async () => { button("Delete all")!.click(); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "history.deleteAll" }));
    await vi.waitFor(() => expect(root.textContent).toContain("Deleted 3 chats."));
    expect(root.textContent).toContain("1 chat saved.");
  });
});
