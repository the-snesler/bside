// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Editor, Transforms, type Descendant } from "slate";
import { Composer } from "@/lib/ui/Composer";
import { McpContentChip } from "@/lib/ui/McpContentChip";
import type { McpContentChoice, McpContentSnapshot } from "@/lib/domain/mcp-content";

// Drive Slate's real document/selection operations through a minimal view adapter.
// Vitest resolves slate-react's React separately from Preact (the production build aliases it).
const view = vi.hoisted(() => ({ editor: null as unknown as Editor, change: () => {} }));
vi.mock("slate-react", async () => {
  const { h } = await import("preact");
  return {
    withReact: (editor: Editor) => editor,
    ReactEditor: { focus: vi.fn() },
    Slate: ({ editor, initialValue, onChange, children }: { editor: Editor; initialValue: Descendant[]; onChange: () => void; children: unknown }) => {
      if (!editor.children.length) editor.children = initialValue;
      view.editor = editor; view.change = onChange;
      return children;
    },
    Editable: (props: Record<string, unknown>) => h("div", { role: "textbox", onKeyDown: props.onKeyDown, "aria-label": props["aria-label"], "aria-activedescendant": props["aria-activedescendant"] }),
  };
});

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });
const prompt: McpContentChoice = { id: "p1", kind: "prompt", server: "Notion", command: "mcp:notion:summarize", name: "summarize", description: "Account summary", arguments: [{ name: "topic", description: "What to summarize", required: true }, { name: "format", description: "Optional style", required: false }] };
const resource: McpContentChoice = { id: "r1", kind: "resource", server: "Notion", command: "mcp:notion:roadmap", name: "Roadmap", description: "Project notes", uri: "internal://roadmap" };
const snapshot: McpContentSnapshot = { version: 1, id: "prepared", sessionId: "s1", serverId: "notion", server: "Notion", kind: "resource", name: "Roadmap", uri: resource.uri, text: '<img src="https://bad.invalid/tracker">\nRemote text' };
const settle = () => act(async () => { await Promise.resolve(); });
async function mount(choices: McpContentChoice[]) {
  const list = vi.fn(async () => ({ choices, errors: [] }));
  const prepare = vi.fn(async (_id: string, _args: Record<string, string>) => {});
  const send = vi.fn();
  const props = { sessionId: "s1", disabled: false, running: false, working: false, canSteer: false, configured: true,
    tabs: [{ id: 1, title: "Tab title", url: "https://example.com", path: "/tabs/1/page.md" }], skills: [{ name: "summarize", description: "Saved summary" }], onListMcpContent: list, onPrepareMcpContent: prepare,
    onListTabs: vi.fn(), onListSkills: vi.fn(), onSend: send, onSteer: vi.fn(), onStop: vi.fn() };
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(Composer, props), root));
  return { list, prepare, send, props };
}
async function type(text: string) {
  await act(async () => { Transforms.select(view.editor, Editor.end(view.editor, [])); Transforms.insertText(view.editor, text); view.change(); });
  await settle();
}
async function choose(text: string) {
  const option = [...root.querySelectorAll('[role="option"]')].find(item => item.textContent?.includes(text))!;
  expect(option).toBeDefined();
  await act(async () => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await settle();
}

describe("composer MCP content", () => {
  it("discovers only on slash, keeps saved skills distinct, collects accessible arguments and prepares without sending", async () => {
    const f = await mount([prompt]);
    expect(f.list).not.toHaveBeenCalled();
    await type("/");
    expect(f.list).toHaveBeenCalledWith("prompt");
    expect(root.textContent).toContain("Saved skill");
    expect(root.textContent).toContain("/mcp:notion:summarize");
    expect(root.textContent).toContain("Notion · MCP prompt");
    await choose("/mcp:notion:summarize");
    const form = root.querySelector("form")!;
    expect(form.getAttribute("aria-label")).toBe("Prepare Notion prompt");
    const fields = [...form.querySelectorAll("input")];
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]!.required).toBe(false);
    expect(fields[0]!.maxLength).toBe(2_000);
    expect(fields[0]!.labels?.[0]?.textContent).toContain("topic (required)");
    expect(f.prepare).not.toHaveBeenCalled();
    await act(async () => { fields[0]!.value = "release"; fields[0]!.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(f.prepare).toHaveBeenCalledWith("p1", { topic: "release" });
    expect(f.send).not.toHaveBeenCalled();
    expect(Editor.string(view.editor, [])).toBe("/mcp:notion:summarize ");
  });

  it("does not insert a late prompt preparation into another chat", async () => {
    const f = await mount([prompt]);
    const gate = Promise.withResolvers<void>();
    f.prepare.mockImplementationOnce(() => gate.promise);
    await type("/");
    await choose("/mcp:notion:summarize");
    await act(async () => { root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => render(h(Composer, { ...f.props, sessionId: "s2" }), root));
    gate.resolve();
    await settle();
    expect(Editor.string(view.editor, [])).toBe("");
    expect(root.querySelector("form")).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("discovers resources beside tabs and shows bounded prepared text as a removable preview without remote images", async () => {
    const f = await mount([resource]);
    await type("@");
    expect(f.list).toHaveBeenCalledWith("resource");
    expect(root.textContent).toContain("Tab title");
    expect(root.textContent).toContain("Notion · MCP resource");
    await choose("Roadmap");
    expect(f.prepare).toHaveBeenCalledWith("r1", {});
    expect(f.send).not.toHaveBeenCalled();
    const remove = vi.fn();
    await act(async () => render(h(McpContentChip, { item: snapshot, onRemove: remove }), root));
    expect(root.querySelector("summary")!.textContent).toContain("Notion · Resource · Roadmap");
    expect(root.querySelector("pre")!.textContent).toBe(snapshot.text);
    expect(root.querySelectorAll("img,a,script")).toHaveLength(0);
    expect(root.textContent).toContain("internal://roadmap");
    await act(async () => root.querySelector("button")!.click());
    expect(remove).toHaveBeenCalledOnce();
  });
});

// This exercises the actual sidebar transport, including opaque id submission and acceptance.
import { useBackground } from "@/lib/ui/use-background";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import { EMPTY_USAGE } from "@/lib/domain/usage";
import type { SidebarCommand, SidebarEvent, RuntimeSnapshot } from "@/lib/protocol";

it("keeps previews after a refused send and sends only prepared ids until background acceptance", async () => {
  const posted: SidebarCommand[] = [];
  let receive = (_event: SidebarEvent) => {};
  vi.spyOn(browser.runtime, "connect").mockReturnValue({
    postMessage: (message: SidebarCommand) => posted.push(message),
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; }, removeListener: () => {} },
    disconnect: () => {},
  } as never);
  let background: ReturnType<typeof useBackground>;
  function Harness() { background = useBackground(); return null; }
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(Harness, {}), root));
  const state: RuntimeSnapshot = { conversation: { id: "s1", title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: 0, lastModelId: null, usage: EMPTY_USAGE, items: [] },
    credential: { configured: true, maskedSuffix: null, chatgpt: { connected: false, email: null, signInAgain: false } }, provider: OPENAI_PROVIDER,
    settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" }, permissionMode: "ask", page: null, ask: null, agentTabs: { bySession: {}, watching: null, takenOver: false }, queue: [], runs: [], notice: null };
  const emit = (type: string, payload: unknown) => act(async () => receive({ v: 1, runId: null, conversationId: "s1", seq: 0, at: 1, type, payload } as SidebarEvent));
  await emit("state.snapshot", state);
  let listing: ReturnType<typeof background.listMcpContent>;
  await act(async () => { listing = background.listMcpContent("resource"); });
  expect(posted.at(-1)).toMatchObject({ type: "mcp.content.list", sessionId: "s1", kind: "resource" });
  await emit("mcp.content.reply", { requestId: posted.at(-1)!.id, result: { ok: true, choices: [resource], errors: [] } });
  expect((await listing!).choices).toEqual([resource]);
  let preparing: Promise<void>;
  await act(async () => { preparing = background.prepareMcpContent("r1", {}); });
  await emit("mcp.content.reply", { requestId: posted.at(-1)!.id, result: { ok: true, snapshot } });
  await preparing!;
  await settle();
  expect(background!.mcpAttachments).toEqual([snapshot]);
  await act(async () => background.sendPrompt("Read it", undefined, [snapshot.id]));
  expect(posted.at(-1)).toMatchObject({ type: "run.start", prompt: "Read it", sessionId: "s1", contentIds: ["prepared"] });
  expect(JSON.stringify(posted.at(-1))).not.toMatch(/Remote text|internal:\/\/roadmap|Roadmap/);
  await emit("state.snapshot", { ...state, notice: "Could not send. Try again." });
  expect(background!.mcpAttachments).toEqual([snapshot]);
  await emit("mcp.content.accepted", { ids: [snapshot.id] });
  expect(background!.mcpAttachments).toEqual([]);
});
