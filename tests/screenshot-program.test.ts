import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, MAX_RUN_IMAGES } from "@/lib/background/agent-loop";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { listMemories, runMemory } from "@/lib/background/memory";
import type { MemoryApproval } from "@/lib/domain/memory";
import { buildRunDigest } from "@/lib/domain/run-digest";
import { saveMemorySettings } from "@/lib/storage";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController, type CaptureOptions, type TabControllerBrowserApi, type TabSnapshot } from "@/lib/background/tab-controller";
import type { ConversationItem } from "@/lib/domain/conversation";
import type { ProviderAdapter, ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";
import type { CaptureGeometry, DomAction, ElementTarget } from "@/lib/domain/tools";
import { WORKSPACE_MAX_BINARY_BYTES, WORKSPACE_MAX_BINARY_TOTAL_BYTES } from "@/lib/validation";
import { splitSystemMessage, TEST_MODEL, toPiStream, type ScriptedProviderEvent } from "@/tests/helpers/pi-provider";

/** Base64 for the fake image; tests assert it never lands anywhere persisted. */
const IMAGE_BASE64 = "SU1BR0VCWVRFUw".repeat(40);

/** A fake tab API: one user tab (1) and one hidden agent tab (2), each with a current document. */
function fakeTabs() {
  const tabs = new Map<number, TabSnapshot>([
    [1, { id: 1, url: "https://example.com/", title: "Example", hidden: false }],
    [2, { id: 2, url: "https://agent.example/", title: "Agent", hidden: true }],
  ]);
  const prepared: { tabId: number; target: ElementTarget | null }[] = [];
  const captures: { tabId: number; options: CaptureOptions }[] = [];
  const executed: DomAction[] = [];
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [...tabs.values()]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      show: vi.fn(async (id: number) => { tabs.get(id)!.hidden = false; }),
      hide: vi.fn(async (id: number) => { tabs.get(id)!.hidden = true; return [id]; }),
      captureTab: vi.fn(async (tabId: number, options: CaptureOptions) => {
        captures.push({ tabId, options });
        return `data:image/${options.format};base64,${IMAGE_BASE64}`;
      }),
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        const request = message as { id: string; type: string; target?: ElementTarget | null; offset?: number; maxChars?: number };
        const documentId = `doc-${tabId}`;
        const url = tabs.get(tabId)!.url!;
        if (request.type === "page.snapshot") {
          const text = '[e1 button "Chart"]';
          return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot: { version: 2, tabId, documentId, url, title: "T", text, offset: 0, end: text.length, totalChars: text.length, selectionText: "" } };
        }
        if (request.type === "page.capture-prepare") {
          prepared.push({ tabId, target: request.target ?? null });
          if (request.target?.kind === "ref" && request.target.documentId !== documentId) {
            return { v: 1, id: request.id, ok: false, error: { code: "STALE_SNAPSHOT", message: "Ref e1 came from an earlier page load.", retryable: false, phase: "page" } };
          }
          const geometry: CaptureGeometry = {
            documentId, url, title: "T", viewport: { x: 0, y: 0, width: 1280, height: 800 }, page: { width: 1280, height: 2400 },
            element: request.target ? { x: 100, y: 200, width: 300, height: 150 } : null,
          };
          return { v: 1, id: request.id, ok: true, type: "page.capture-prepare", geometry };
        }
        if (request.type === "page.capture-done") return { v: 1, id: request.id, ok: true, type: "page.capture-done" };
        if (request.type === "page.execute") {
          executed.push((message as { action: DomAction }).action);
          return { v: 1, id: request.id, ok: true, type: "page.execute", result: { ok: true, summary: "Attached." }, documentId };
        }
        throw new Error(`unexpected ${request.type}`);
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return { api, tabs, prepared, captures, executed };
}

