// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Markdown } from "@/lib/ui/Markdown";
import { parsePromptMentions, serializeDraft } from "@/lib/ui/Composer";
import { useBottomScroll } from "@/lib/ui/use-bottom-scroll";
import { useBackground } from "@/lib/ui/use-background";
import { isSidebarCommand } from "@/lib/protocol";
import { buildTurns, formatDuration } from "@/lib/ui/turns";
import { TurnTrace } from "@/lib/ui/TurnTrace";
import type { ConversationItem } from "@/lib/domain/conversation";
import type { RuntimeSnapshot, SidebarEvent } from "@/lib/protocol";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";

function snapshotFor(id: string): RuntimeSnapshot {
  return {
    conversation: { id, title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: 0, lastModelId: null, items: [] },
    credential: { configured: true, maskedSuffix: null, chatgpt: { connected: false, email: null, signInAgain: false } },
    provider: OPENAI_PROVIDER,
    settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
    page: null, agentTabs: 0, activeRun: null, lastSeq: 0, notice: null,
  };
}

const turnItems: ConversationItem[] = [
  { id: "u1", kind: "message", role: "user", text: "Fill the form", context: null, at: 0 },
  { id: "c1", kind: "tool-call", call: { id: "call-1", name: "browser_program", arguments: { source: "await page.fill(x, 'y')" } }, at: 1_000 },
  { id: "r1", kind: "tool-result", callId: "call-1", result: { ok: false, code: "TARGET_MISSING", summary: "No field <b>x</b>" }, at: 3_000 },
  { id: "a1", kind: "message", role: "assistant", text: "Retrying with another field.", at: 4_000 },
  { id: "c2", kind: "tool-call", call: { id: "call-2", name: "request_action_confirmation", arguments: { title: "Submit form", message: "Send it?", artifact: "" } }, at: 5_000 },
  { id: "r2", kind: "tool-result", callId: "call-2", result: { ok: false, code: "ACTION_DENIED", summary: "approved:false" }, at: 6_000 },
  { id: "a2", kind: "message", role: "assistant", text: "Okay, not submitted.", at: 64_000 },
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sidebar UI contracts", () => {
  it("renders Markdown without executable HTML, unsafe links, or remote image requests", () => {
    const root = document.createElement("div");
    document.body.append(root);
    render(
      h(Markdown, {
        text: "**Bold**\n\n1. First\n\n[Good](https://example.com) [Bad](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>\n\n![tracking](https://example.com/pixel.png)",
      }),
      root,
    );
    expect(root.querySelector("strong")?.textContent).toBe("Bold");
    expect(root.querySelector("ol li")?.textContent).toBe("First");
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("a")?.rel).toBe("noopener noreferrer");
    expect(root.querySelectorAll("img,script")).toHaveLength(0);
    render(null, root);
  });

  it("serializes mentions with actual tab identity and VFS path", () => {
    expect(
      serializeDraft([
        {
          type: "paragraph",
          children: [
            { text: "Read " },
            {
              type: "mention",
              tab: {
                id: 42,
                title: "Example",
                url: "https://example.com/",
                path: "/agent-tabs/42/page.md",
              },
              children: [{ text: "" }],
            },
          ],
        },
      ]),
    ).toBe(
      "Read @Example (tab 42, /agent-tabs/42/page.md, https://example.com/)",
    );
  });

  it("parses serialized mentions back into display segments", () => {
    expect(
      parsePromptMentions(
        "@Quiz: Exam 1 (draft) (tab 57, /tabs/57/page.md, https://canvas.example/q?x=1) and @Doc (tab 9, /agent-tabs/9/page.md, https://example.com/)\nthanks",
      ),
    ).toEqual([
      { kind: "mention", label: "Quiz: Exam 1 (draft)", tabId: 57, agentTab: false, url: "https://canvas.example/q?x=1" },
      { kind: "text", text: " and " },
      { kind: "mention", label: "Doc", tabId: 9, agentTab: true, url: "https://example.com/" },
      { kind: "text", text: "\nthanks" },
    ]);
    expect(parsePromptMentions("email me @ 5 (tab 1, /tabs/2/page.md, x)")).toEqual([
      { kind: "text", text: "email me @ 5 (tab 1, /tabs/2/page.md, x)" },
    ]);
    expect(isSidebarCommand({ v: 1, id: "f", type: "tabs.focus", tabId: 57 })).toBe(true);
    expect(isSidebarCommand({ v: 1, id: "f", type: "tabs.focus", tabId: "57" })).toBe(false);
  });

  it("groups items into turns with interim work and a final answer", () => {
    const [turn] = buildTurns(turnItems, false);
    expect(turn!.prompt?.text).toBe("Fill the form");
    expect(turn!.steps.map((step) => step.kind)).toEqual(["activity", "text", "activity"]);
    expect(turn!.steps[0]).toMatchObject({ startedAt: 1_000, endedAt: 3_000, result: { ok: false } });
    expect(turn!.answer).toEqual({ id: "a2", text: "Okay, not submitted." });
    expect(formatDuration(turn!.endedAt - turn!.startedAt)).toBe("1m 4s");
    // While running, trailing text may still be followed by more tool calls.
    expect(buildTurns(turnItems, true)[0]!.answer).toBeNull();
  });

  it("renders a completed turn collapsed with status in words and untrusted text as text", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const [turn] = buildTurns(turnItems, false);
    render(h(TurnTrace, { turn: turn!, active: false, pendingApproval: null, onApprove: () => {}, onDeny: () => {} }), root);
    const header = root.querySelector("details")!;
    expect(header.open).toBe(false);
    expect(header.querySelector("summary")?.textContent).toContain("Worked for 1m 4s, 1 failed");
    const titles = [...root.querySelectorAll(".trace__content .trace__title")].map((node) => node.textContent);
    expect(titles).toEqual(["Couldn't fill page fields", "Denied: Submit form"]);
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("No field <b>x</b>");
    render(null, root);
  });

  it("keeps an active turn open with the pending approval reachable", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const items = turnItems.slice(0, 5);
    const [turn] = buildTurns(items, true);
    const approve = vi.fn();
    const call = items[4]!.kind === "tool-call" ? items[4]!.call : null;
    render(h(TurnTrace, {
      turn: turn!, active: true, pendingApproval: { call: call!, origin: "", display: "Submit form", target: {} },
      onApprove: approve, onDeny: () => {},
    }), root);
    expect(root.querySelector("summary")?.textContent).toContain("Waiting for your approval");
    expect([...root.querySelectorAll("details")].every((details) => details.open || !details.querySelector(".trace__actions"))).toBe(true);
    expect(root.textContent).toContain("Waiting for approval: Submit form");
    (root.querySelector(".trace__approve") as HTMLButtonElement).click();
    expect(approve).toHaveBeenCalledWith("call-2");
    render(null, root);
  });

  it("validates inline model settings and keeps credential commands off the sidebar", () => {
    const command = {
      v: 1,
      id: "s",
      type: "settings.save",
      settings: {
        version: 1,
        providerId: "openai",
        modelId: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
    };
    expect(isSidebarCommand(command)).toBe(true);
    expect(
      isSidebarCommand({
        ...command,
        settings: { ...command.settings, reasoningEffort: "bogus" },
      }),
    ).toBe(false);
    expect(
      isSidebarCommand({
        ...command,
        settings: { ...command.settings, apiKey: "secret" },
      }),
    ).toBe(false);
    expect(
      isSidebarCommand({ v: 1, id: "c", type: "credentials.openai.status" }),
    ).toBe(false);
  });

  it("retries a failed turn in place without duplicating its user message", async () => {
    const posted: unknown[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: (message: unknown) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    let background: ReturnType<typeof useBackground>;
    function Harness() {
      background = useBackground();
      return null;
    }
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(Harness, {}), root));
    const emit = (event: Omit<SidebarEvent, "v" | "conversationId" | "seq" | "at">, conversationId: string | null = "s1") =>
      act(() => listeners.forEach((listener) => listener({ v: 1, conversationId, seq: 1, at: 1, ...event })));
    await emit({ runId: null, type: "state.snapshot", payload: snapshotFor("s1") });

    await emit({ runId: "r1", type: "run.started", payload: { prompt: "Find it", page: null, retry: false } });
    await emit({ runId: "r1", type: "run.failed", payload: { code: "RATE_LIMIT", message: "Rate limited.", retryable: true, phase: "provider" } });
    expect(background!.lastError?.retryable).toBe(true);

    await act(() => background!.retryRun());
    expect(posted.at(-1)).toMatchObject({ v: 1, type: "run.retry" });
    expect(isSidebarCommand(posted.at(-1))).toBe(true);

    await emit({ runId: "r2", type: "run.started", payload: { prompt: "Find it", page: null, retry: true } });
    expect(background!.conversation.items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(1);
    expect(background!.activeRun?.runId).toBe("r2");
    expect(background!.lastError).toBeNull();
    await act(() => render(null, root));
  });

  it("tracks a run in another session without adding its items to the open one", async () => {
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: () => {},
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    let background: ReturnType<typeof useBackground>;
    function Harness() {
      background = useBackground();
      return null;
    }
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(Harness, {}), root));
    const emit = (event: Omit<SidebarEvent, "v" | "seq" | "at">) =>
      act(() => listeners.forEach((listener) => listener({ v: 1, seq: 1, at: 1, ...event })));
    await emit({ runId: null, conversationId: "open", type: "state.snapshot", payload: snapshotFor("open") });

    await emit({ runId: "r1", conversationId: "other", type: "run.started", payload: { prompt: "Elsewhere", page: null, retry: false } });
    await emit({ runId: "r1", conversationId: "other", type: "assistant.delta", payload: { delta: "Working" } });
    await emit({ runId: "r1", conversationId: "other", type: "tool.requested", payload: { call: { id: "c1", name: "browser_program", arguments: {} }, display: "" } });
    expect(background!.activeRun).toMatchObject({ runId: "r1", conversationId: "other" });
    expect(background!.conversation.items).toEqual([]);
    await emit({ runId: "r1", conversationId: "other", type: "run.failed", payload: { code: "RATE_LIMIT", message: "Rate limited.", retryable: true, phase: "provider" } });
    expect(background!.activeRun).toBeNull();
    expect(background!.lastError).toBeNull();
    await act(() => render(null, root));
  });

  it("follows content growth only while pinned, and resumes after jumping to latest", async () => {
    let resize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let follow: ReturnType<typeof useBottomScroll>;
    function Harness() {
      follow = useBottomScroll();
      return h(
        "main",
        { ref: follow.viewport },
        h("div", { ref: follow.content }, "content"),
      );
    }
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(Harness, {}), root));
    const viewport = root.querySelector("main")!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200 },
    });
    await act(() => resize());
    expect(viewport.scrollTop).toBe(1000);
    await act(() => {
      viewport.scrollTop = 100;
      viewport.dispatchEvent(new Event("scroll"));
    });
    Object.defineProperty(viewport, "scrollHeight", { value: 1500 });
    await act(() => resize());
    expect(viewport.scrollTop).toBe(100);
    expect(follow!.atBottom).toBe(false);
    await act(() => follow!.scrollToBottom());
    expect(viewport.scrollTop).toBe(1500);
    expect(follow!.atBottom).toBe(true);
    await act(() => render(null, root));
  });
});
