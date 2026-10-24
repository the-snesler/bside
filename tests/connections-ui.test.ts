// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { App } from "@/entrypoints/options/App";
import { searchPages } from "@/entrypoints/options/navigation";
import { SETTINGS_PAGES } from "@/entrypoints/options/pages";
import { OPENAI_API_KEY_PROVIDER } from "@/lib/providers/openai";
import type { McpServerStatus } from "@/lib/domain/mcp";
import type { McpRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => {
  if (root) render(null, root);
  document.body.innerHTML = "";
  history.replaceState(null, "", location.pathname);
  vi.restoreAllMocks();
});

const tool = (name: string, readOnly: boolean, destructive: boolean, enabled = true, unavailable: string | null = null): McpServerStatus["tools"][number] => ({
  name, title: null, description: `[Notion] ${name} <b>does</b> things.`, inputSchema: unavailable ? null : { type: "object" }, readOnly, destructive, unavailable, enabled,
});

function server(id: "notion" | "todoist", patch: Partial<McpServerStatus> = {}): McpServerStatus {
  return { id, name: id === "notion" ? "Notion" : "Todoist", description: `${id} description`, icon: id === "notion" ? "brand-notion" : "checklist",
    status: "disconnected", error: null, trust: "confirm-writes", tools: [], toolsAt: null, ...patch };
}

async function mount(initial: McpServerStatus[]) {
  let servers = initial;
  const requests: McpRequest[] = [];
  history.replaceState(null, "", `${location.pathname}#/connections`);
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
    const request = message as { id: string; type: string };
    if (request.type.startsWith("mcp.")) {
      const mcp = message as McpRequest;
      requests.push(mcp);
      let notice: string | null = null;
      if (mcp.type === "mcp.connect") {
        servers = servers.map((entry) => entry.id === mcp.server ? { ...entry, status: "connected", toolsAt: 1,
          tools: [tool("notion-search", true, false), tool("notion-update", false, false), tool("notion-delete", false, true, false), tool("huge", false, true, false, "Its input schema is too large.")] } : entry);
      }
      if (mcp.type === "mcp.disconnect") {
        servers = servers.map((entry) => entry.id === mcp.server ? { ...entry, status: "disconnected", tools: [] } : entry);
        notice = "Disconnected. Notion did not confirm that bside's access was revoked.";
      }
      if (mcp.type === "mcp.tool.toggle") servers = servers.map((entry) => ({ ...entry, tools: entry.tools.map((candidate) => candidate.name === mcp.tool ? { ...candidate, enabled: mcp.enabled } : candidate) }));
      if (mcp.type === "mcp.trust.save") servers = servers.map((entry) => entry.id === mcp.server ? { ...entry, trust: mcp.trust } : entry);
      return { v: 1, id: request.id, ok: true, servers, enabledTools: servers.flatMap((entry) => entry.tools).filter((candidate) => candidate.enabled).length, maxTools: 64, notice };
    }
    if (request.type === "settings.get") return { v: 1, id: request.id, ok: true, notice: null, provider: OPENAI_API_KEY_PROVIDER,
      settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" } };
    return { v: 1, id: request.id, ok: true, configured: true, maskedSuffix: "abcd", notice: null, chatgpt: { connected: false, email: null, signInAgain: false } };
  });
  root = document.createElement("div");
  document.body.append(root);
  await act(async () => render(h(App, {}), root));
  await vi.waitFor(() => expect(root.querySelector(".settings-connection__name")).not.toBeNull());
  return requests;
}

const byLabel = <T extends Element>(label: string) => root.querySelector<T>(`[aria-label="${label}"]`)!;

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click(); });
}

describe("Connections settings page", () => {
  it("is in the registry and found by searching for a service", () => {
    expect(searchPages(SETTINGS_PAGES, "todoist").map((match) => match.page.id)).toContain("connections");
    expect(searchPages(SETTINGS_PAGES, "mcp").map((match) => match.page.id)).toContain("connections");
  });

  it("lists the directory with Connect buttons and the confirmation level", async () => {
    await mount([server("notion"), server("todoist")]);
    expect(root.querySelector("h1")?.textContent).toBe("Connections");
    expect(root.textContent).toContain("Not connected.");
    expect(byLabel<HTMLButtonElement>("Connect Todoist").textContent).toBe("Connect");
    expect(root.querySelector<HTMLSelectElement>("#mcp-trust-notion")!.value).toBe("confirm-writes");
    expect(root.querySelector("svg.settings-connection__icon")).not.toBeNull();
  });

  it("connects, then shows each tool's switch with read-only/write badges, as text", async () => {
    const requests = await mount([server("notion"), server("todoist")]);
    await click(byLabel("Connect Notion"));
    await vi.waitFor(() => expect(root.textContent).toContain("Connected Notion."));
    expect(requests.at(-1)).toMatchObject({ type: "mcp.connect", server: "notion" });
    const switches = [...root.querySelectorAll<HTMLInputElement>("input[role=switch]")];
    expect(switches.map((input) => [input.id, input.checked, input.disabled])).toEqual([
      ["mcp-tool-notion-notion-search", true, false],
      ["mcp-tool-notion-notion-update", true, false],
      ["mcp-tool-notion-notion-delete", false, false],
      ["mcp-tool-notion-huge", false, true],
    ]);
    expect([...root.querySelectorAll(".settings-badge")].map((badge) => badge.textContent)).toEqual(["Read-only", "Writes", "Can delete", "Can delete"]);
    expect(root.querySelector(".settings-connection__tool b")).toBeNull();
    expect(root.textContent).toContain("notion-search <b>does</b> things.");
    expect(root.textContent).not.toContain("[Notion]");
    expect(root.textContent).toContain("Its input schema is too large.");
    expect(root.textContent).toContain("2 of at most 64 tools are on");
  });

  it("toggles a tool, changes the trust level, refreshes, and disconnects with the server's notice", async () => {
    const requests = await mount([server("notion", { status: "connected", toolsAt: 1, tools: [tool("notion-search", true, false), tool("notion-delete", false, true)] }), server("todoist")]);
    await click(root.querySelector("#mcp-tool-notion-notion-delete")!);
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>("#mcp-tool-notion-notion-delete")!.checked).toBe(false));
    expect(requests.at(-1)).toEqual(expect.objectContaining({ type: "mcp.tool.toggle", server: "notion", tool: "notion-delete", enabled: false }));

    const select = root.querySelector<HTMLSelectElement>("#mcp-trust-notion")!;
    await act(async () => {
      select.value = "model";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(requests.at(-1)).toEqual(expect.objectContaining({ type: "mcp.trust.save", server: "notion", trust: "model" }));
    await vi.waitFor(() => expect(root.textContent).toContain("as it does on web pages"));

    await click(byLabel("Refresh Notion tools"));
    expect(requests.at(-1)).toEqual(expect.objectContaining({ type: "mcp.refresh", server: "notion" }));

    await click(byLabel("Disconnect Notion"));
    await vi.waitFor(() => expect(root.textContent).toContain("did not confirm that bside's access was revoked"));
    expect(byLabel("Connect Notion")).not.toBeNull();
  });

  it("asks the user to reconnect a server that signed bside out", async () => {
    await mount([server("notion", { status: "needs-reauth", tools: [tool("notion-search", true, false)] }), server("todoist")]);
    expect(root.querySelector(".settings-banner")?.textContent).toContain("Notion signed bside out.");
    expect(byLabel<HTMLButtonElement>("Connect Notion").textContent).toBe("Reconnect");
  });
});