function setupProgram(maxImages = 3, options: { files?: ScratchFiles; memory?: boolean } = {}) {
  const fake = fakeTabs();
  const state = new WorkspaceState();
  state.adoptTab(2, "s1");
  const files = options.files ?? new ScratchFiles();
  const memory = options.memory ? runMemory("s1", "r1") : undefined;
  const program = new BrowserProgram(new TabController(fake.api, async () => false), { state, runId: "r1", sessionId: "s1", files, maxImages, memory }, () => {});
  const run = (source: string) => program.execute(source, new AbortController().signal);
  return { ...fake, state, program, run, files };
}

describe("page.screenshot()", () => {
  it("attaches a viewport image and prints a placeholder, never the bytes", async () => {
    const { run, program, captures } = setupProgram();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.screenshot();');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toBe("[screenshot 1280x800 of https://example.com/] (image 1 of this result)");
    expect(captures).toEqual([{ tabId: 1, options: { format: "jpeg", quality: 70, rect: { x: 0, y: 0, width: 1280, height: 800 }, scale: 1 } }]);
    expect(JSON.stringify(result)).not.toContain(IMAGE_BASE64);
    expect(program.takeImages()).toEqual([{ mimeType: "image/jpeg", data: IMAGE_BASE64, placeholder: "[screenshot 1280x800 of https://example.com/]" }]);
    // Handed over once.
    expect(program.takeImages()).toEqual([]);
  });

  it("captures the whole page with fullPage, and an agent tab like any other", async () => {
    const { run, program, captures } = setupProgram();
    const result = await run('await browser.tab("/agent-tabs/2/page.md").screenshot({fullPage: true});');
    expect(result.ok, result.summary).toBe(true);
    expect(captures[0]).toMatchObject({ tabId: 2, options: { rect: { x: 0, y: 0, width: 1280, height: 2400 } } });
    expect(program.takeImages()).toHaveLength(1);
  });

  it("crops to a ref from the latest snapshot, on the page or the locator", async () => {
    const { run, prepared, captures } = setupProgram();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.snapshot(); await page.screenshot({ref: "e1"}); await page.ref("e1").screenshot();');
    expect(result.ok, result.summary).toBe(true);
    const target = { kind: "ref", ref: "e1", documentId: "doc-1" };
    expect(prepared).toEqual([{ tabId: 1, target }, { tabId: 1, target }]);
    expect(captures[0]!.options.rect).toEqual({ x: 100, y: 200, width: 300, height: 150 });
    expect(result.summary).toContain("[screenshot 300x150 of https://example.com/] (image 2 of this result)");
  });

  it("refuses a ref before any snapshot, and a ref the page reports as stale", async () => {
    const { run, state, captures } = setupProgram();
    const unread = await run('await browser.tab("/tabs/1/page.md").screenshot({ref: "e1"});');
    expect(unread).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    state.observed.set(1, { documentId: "doc-old", frames: {} });
    const stale = await run('await browser.tab("/tabs/1/page.md").ref("e1").screenshot();');
    expect(stale).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    expect(captures).toEqual([]);
  });

  it.each([
    ['screenshot({full: true})', "Unsupported screenshot option full"],
    ['screenshot({fullPage: "yes"})', "fullPage must be true or false"],
    ['screenshot({fullPage: true, ref: "e1"})', "either fullPage or ref"],
    ['screenshot({ref: "#main"})', 'ref must look like "e12"'],
    ['screenshot("viewport")', "takes an optional options object"],
    ['screenshot({}, {})', "takes 0–1 argument"],
  ])("validates options: %s", async (call, message) => {
    const { run, captures } = setupProgram();
    const result = await run(`await browser.tab("/tabs/1/page.md").${call};`);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(message);
    expect(captures).toEqual([]);
  });

  it("stops at the per-run image cap, across programs, with a clear error", async () => {
    const { run, program, captures } = setupProgram(2);
    expect((await run('await browser.tab("/tabs/1/page.md").screenshot();')).ok).toBe(true);
    program.takeImages();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.screenshot(); await page.screenshot();');
    expect(result).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    expect(result.summary).toContain("Image limit reached: at most 2 images per task");
    expect(captures).toHaveLength(2);
    // The image taken before the failure still goes to the model with the failure.
    expect(program.takeImages()).toHaveLength(1);
  });

  it("takes no images when the scope sets no cap", async () => {
    const fake = fakeTabs();
    const program = new BrowserProgram(new TabController(fake.api), { state: new WorkspaceState(), runId: "r1", sessionId: "s1", files: new ScratchFiles() }, () => {});
    const result = await program.execute('await browser.tab("/tabs/1/page.md").screenshot();', new AbortController().signal);
    expect(result).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
  });

  it("cannot reach another session's agent tab", async () => {
    const { run, state, captures } = setupProgram();
    state.adoptTab(2, "s2");
    const result = await run('await browser.tab("/agent-tabs/2/page.md").screenshot();');
    expect(result).toMatchObject({ ok: false, code: "TARGET_MISSING" });
    expect(captures).toEqual([]);
  });
});

