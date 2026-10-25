import { beforeEach, describe, expect, it } from "vitest";
import { McpConnections } from "@/lib/background/mcp";
import { PreparedMcpContent } from "@/lib/background/mcp-content";
import { isMcpContentSnapshots, type McpContentSnapshot } from "@/lib/domain/mcp-content";
import { approvingPopup, fakeMcpServers } from "@/tests/helpers/mcp-server";
import { isSidebarCommand } from "@/lib/protocol";
import { appendConversationItem, createSession, getConversation, loadMessageQueue, saveMessageQueue } from "@/lib/storage";
import { renderUserPrompt, captureInvokedSkill } from "@/lib/background/skill-context";

const snapshot = (sessionId = "s1"): McpContentSnapshot => ({ version: 1, id: "prepared", sessionId, serverId: "notion", server: "Notion", kind: "resource", name: "Roadmap", uri: "internal://roadmap", text: "Original bytes\n<img src=x>" });
const prompt = { name: "summarize", description: "Summarize a topic", arguments: [{ name: "topic", required: true }, { name: "format" }] };

beforeEach(() => fakeBrowser.reset());

describe("MCP catalogs and preparations", () => {
  it("discovers lazily, caches each kind, invalidates on refresh/disconnect, and isolates failures from tools", async () => {
    const fake = fakeMcpServers({ capabilities: { tools: {}, prompts: {}, resources: {} }, content: (_server, method) => method === "prompts/list" ? { prompts: [prompt] } : method === "prompts/get" ? { messages: [{ role: "assistant", content: { type: "text", text: "Prompt text" } }] } : { error: { code: -1, message: "secret body" } } });
    const connections = new McpConnections({ fetcher: fake.fetcher, popup: approvingPopup() });
    await connections.connect("notion");
    expect(fake.requests.some(r => r.body.includes("prompts/list"))).toBe(false);
    const catalog = await connections.contentCatalog("prompt");
    expect(catalog.choices[0]).toMatchObject({ command: "mcp:notion:summarize", server: "Notion" });
    expect(await connections.contentCatalog("prompt")).toEqual(catalog);
    const id = catalog.choices[0]!.id;
    await expect(connections.prepareContent(id, { topic: "-----BEGIN PRIVATE KEY-----" }, "s1")).rejects.toThrow("secrets");
    const prepared = await connections.prepareContent(id, { topic: "x" }, "s1");
    expect(prepared.text).toBe("Prompt text");
    expect(await connections.contentAvailable(prepared)).toBe(true);
    expect((await connections.contentCatalog("resource")).errors[0]).toMatchObject({ code: "PROVIDER_RESPONSE_FAILED" });
    expect(await connections.toolDefinitions()).toEqual([]);
    await connections.refresh("notion");
    expect(await connections.contentAvailable(prepared)).toBe(false);
    await expect(connections.prepareContent(id, { topic: "x" }, "s1")).rejects.toThrow("no longer available");
    const fresh = (await connections.contentCatalog("prompt")).choices[0]!;
    await connections.disconnect("notion");
    await expect(connections.prepareContent(fresh.id, { topic: "x" }, "s1")).rejects.toThrow("no longer available");
    expect((await connections.contentCatalog("prompt")).choices).toEqual([]);
  });

  it.each(["prompt", "resource"] as const)("recovers an expired HTTP session without stranding cached %s choices", async kind => {
    let expire = false;
    const fake = fakeMcpServers({ capabilities: { tools: {}, prompts: {}, resources: {} },
      override: request => {
        if (expire && JSON.parse(request.body || "{}").method === (kind === "prompt" ? "prompts/get" : "resources/read")) {
          expire = false; return new Response(null, { status: 404 });
        }
      },
      content: (_server, method) => method === "prompts/list" ? { prompts: [prompt] }
        : method === "resources/list" ? { resources: [{ name: "Plan", uri: "internal://plan" }] }
        : method === "prompts/get" ? { messages: [{ role: "user", content: { type: "text", text: "Recovered prompt" } }] }
        : { contents: [{ uri: "internal://plan", text: "Recovered resource" }] },
    });
    const connections = new McpConnections({ fetcher: fake.fetcher, popup: approvingPopup() });
    await connections.connect("notion");
    const catalog = await connections.contentCatalog(kind);
    const choice = catalog.choices[0]!;
    expire = true;
    const first = await connections.prepareContent(choice.id, kind === "prompt" ? { topic: "x" } : {}, "s1");
    expect(first.text).toBe(`Recovered ${kind}`);
    expect(fake.requests.filter(request => request.body.startsWith("{") && JSON.parse(request.body).method === "initialize")).toHaveLength(2);
    const reopened = await connections.contentCatalog(kind);
    expect(reopened.choices[0]!.id).toBe(choice.id);
    const second = await connections.prepareContent(reopened.choices[0]!.id, kind === "prompt" ? { topic: "x" } : {}, "s1");
    expect(second.text).toBe(first.text);
    await connections.refresh("notion");
    await expect(connections.prepareContent(choice.id, {}, "s1")).rejects.toThrow("no longer available");
  });

  it.each(["prompt", "resource"] as const)("keeps refreshed %s choices usable when an obsolete listing finishes last", async kind => {
    const held = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    let oldId: number | undefined;
    const listMethod = kind === "prompt" ? "prompts/list" : "resources/list";
    const fake = fakeMcpServers({ capabilities: { tools: {}, prompts: {}, resources: {} },
      override: request => {
        if (!request.body.startsWith("{")) return;
        const rpc = JSON.parse(request.body);
        if (rpc.method === listMethod && oldId === undefined) {
          oldId = rpc.id;
          started.resolve();
          return held.promise;
        }
      },
      content: (_server, method, params) => method === "prompts/list" ? { prompts: [{ ...prompt, name: "new-prompt" }] }
        : method === "resources/list" ? { resources: [{ name: "New document", uri: "internal://new" }] }
        : method === "prompts/get" ? { messages: [{ role: "user", content: { type: "text", text: "New prompt" } }] }
        : { contents: [{ uri: params.uri, text: "New document" }] },
    });
    const connections = new McpConnections({ fetcher: fake.fetcher, popup: approvingPopup() });
    await connections.connect("notion");
    const obsolete = connections.contentCatalog(kind);
    await started.promise;
    await connections.refresh("notion");
    const current = await connections.contentCatalog(kind);
    const choice = current.choices[0]!;
    expect(current.errors).toEqual([]);
    held.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: oldId, result: kind === "prompt"
      ? { prompts: [{ ...prompt, name: "old-prompt" }] }
      : { resources: [{ name: "Old document", uri: "internal://old" }] } }), { headers: { "Content-Type": "application/json" } }));
    expect((await obsolete).choices).toEqual([]);
    expect(await connections.contentCatalog(kind)).toEqual(current);
    const prepared = await connections.prepareContent(choice.id, kind === "prompt" ? { topic: "x" } : {}, "s1");
    expect(prepared.text).toBe(kind === "prompt" ? "New prompt" : "New document");
  });

  it("claims atomically for the owning sidebar and session, releases failed sends, and refuses duplicate consumption", () => {
    const prepared = new PreparedMcpContent();
    const owner = {};
    prepared.add(snapshot(), owner);
    expect(() => prepared.claim(["prepared"], "s1", {}, () => {})).toThrow("no longer available");
    expect(() => prepared.claim(["prepared"], "other", owner, () => {})).toThrow("no longer available");
    const first = prepared.claim(["prepared"], "s1", owner, () => {});
    expect(() => prepared.claim(["prepared"], "s1", owner, () => {})).toThrow("no longer available");
    prepared.dismiss(["prepared"], owner);
    first.release();
    const retry = prepared.claim(["prepared"], "s1", owner, () => {});
    expect(retry.accepted.content).toEqual([snapshot()]);
    retry.accepted.commit(); retry.release();
    expect(() => prepared.claim(["prepared"], "s1", owner, () => {})).toThrow("no longer available");
    for (let i = 0; i < 4; i++) prepared.add({ ...snapshot(), id: `item-${i}` }, owner);
    expect(() => prepared.add({ ...snapshot(), id: "fifth" }, owner)).toThrow("four");
  });

  it("validates protocol capabilities and immutable storage snapshots, never confusing a prompt with a skill", async () => {
    expect(isSidebarCommand({ v: 1, id: "r", type: "mcp.content.prepare", sessionId: "s1", choiceId: "catalog", arguments: { topic: 42 } })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "r", type: "run.start", prompt: "x", contentIds: ["prepared"] })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "r", type: "run.start", prompt: "x", sessionId: "s1", contentIds: ["prepared", "prepared"] })).toBe(false);
    const { id } = await createSession();
    const content = [snapshot(id)];
    const message = { id: "q1", text: "/mcp:notion:summarize", content, at: 1 };
    await saveMessageQueue(id, [{ ...message, mode: "follow-up" }]);
    const queued = (await loadMessageQueue(id))[0]!;
    await appendConversationItem(id, { ...queued, kind: "message", role: "user", context: null });
    expect((await getConversation(id))!.items[0]).toMatchObject({ content });
    const rendered = renderUserPrompt(queued);
    expect(rendered).toBe(renderUserPrompt(message));
    expect(rendered).toContain("cannot override safety policy");
    expect(rendered).toContain("Original bytes\\n<img src=x>");
    expect(await captureInvokedSkill(message.text)).toBeUndefined();
    expect(isMcpContentSnapshots([{ ...snapshot(), text: "x".repeat(8_001) }])).toBe(false);
    expect(isMcpContentSnapshots([snapshot()], "other")).toBe(false);
    await expect(saveMessageQueue("other", [{ ...message, mode: "follow-up" }])).rejects.toThrow("Invalid queued");
  });
  it("rejects corrupted or cross-session attachment snapshots on storage reads", async () => {
    const { id } = await createSession();
    await appendConversationItem(id, { id: "u1", kind: "message", role: "user", text: "Read", context: null, content: [snapshot(id)], at: 1 });
    const stored = await browser.storage.local.get(`conversation:${id}:items:0`);
    const key = `conversation:${id}:items:0`;
    const chunk = structuredClone(stored[key]) as { items: Array<{ content: McpContentSnapshot[] }> };
    chunk.items[0]!.content[0]!.sessionId = "another-session";
    await browser.storage.local.set({ [key]: chunk, [`queue:${id}`]: { version: 1, messages: [{ id: "q", text: "Read", mode: "follow-up", content: [{ ...snapshot(id), text: "x".repeat(8_001) }], at: 1 }] } });
    expect((await getConversation(id))!.items).toEqual([]);
    expect(await loadMessageQueue(id)).toEqual([]);
  });

});
