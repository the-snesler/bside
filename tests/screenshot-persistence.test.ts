import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController, type CaptureOptions, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { ProviderAdapter, ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";
import type { CaptureGeometry, PageSnapshot } from "@/lib/domain/tools";
import { getConversation, getOpenSessionId, getRunCheckpoint, saveOpenAICredential } from "@/lib/storage";
import { splitSystemMessage, TEST_MODEL, toPiStream, type ScriptedProviderEvent } from "@/tests/helpers/pi-provider";

/** The fake image's base64; nothing persisted or exported may contain it. */
const IMAGE_BASE64 = "U0NSRUVOU0hPVEJZVEVT".repeat(50);

function screenshotTabControllerFactory(): TabController {
  const text = '[e1 img "Revenue chart"]';
  const snapshot: PageSnapshot = {
    version: 2, tabId: 1, documentId: "doc-1", url: "https://example.com/report", title: "Report", text,
    offset: 0, end: text.length, totalChars: text.length, selectionText: "",
  };
  const geometry: CaptureGeometry = {
    documentId: "doc-1", url: snapshot.url, title: snapshot.title, viewport: { x: 0, y: 0, width: 1024, height: 768 },
    page: { width: 1024, height: 768 }, element: null,
  };
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: snapshot.url, title: snapshot.title }]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      captureTab: vi.fn(async (_tabId: number, _options: CaptureOptions) => `data:image/jpeg;base64,${IMAGE_BASE64}`),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        const request = message as { id: string; type: string };
        if (request.type === "page.snapshot") return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot };
        if (request.type === "page.capture-prepare") return { v: 1, id: request.id, ok: true, type: "page.capture-prepare", geometry };
        if (request.type === "page.capture-done") return { v: 1, id: request.id, ok: true, type: "page.capture-done" };
        throw new Error(`unhandled request type: ${request.type}`);
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return new TabController(api, async () => false);
}

class ScreenshotProvider implements ProviderAdapter {
  readonly definition = { id: "openai" as const, name: "OpenAI", authMethods: [], models: [] };
  requests: ProviderTurnRequest[] = [];
  async validateAuth(): Promise<void> {}
  getModel() { return TEST_MODEL; }
  streamTurn(request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal) {
    this.requests.push(splitSystemMessage(request));
    const first = this.requests.length === 1;
    const events: ScriptedProviderEvent[] = first
      ? [{ type: "tool.call", call: { id: "shot", name: "browser_program", arguments: { source: 'await browser.tab("/tabs/1/page.md").screenshot();' } } }, { type: "turn.completed", replayState: null }]
      : [{ type: "text.delta", delta: "Revenue doubled." }, { type: "turn.completed", replayState: null }];
    return toPiStream(events, signal);
  }
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe("screenshots are never persisted", () => {
  it("keeps image bytes out of storage, the checkpoint, the digest, and the export, which show only the placeholder", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new ScreenshotProvider();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: screenshotTabControllerFactory });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "What does the chart show?" });
    const sessionId = (await getOpenSessionId())!;
    await vi.waitFor(async () => expect((await getConversation(sessionId))?.items.some((item) => item.kind === "run-digest")).toBe(true));

    // The model saw the image once.
    const image = provider.requests[1]!.context.messages.flatMap((message) => message.role === "toolResult" ? message.content : []).find((part) => part.type === "image");
    expect(image).toEqual({ type: "image", mimeType: "image/jpeg", data: IMAGE_BASE64 });

    const stored = JSON.stringify(await browser.storage.local.get(null));
    expect(stored).not.toContain(IMAGE_BASE64);
    expect(stored).not.toContain("data:image");
    expect(JSON.stringify(await getRunCheckpoint())).not.toContain(IMAGE_BASE64);
    expect(stored).toContain("[screenshot 1024x768 of https://example.com/report]");

    const exported = (await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId }))?.markdown ?? "";
    expect(exported).toContain("[screenshot 1024x768 of https://example.com/report]");
    expect(exported).toContain("[image omitted:");
    expect(exported).not.toContain(IMAGE_BASE64);
    expect(exported).not.toContain("data:image");
  });
});