describe("binary /workspace files", () => {
  const BYTES = IMAGE_BASE64.length / 4 * 3;

  it("saves a screenshot, reads back only its metadata, and views it again as an image", async () => {
    const { run, program, files, captures } = setupProgram(2);
    const saved = await run('await browser.tab("/tabs/1/page.md").screenshot({save: "/workspace/shot.jpg"});');
    expect(saved.summary).toContain(`Saved to /workspace/shot.jpg (${BYTES} bytes).`);
    expect(captures[0]!.options.format).toBe("jpeg");
    expect(await files.read("/workspace/shot.jpg")).toEqual({ kind: "binary", mimeType: "image/jpeg", data: IMAGE_BASE64, bytes: BYTES });
    program.takeImages();

    const read = await run('return fs.read("/workspace/shot.jpg");');
    expect(JSON.parse(read.summary)).toEqual({ path: "/workspace/shot.jpg", name: "shot.jpg", mimeType: "image/jpeg", bytes: BYTES, binary: true });
    expect(read.summary).not.toContain(IMAGE_BASE64);
    expect(program.takeImages()).toEqual([]);

    const viewed = await run('await fs.view("/workspace/shot.jpg");');
    expect(viewed.summary).toBe(`[image /workspace/shot.jpg, ${BYTES} bytes] (image 1 of this result)`);
    expect(program.takeImages()).toEqual([{ mimeType: "image/jpeg", data: IMAGE_BASE64, placeholder: `[image /workspace/shot.jpg, ${BYTES} bytes]` }]);
    expect((await run('await fs.view("/workspace/shot.jpg");')).code).toBe("LIMIT_EXCEEDED");
  });

  it("captures PNG for a .png path and refuses other save paths before capturing", async () => {
    const { run, captures } = setupProgram();
    expect((await run('await browser.tab("/tabs/1/page.md").screenshot({save: "/workspace/shot.png"});')).ok).toBe(true);
    expect(captures[0]!.options).not.toHaveProperty("quality");
    expect(captures[0]!.options.format).toBe("png");
    for (const path of ["/workspace/shot.gif", "/workspace/shot.txt", "/tmp/shot.jpg", "/workspace/../shot.jpg"]) {
      const result = await run(`await browser.tab("/tabs/1/page.md").screenshot({save: ${JSON.stringify(path)}});`);
      expect(result.summary).toContain("save must be a /workspace path ending in .jpg, .jpeg, or .png");
    }
    expect(captures).toHaveLength(1);
  });

  it("uploads a saved binary file's bytes to a file input", async () => {
    const { run, executed, files } = setupProgram();
    await files.write("/workspace/shot.jpg", { kind: "binary", mimeType: "image/jpeg", data: IMAGE_BASE64, bytes: BYTES });
    await files.write("/workspace/note.txt", { kind: "text", content: "hi" });
    const result = await run('await browser.tab("/tabs/1/page.md").getByRole("file").setInputFiles(["/workspace/shot.jpg", "/workspace/note.txt"]);');
    expect(result.ok, result.summary).toBe(true);
    expect(executed).toEqual([{ kind: "upload", target: { kind: "role", role: "file", name: null, exact: false }, files: [
      { name: "shot.jpg", mimeType: "image/jpeg", base64: IMAGE_BASE64 },
      { name: "note.txt", mimeType: "text/plain", text: "hi" },
    ] }]);
  });

  it("keeps binaries within the per-file and per-session caps and their types", async () => {
    const { run, files } = setupProgram();
    const big = "A".repeat(WORKSPACE_MAX_BINARY_BYTES / 3 * 4);
    await expect(files.write("/workspace/huge.jpg", { kind: "binary", mimeType: "image/jpeg", data: `${big}AAAA`, bytes: WORKSPACE_MAX_BINARY_BYTES + 3 })).rejects.toThrow("Workspace limits");
    const fits = WORKSPACE_MAX_BINARY_TOTAL_BYTES / WORKSPACE_MAX_BINARY_BYTES;
    for (let n = 0; n < fits; n++) await files.write(`/workspace/p${n}.jpg`, { kind: "binary", mimeType: "image/jpeg", data: big, bytes: WORKSPACE_MAX_BINARY_BYTES });
    await expect(files.write("/workspace/over.jpg", { kind: "binary", mimeType: "image/jpeg", data: "AAAA", bytes: 3 })).rejects.toThrow("Workspace limits");
    // Replacing a file counts its new size, not both.
    await files.write("/workspace/p0.jpg", { kind: "binary", mimeType: "image/jpeg", data: "AAAA", bytes: 3 });
    await expect(files.write("/workspace/p0.png", { kind: "binary", mimeType: "image/jpeg", data: "AAAA", bytes: 3 })).rejects.toThrow("matching extension");

    expect((await run('await fs.write("/workspace/fake.png", "text");')).summary).toContain("names a binary file type");
    expect((await run('await fs.move("/workspace/p0.jpg", "/workspace/p0.txt");')).summary).toContain("keeps the file's type");
    expect((await run('await fs.move("/workspace/p0.jpg", "/workspace/renamed.jpeg");')).ok).toBe(true);
    expect((await run('await fs.view("/workspace/missing.png");')).summary).toContain("File does not exist");
    await files.write("/workspace/doc.md", { kind: "text", content: "# Notes" });
    expect((await run('await fs.view("/workspace/doc.md");')).summary).toContain("fs.view() shows images");
  });
});

describe("screenshots and agent memory", () => {
  beforeEach(() => { fakeBrowser.reset(); });
  const taint = async (name: string) => (await listMemories()).find((entry) => entry.name === name)?.provenance;

  it("taints a run that took a screenshot or viewed a saved image, before memory changes record it", async () => {
    const files = new ScratchFiles();
    const shooter = setupProgram(3, { files, memory: true });
    expect((await shooter.run('await browser.tab("/tabs/1/page.md").screenshot({save: "/workspace/shot.jpg"}); fs.write("/memory/chart.md", "Chart");')).ok).toBe(true);
    expect(await taint("chart")).toMatchObject({ tainted: true });

    // A later run in the chat reads no page, only the saved screenshot.
    const viewer = setupProgram(3, { files, memory: true });
    await viewer.run('fs.write("/memory/before.md", "Before");');
    expect(await taint("before")).toMatchObject({ tainted: false });
    expect((await viewer.run('await fs.view("/workspace/shot.jpg"); fs.write("/memory/after.md", "After");')).ok).toBe(true);
    expect(await taint("after")).toMatchObject({ tainted: true });
    expect(viewer.captures).toEqual([]);
  });

  it("keeps binaries out of /memory, which holds text only", async () => {
    const { run, files, captures } = setupProgram(3, { memory: true });
    await files.write("/workspace/shot.jpg", { kind: "binary", mimeType: "image/jpeg", data: IMAGE_BASE64, bytes: IMAGE_BASE64.length / 4 * 3 });
    const refused = [
      ['await browser.tab("/tabs/1/page.md").screenshot({save: "/memory/shot.png"});', "save must be a /workspace path"],
      ['await fs.move("/workspace/shot.jpg", "/memory/shot.md");', "Destination must be a new workspace path"],
      ['await fs.write("/memory/shot.md", fs.read("/workspace/shot.jpg"));', "Invalid arguments for fs.write"],
      ['await fs.write("/memory/shot.md", JSON.stringify(fs.read("/workspace/shot.jpg")));', null],
      ['await fs.view("/memory/shot.md");', "Memory supports fs.list, fs.read, fs.write, and fs.remove"],
    ] as const;
    for (const [source, message] of refused) {
      const result = await run(source);
      if (message) {
        expect(result.ok, source).toBe(false);
        expect(result.summary).toContain(message);
      }
    }
    expect(captures).toEqual([]);
    // Only the metadata JSON could be written, as text: never the image bytes.
    const saved = await listMemories();
    expect(saved.map((entry) => entry.name)).toEqual(["shot"]);
    expect(JSON.stringify(saved)).not.toContain(IMAGE_BASE64);
    expect(saved[0]!.description).toContain('"mimeType":"image/jpeg"');
  });

  it("shows the taint on the Ask card for a change after a screenshot", async () => {
    await saveMemorySettings({ version: 1, writes: "ask" });
    const { program } = setupProgram(3, { memory: true });
    const asked: MemoryApproval[] = [];
    const result = await program.execute('await browser.tab("/tabs/1/page.md").screenshot(); fs.write("/memory/chart.md", "Chart\\nBars");', new AbortController().signal,
      { confirmMemory: async (change) => { asked.push(change); return true; } });
    expect(result.ok, result.summary).toBe(true);
    expect(asked).toEqual([{ op: "write", name: "chart", description: "Chart", body: "Bars", replaces: false, tainted: true }]);
    expect(program.takeImages()).toHaveLength(1);
  });
});

class ScriptedProvider implements ProviderAdapter {
  readonly definition = { id: "openai" as const, name: "OpenAI", authMethods: [], models: [] };
  requests: ProviderTurnRequest[] = [];
  #index = 0;
  constructor(private rounds: ScriptedProviderEvent[][], private model = TEST_MODEL) {}
  async validateAuth(): Promise<void> {}
  getModel() { return this.model; }
  streamTurn(request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal) {
    this.requests.push(splitSystemMessage(request));
    const round = this.rounds[this.#index++] ?? [{ type: "turn.completed", replayState: null }];
    return toPiStream(round, signal);
  }
}

const program = (id: string, source: string): ScriptedProviderEvent[] => [
  { type: "tool.call", call: { id, name: "browser_program", arguments: { source } } },
  { type: "turn.completed", replayState: null },
];

async function runLoop(provider: ScriptedProvider, options: { memory?: boolean } = {}) {
  const fake = fakeTabs();
  const items: ConversationItem[] = [];
  const contexts: string[] = [];
  const outputs: string[] = [];
  const scope = options.memory ? { state: new WorkspaceState(), runId: "r1", sessionId: "s1", files: new ScratchFiles(), memory: runMemory("s1", "run1") } : undefined;
  const loop = new AgentLoop(provider, new TabController(fake.api, async () => false), new SidebarHub(), scope);
  const result = await loop.run({
    runId: "run1", conversationId: "s1", modelId: TEST_MODEL.id, reasoningEffort: "medium",
    transcript: [{ id: "u1", kind: "message", role: "user", text: "What does the chart show?", context: null, at: 1 }],
    contextArtifact: null, auth: { providerId: "openai", method: "api-key", secret: "sk-test" }, signal: new AbortController().signal,
    onDelta: () => {}, onItem: async (item) => { items.push(item); }, onApprovalPending: () => {},
    onContext: (context) => contexts.push(context),
    onToolOutput: (call, toolResult) => outputs.push(JSON.stringify({ call, toolResult })),
  });
  return { result, items, contexts, outputs, digest: loop.digestSteps(), fake };
}

const imageParts = (request: ProviderTurnRequest) =>
  request.context.messages.flatMap((message) => message.role === "toolResult" ? message.content.filter((part) => part.type === "image") : []);

describe("AgentLoop: screenshot results", () => {
  it("shows an image in the round after its call only, and persists, exports, and digests only its placeholder", async () => {
    const provider = new ScriptedProvider([
      program("call_1", 'await browser.tab("/tabs/1/page.md").screenshot();'),
      program("call_2", "return 1;"),
      [{ type: "text.delta", delta: "A bar chart." }, { type: "turn.completed", replayState: null }],
    ]);
    const { result, items, contexts, outputs, digest } = await runLoop(provider);
    expect(result.status).toBe("completed");

    expect(imageParts(provider.requests[1]!)).toEqual([{ type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 }]);
    expect(imageParts(provider.requests[2]!)).toEqual([]);
    expect(JSON.stringify(provider.requests[2]!.context.messages)).toContain("[screenshot 1280x800 of https://example.com/]");

    for (const persisted of [JSON.stringify(items), JSON.stringify(digest), ...outputs, ...contexts]) {
      expect(persisted).not.toContain(IMAGE_BASE64);
      expect(persisted).not.toContain("data:image");
    }
    expect(JSON.stringify(digest)).toContain("[screenshot 1280x800 of https://example.com/]");
    expect(contexts[1]).toContain('"type": "image"');
    expect(contexts[1]).toContain("[image omitted:");
  });

  it("carries a program's image to the next round and its tainted memory change on the persisted result", async () => {
    fakeBrowser.reset();
    const provider = new ScriptedProvider([
      program("call_1", 'await browser.tab("/tabs/1/page.md").screenshot({save: "/workspace/chart.jpg"}); fs.write("/memory/chart-style.md", "Chart style\\nBars, blue.");'),
      [{ type: "text.delta", delta: "Saved." }, { type: "turn.completed", replayState: null }],
    ]);
    const { result, items, outputs, digest } = await runLoop(provider, { memory: true });
    expect(result.status).toBe("completed");
    expect(imageParts(provider.requests[1]!)).toEqual([{ type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 }]);

    const change = { id: expect.any(String), op: "write", name: "chart-style", tainted: true };
    expect(items.find((item) => item.kind === "tool-result")).toMatchObject({ result: { ok: true, summary: "Browser program completed." }, memory: [change] });
    expect(buildRunDigest(digest, "completed")!.entries).toContainEqual({ type: "memory", op: "write", name: "chart-style", tainted: true });
    for (const persisted of [JSON.stringify(items), JSON.stringify(digest), JSON.stringify(await listMemories()), ...outputs]) {
      expect(persisted).not.toContain(IMAGE_BASE64);
      expect(persisted).not.toContain("data:image");
    }
  });

  it("allows MAX_RUN_IMAGES per run", async () => {
    const shots = Array.from({ length: MAX_RUN_IMAGES + 1 }, () => "await page.screenshot();").join(" ");
    const provider = new ScriptedProvider([program("call_1", `const page = browser.tab("/tabs/1/page.md"); ${shots}`)]);
    const { fake } = await runLoop(provider);
    expect(fake.captures).toHaveLength(MAX_RUN_IMAGES);
    expect(imageParts(provider.requests[1]!)).toHaveLength(MAX_RUN_IMAGES);
  });

  it("tells a model without image input that its screenshots were not shown", async () => {
    const provider = new ScriptedProvider([program("call_1", 'await browser.tab("/tabs/1/page.md").screenshot();')], { ...TEST_MODEL, input: ["text"] });
    await runLoop(provider);
    expect(imageParts(provider.requests[1]!)).toEqual([]);
    expect(JSON.stringify(provider.requests[1]!.context.messages)).toContain("This model does not accept images");
  });
});
