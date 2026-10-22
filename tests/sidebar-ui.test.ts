// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Markdown } from "@/lib/ui/Markdown";
import { composerKeyAction, parsePromptMentions, serializeDraft } from "@/lib/ui/Composer";
import { useBottomScroll } from "@/lib/ui/use-bottom-scroll";
import { useBackground } from "@/lib/ui/use-background";
import { isSidebarCommand } from "@/lib/protocol";
import { buildTurns, formatDuration } from "@/lib/ui/turns";
import { TurnTrace } from "@/lib/ui/TurnTrace";
import { formatRelativeTime, HistoryDrawer } from "@/lib/ui/HistoryDrawer";
import type { HistoryDrawerProps } from "@/lib/ui/HistoryDrawer";
import { App } from "@/entrypoints/sidepanel/App";
import type { ConversationItem, ConversationSummary } from "@/lib/domain/conversation";
import type { AgentTabSummary, RuntimeSnapshot, SidebarEvent } from "@/lib/protocol";
import { OPENAI_API_KEY_PROVIDER } from "@/lib/providers/openai";
import { EMPTY_USAGE, type RunUsageV1 } from "@/lib/domain/usage";
import { describeSessionUsage, describeTurnUsage, formatTokens, formatUsd } from "@/lib/ui/usage";

// Slate resolves real React under Vitest, so App-level tests render without the editor and read the props it would get.
const composer = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("@/lib/ui/Composer", async (original) => ({
  ...await original<typeof import("@/lib/ui/Composer")>(),
  Composer: (props: Record<string, unknown>) => {
    composer.props = props;
    return null;
  },
}));

function snapshotFor(id: string): RuntimeSnapshot {
  return {
    conversation: { id, title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: 0, lastModelId: null, usage: EMPTY_USAGE, items: [] },
    credential: { configured: true, maskedSuffix: null, chatgpt: { connected: false, email: null, signInAgain: false } },
    provider: OPENAI_API_KEY_PROVIDER,
    settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
    page: null, agentTabs: { bySession: {}, watching: null }, queue: [], activeRun: null, lastSeq: 0, notice: null,
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

  it("hides run digests and marks the turn where the latest compaction's summary ends", () => {
    const digest = { version: 1 as const, status: "completed" as const, error: null, entries: [], omittedEntries: 0 };
    const items: ConversationItem[] = [
      ...turnItems,
      { id: "d1", kind: "run-digest", digest, at: 64_001 },
      { id: "u2", kind: "message", role: "user", text: "And then?", context: null, at: 70_000 },
      { id: "a3", kind: "message", role: "assistant", text: "Done.", at: 71_000 },
      { id: "u3", kind: "message", role: "user", text: "Last one", context: null, at: 80_000 },
      { id: "k1", kind: "compaction", summary: "Old summary", firstKeptItemId: "u2", tokensBefore: 1, at: 80_001 },
      { id: "k2", kind: "compaction", summary: "Newer summary", firstKeptItemId: "u3", tokensBefore: 1, at: 80_002 },
      { id: "a4", kind: "message", role: "assistant", text: "Final.", at: 81_000 },
    ];
    const turns = buildTurns(items, false);
    expect(turns.map((turn) => turn.prompt?.text)).toEqual(["Fill the form", "And then?", "Last one"]);
    expect(turns[0]!.answer).toEqual({ id: "a2", text: "Okay, not submitted." });
    expect(turns.map((turn) => turn.summary)).toEqual([null, null, "Newer summary"]);
    expect(turns[2]!.answer?.text).toBe("Final.");
  });

  it("sums the usage of every run that worked on a turn, across retries and steers, into that turn only", () => {
    const usage = (runId: string, patch: Partial<RunUsageV1> = {}): ConversationItem => ({ id: `usage-${runId}`, kind: "run-usage", at: 0, usage: {
      version: 1, runId, billing: "api-key", modelId: "gpt-5.6-terra", responses: 1, input: 1000, cacheRead: 500, cacheWrite: 0, output: 100, reasoning: 10, costUsd: 0.01, ...patch,
    } });
    const items: ConversationItem[] = [
      { id: "u1", kind: "message", role: "user", text: "Find it", context: null, at: 0 },
      usage("failed"),
      { id: "s1", kind: "message", role: "user", text: "Only red", context: null, delivery: "steer", at: 1 },
      { id: "a1", kind: "message", role: "assistant", text: "Found.", at: 2 },
      usage("retry", { input: 2000, cacheRead: 0, output: 200, costUsd: 0.02 }),
      { id: "u2", kind: "message", role: "user", text: "Follow-up", context: null, at: 3 },
      { id: "a2", kind: "message", role: "assistant", text: "Sure.", at: 4 },
      usage("plan", { billing: "chatgpt", costUsd: null }),
      { id: "u3", kind: "message", role: "user", text: "No usage recorded", context: null, at: 5 },
    ];
    const turns = buildTurns(items, false);
    expect(turns).toHaveLength(3);
    expect(turns[0]!.answer?.text).toBe("Found.");
    expect(turns[0]!.usage).toEqual({
      responses: 2, input: 3500, cacheRead: 500, output: 300, reasoning: 20, costUsd: expect.closeTo(0.03, 10), pricedRuns: 2, planRuns: 0, unpricedRuns: 0,
    });
    expect(turns[1]!.usage).toMatchObject({ input: 1500, planRuns: 1, pricedRuns: 0, costUsd: 0 });
    expect(turns[2]!.usage).toBeNull();
  });

  it("formats usage compactly: tokens, cached input, estimated dollars on the API-key path, plan usage on ChatGPT", () => {
    expect([950, 1_234, 12_345, 99_960, 123_456, 999_600, 1_234_567].map(formatTokens)).toEqual(["950", "1.2k", "12.3k", "100k", "123k", "1M", "1.2M"]);
    expect([0, 0.00001, 0.0004, 0.012, 0.0999, 0.43, 12.345].map(formatUsd)).toEqual(["$0.00", "<$0.0001", "$0.0004", "$0.012", "$0.10", "$0.43", "$12.35"]);
    const totals = { ...EMPTY_USAGE, responses: 3, input: 12_300, cacheRead: 8_100, output: 1_200, reasoning: 400 };
    const priced = describeTurnUsage({ ...totals, costUsd: 0.0123, pricedRuns: 1 });
    expect(priced.text).toBe("12.3k in (8.1k cached) · 1.2k out · ~$0.012");
    expect(priced.title).toBe("Input: 12,300 tokens (8,100 cached)\nOutput: 1,200 tokens (400 reasoning)\n3 responses\nEstimated cost: $0.012 at bundled list prices");
    const plan = describeTurnUsage({ ...totals, cacheRead: 0, planRuns: 1 });
    expect(plan.text).toBe("12.3k in · 1.2k out · plan usage");
    expect(plan.title).not.toContain("$");
    const unpriced = describeTurnUsage({ ...totals, unpricedRuns: 1 });
    expect(unpriced.text).toBe("12.3k in (8.1k cached) · 1.2k out");
    expect(unpriced.title).toContain("No price is bundled");
    expect(describeSessionUsage(EMPTY_USAGE)).toBeNull();
    expect(describeSessionUsage({ ...totals, costUsd: 0.43, pricedRuns: 2, planRuns: 1 })?.text).toBe("~$0.43");
    expect(describeSessionUsage({ ...totals, input: 1_200_000, planRuns: 4 })?.text).toBe("1.2M tokens");
  });

  it("shows a turn's usage below its answer once the run ends, built live from run.usage events", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: () => {},
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    const emit = (event: Omit<SidebarEvent, "v" | "conversationId" | "seq" | "at">) =>
      act(() => listeners.forEach((listener) => listener({ v: 1, conversationId: "a", seq: 1, at: 5, ...event })));
    await emit({ runId: null, type: "state.snapshot", payload: snapshotFor("a") });
    const usage: RunUsageV1 = {
      version: 1, runId: "r1", billing: "api-key", modelId: "gpt-5.6-terra", responses: 1, input: 4_000, cacheRead: 8_100, cacheWrite: 200, output: 1_200, reasoning: 0, costUsd: 0.0123,
    };
    await emit({ runId: "r1", type: "run.started", payload: { prompt: "Hello", page: null, retry: false } });
    await emit({ runId: "r1", type: "assistant.delta", payload: { delta: "Hi." } });
    await emit({ runId: "r1", type: "run.usage", payload: { usage } });
    expect(root.querySelector(".turn-usage")).toBeNull();
    await emit({ runId: "r1", type: "run.completed", payload: { messageId: "m1" } });
    const line = root.querySelector<HTMLElement>(".turn-usage")!;
    expect(line.textContent).toBe("12.3k in (8.1k cached) · 1.2k out · ~$0.012");
    expect(line.title).toContain("Estimated cost: $0.012");
    const text = root.querySelector(".timeline")!.textContent!;
    expect(text.indexOf("Hi.")).toBeLessThan(text.indexOf("12.3k in"));
    render(null, root);
  });

  it("shows an \"Earlier conversation summarized\" marker while keeping earlier turns visible", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: () => {},
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    const snapshot = snapshotFor("a");
    snapshot.conversation.items = [
      { id: "u1", kind: "message", role: "user", text: "First question", context: null, at: 1 },
      { id: "a1", kind: "message", role: "assistant", text: "First answer", at: 2 },
      { id: "u2", kind: "message", role: "user", text: "Second question", context: null, at: 3 },
      { id: "k1", kind: "compaction", summary: "**Goal** <img src=x onerror=alert(1)>", firstKeptItemId: "u2", tokensBefore: 1, at: 4 },
      { id: "a2", kind: "message", role: "assistant", text: "Second answer", at: 5 },
    ];
    await act(() => listeners.forEach((listener) => listener({ v: 1, seq: 0, at: 1, runId: null, conversationId: "a", type: "state.snapshot", payload: snapshot })));
    const marker = root.querySelector(".summary-marker summary");
    expect(marker?.textContent).toBe("Earlier conversation summarized");
    const text = root.querySelector(".timeline")!.textContent!;
    expect(text.indexOf("First answer")).toBeLessThan(text.indexOf("Earlier conversation summarized"));
    expect(text.indexOf("Earlier conversation summarized")).toBeLessThan(text.indexOf("Second question"));
    expect(root.querySelector(".summary-marker strong")?.textContent).toBe("Goal");
    expect(root.querySelector(".summary-marker img")).toBeNull();
    render(null, root);
  });

  it("renders a completed turn collapsed with status in words and untrusted text as text", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const [turn] = buildTurns(turnItems, false);
    render(h(TurnTrace, { turn: turn!, active: false, pendingApproval: null, onApprove: () => {}, onDeny: () => {} }), root);
    const header = root.querySelector("details")!;
    expect(header.open).toBe(false);
    // A failed step the run moved past is counted quietly; the run itself completed.
    expect(header.querySelector("summary .trace__title")?.textContent).toBe("Worked for 1m 4s");
    expect(header.querySelector("summary .trace__description")?.textContent).toBe("2 steps · 1 failed");
    expect(header.querySelector("summary .trace__failed")?.textContent).toBe(" · 1 failed");
    expect(header.querySelector(".mascot")?.getAttribute("data-mood")).toBe("idle");
    expect(header.querySelector(".mascot")?.getAttribute("aria-hidden")).toBe("true");
    const titles = [...root.querySelectorAll(".trace__content .trace__title")].map((node) => node.textContent);
    expect(titles).toEqual(["Couldn't fill page fields", "Denied: Submit form"]);
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("No field <b>x</b>");
    render(null, root);
  });

  it("leads each turn with bside's face: working while active, drooping and saying so when the run did not complete", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const digest = (status: "completed" | "failed" | "cancelled" | "interrupted"): ConversationItem =>
      ({ id: `d-${status}`, kind: "run-digest", digest: { version: 1, status, error: null, entries: [], omittedEntries: 0 }, at: 64_500 });
    const header = (items: ConversationItem[], active = false) => {
      const [turn] = buildTurns(items, active);
      render(h(TurnTrace, { turn: turn!, active, pendingApproval: null, onApprove: () => {}, onDeny: () => {} }), root);
      return { title: root.querySelector("summary .trace__title")?.textContent, mood: root.querySelector("summary .mascot")?.getAttribute("data-mood") };
    };
    expect(header(turnItems.slice(0, 3), true)).toEqual({ title: expect.stringMatching(/^Working for /), mood: "working" });
    expect(header([...turnItems, digest("completed")])).toEqual({ title: "Worked for 1m 4s", mood: "idle" });
    expect(header([...turnItems, digest("failed")])).toEqual({ title: "Failed after 1m 4s", mood: "failed" });
    expect(header([...turnItems, digest("cancelled")])).toEqual({ title: "Stopped after 1m 4s", mood: "failed" });
    // A retry that completes after an interruption leaves the turn completed.
    expect(header([...turnItems, digest("interrupted")])).toEqual({ title: "Interrupted after 1m 4s", mood: "failed" });
    expect(header([...turnItems, digest("interrupted"), digest("completed")])).toEqual({ title: "Worked for 1m 4s", mood: "idle" });
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
    expect(root.querySelector("summary .mascot")?.getAttribute("data-mood")).toBe("needs");
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

  it("keeps a steer inside the turn it was sent in and shows it in the trace as the user's guidance", () => {
    const items: ConversationItem[] = [
      ...turnItems.slice(0, 3),
      { id: "s1", kind: "message", role: "user", text: "Use the @Shop (tab 2, /tabs/2/page.md, https://shop.example/) instead", context: null, delivery: "steer", at: 3_500 },
      ...turnItems.slice(3),
      { id: "u2", kind: "message", role: "user", text: "Next", context: null, at: 70_000 },
    ];
    const turns = buildTurns(items, false);
    expect(turns.map((turn) => turn.prompt?.text)).toEqual(["Fill the form", "Next"]);
    expect(turns[0]!.steps.map((step) => step.kind)).toEqual(["activity", "steer", "text", "activity"]);
    expect(turns[0]!.answer).toEqual({ id: "a2", text: "Okay, not submitted." });
    const root = document.createElement("div");
    document.body.append(root);
    render(h(TurnTrace, { turn: turns[0]!, active: true, pendingApproval: null, onApprove: () => {}, onDeny: () => {} }), root);
    expect(root.querySelector(".trace__steer")?.textContent).toBe("YouUse the @Shop instead");
    render(null, root);
  });

  it("maps Enter to send and Ctrl/Cmd+Enter to steer only while steering is available", () => {
    const key = (overrides: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }>) =>
      ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, ...overrides });
    expect(composerKeyAction(key({}), true)).toBe("send");
    expect(composerKeyAction(key({ ctrlKey: true }), true)).toBe("steer");
    expect(composerKeyAction(key({ metaKey: true }), true)).toBe("steer");
    expect(composerKeyAction(key({ metaKey: true }), false)).toBe("send");
    expect(composerKeyAction(key({ shiftKey: true }), true)).toBeNull();
    expect(composerKeyAction(key({ key: "a" }), true)).toBeNull();
  });

  it("keeps the composer live during this chat's run: send queues, steer targets the run, and queued messages can be removed or sent", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const posted: Record<string, unknown>[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: (message: Record<string, unknown>) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    const emit = (event: Omit<SidebarEvent, "v" | "seq" | "at">) =>
      act(() => listeners.forEach((listener) => listener({ v: 1, seq: 1, at: 1, ...event })));
    await emit({ runId: null, conversationId: "a", type: "state.snapshot", payload: snapshotFor("a") });
    await emit({ runId: "r1", conversationId: "a", type: "run.started", payload: { prompt: "Find it", page: null, retry: false } });
    expect(composer.props).toMatchObject({ disabled: false, running: true, working: true, canSteer: true });

    await act(() => (composer.props!.onSteer as (text: string) => void)("Use tab 2"));
    expect(posted.at(-1)).toMatchObject({ type: "run.steer", runId: "r1", text: "Use tab 2" });
    expect(isSidebarCommand(posted.at(-1))).toBe(true);
    await act(() => (composer.props!.onSend as (text: string) => void)("Then summarize"));
    expect(posted.at(-1)).toMatchObject({ type: "run.start", prompt: "Then summarize" });

    await emit({ runId: null, conversationId: "a", type: "queue.changed", payload: { messages: [
      { id: "q1", mode: "steer", text: "Use tab 2", at: 1 }, { id: "q2", mode: "follow-up", text: "Then summarize", at: 2 },
    ] } });
    const rows = [...root.querySelectorAll(".queue__item")];
    expect(rows.map((row) => row.querySelector(".queue__label")?.textContent)).toEqual(["Steer", "Queued"]);
    // A pending steer cannot be withdrawn; nothing can be sent now while the run works.
    expect(rows[0]!.querySelector("button")).toBeNull();
    expect(rows[1]!.querySelector('[aria-label="Send now"]')).toBeNull();
    await act(() => (rows[1]!.querySelector('[aria-label="Remove from queue"]') as HTMLButtonElement).click());
    expect(posted.at(-1)).toMatchObject({ type: "queue.remove", sessionId: "a", messageId: "q2" });
    expect(isSidebarCommand(posted.at(-1))).toBe(true);

    await emit({ runId: "r1", conversationId: "a", type: "steer.delivered", payload: { item: { id: "q1", kind: "message", role: "user", text: "Use tab 2", context: null, delivery: "steer", at: 3 } } });
    expect(root.querySelectorAll(".queue__item")).toHaveLength(1);
    expect(root.querySelector(".trace__steer")?.textContent).toContain("Use tab 2");

    await emit({ runId: "r1", conversationId: "a", type: "run.failed", payload: { code: "RATE_LIMIT", message: "Rate limited.", retryable: true, phase: "provider" } });
    expect(composer.props).toMatchObject({ disabled: false, running: false, working: false });
    await act(() => (root.querySelector('.queue__item [aria-label="Send now"]') as HTMLButtonElement).click());
    expect(posted.at(-1)).toMatchObject({ type: "queue.send", sessionId: "a", messageId: "q2" });

    // A run in another chat keeps this chat's composer disabled.
    await emit({ runId: "r2", conversationId: "b", type: "run.started", payload: { prompt: "Elsewhere", page: null, retry: false } });
    expect(composer.props).toMatchObject({ disabled: true, working: false, canSteer: false });
    render(null, root);
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

describe("history drawer", () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const summary = (id: string, title: string, patch: Partial<ConversationSummary> = {}): ConversationSummary => ({
    id, title, titleSource: "prompt", createdAt: 0, updatedAt: now - 5 * 60_000, pinned: false, itemCount: 2, lastModelId: null, usage: EMPTY_USAGE, ...patch,
  });
  let root: HTMLDivElement;
  afterEach(() => render(null, root));

  async function mount(overrides: Partial<HistoryDrawerProps> = {}): Promise<HistoryDrawerProps> {
    const props: HistoryDrawerProps = {
      sessions: [summary("p", "Pinned trip", { pinned: true }), summary("a", "Alpha <b>bold</b>"), summary("b", "Beta", { updatedAt: now - 3 * 86_400_000 }), summary("e", "")],
      openId: "a",
      run: { conversationId: "b", awaitingApproval: false },
      agentTabs: {},
      now,
      onOpen: vi.fn(), onRename: vi.fn(), onPin: vi.fn(), onExport: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
      ...overrides,
    };
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(HistoryDrawer, props), root));
    return props;
  }
  const rows = () => [...root.querySelectorAll<HTMLLIElement>(".history__row")];
  const row = (title: string) => rows().find((candidate) => candidate.querySelector(".history__title")?.textContent === title)!;
  const labelled = (label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const key = (target: Element, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  const type = (input: HTMLInputElement, value: string) => act(() => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  it("lists pinned chats first with titles as text, recency, and open/running markers, focusing search", async () => {
    await mount();
    expect([...root.querySelectorAll(".history__group")].map((node) => node.textContent)).toEqual(["Pinned", "Recent"]);
    expect(rows().map((candidate) => candidate.querySelector(".history__title")?.textContent)).toEqual(["Pinned trip", "Alpha <b>bold</b>", "Beta", "New chat"]);
    expect(root.querySelector(".history__title b")).toBeNull();
    expect(row("Alpha <b>bold</b>").getAttribute("aria-current")).toBe("true");
    expect(row("Alpha <b>bold</b>").querySelector(".history__meta")?.textContent).toBe("5m ago · Current");
    expect(row("Beta").querySelector(".history__meta")?.textContent).toBe("3d ago · Working");
    expect(labelled("Delete Beta").hasAttribute("disabled")).toBe(true);
    expect(document.activeElement).toBe(labelled("Search chats by title"));
  });

  it("shows each chat's running usage total compactly in its row", async () => {
    const priced = { ...EMPTY_USAGE, responses: 4, input: 90_000, cacheRead: 60_000, output: 3_000, costUsd: 0.4321, pricedRuns: 2 };
    const plan = { ...EMPTY_USAGE, responses: 9, input: 1_150_000, output: 50_000, planRuns: 3 };
    await mount({ sessions: [summary("a", "Alpha", { usage: priced }), summary("b", "Beta", { usage: plan })] });
    expect(row("Alpha").querySelector(".history__meta")?.textContent).toBe("5m ago · Current · ~$0.43");
    expect(row("Beta").querySelector(".history__meta")?.textContent).toBe("5m ago · Working · 1.2M tokens");
    expect(row("Alpha").querySelector<HTMLElement>(".history__usage")?.title).toContain("Input: 90,000 tokens (60,000 cached)");
  });

  it("filters by title, case-insensitively", async () => {
    await mount();
    const search = labelled("Search chats by title") as HTMLInputElement;
    await type(search, "  ALPHA ");
    expect(rows().map((candidate) => candidate.querySelector(".history__title")?.textContent)).toEqual(["Alpha <b>bold</b>"]);
    expect(root.querySelector(".history__group")).toBeNull();
    await type(search, "zzz");
    expect(rows()).toHaveLength(0);
    expect(root.textContent).toContain("No chats match.");
  });

  it("opens, pins, unpins, and exports through callbacks", async () => {
    const props = await mount();
    await act(() => (row("Beta").querySelector(".history__open") as HTMLButtonElement).click());
    expect(props.onOpen).toHaveBeenCalledWith("b");
    await act(() => labelled("Pin Beta").click());
    expect(props.onPin).toHaveBeenCalledWith("b", true);
    await act(() => labelled("Unpin Pinned trip").click());
    expect(props.onPin).toHaveBeenCalledWith("p", false);
    await act(() => labelled("Export New chat").click());
    expect(props.onExport).toHaveBeenCalledWith("e");
  });

  it("renames inline: Enter saves a normalized title, Escape cancels without closing the drawer", async () => {
    const props = await mount();
    await act(() => labelled("Rename Beta").click());
    let input = labelled("Chat title") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Beta");
    input.value = "  Trip   plans ";
    await key(input, "Enter");
    expect(props.onRename).toHaveBeenCalledWith("b", "Trip plans");
    expect(root.querySelector('[aria-label="Chat title"]')).toBeNull();
    expect(document.activeElement).toBe(labelled("Rename Beta"));

    await act(() => labelled("Rename Beta").click());
    input = labelled("Chat title") as HTMLInputElement;
    input.value = "Discarded";
    await key(input, "Escape");
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
    expect(row("Beta")).toBeDefined();
  });

  it("deletes only after an inline confirmation, which Escape or Cancel dismisses", async () => {
    const props = await mount();
    await act(() => labelled("Delete Alpha <b>bold</b>").click());
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(labelled("Delete Alpha <b>bold</b>?")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Cancel");
    await key(document.activeElement!, "Escape");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(root.querySelector('[aria-label="Delete Alpha <b>bold</b>?"]')).toBeNull();
    expect(document.activeElement).toBe(labelled("Delete Alpha <b>bold</b>"));

    await act(() => labelled("Delete Alpha <b>bold</b>").click());
    expect(root.querySelector(".history__danger")?.textContent).toBe("Delete");
    await act(() => (root.querySelector(".history__danger") as HTMLButtonElement).click());
    expect(props.onDelete).toHaveBeenCalledWith("a", true);
    expect(document.activeElement).toBe(labelled("Search chats by title"));
  });

  it("shows a chat's hidden agent tabs and offers to close or keep them when deleting it", async () => {
    const props = await mount({ agentTabs: { a: 2, p: 1 } });
    expect(row("Alpha <b>bold</b>").querySelector(".history__meta")?.textContent).toBe("5m ago · Current · 2 hidden tabs");
    expect(row("Pinned trip").querySelector(".history__meta")?.textContent).toContain("· 1 hidden tab");
    expect(row("Beta").querySelector(".history__meta")?.textContent).not.toContain("tab");

    await act(() => labelled("Delete Alpha <b>bold</b>").click());
    const confirm = labelled("Delete Alpha <b>bold</b>?");
    expect(confirm.textContent).toContain("Delete? It has 2 hidden tabs.");
    expect([...confirm.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Cancel", "Delete, keep tabs", "Delete and close tabs"]);
    await act(() => [...confirm.querySelectorAll("button")].find((button) => button.textContent === "Delete, keep tabs")!.click());
    expect(props.onDelete).toHaveBeenLastCalledWith("a", false);

    await act(() => labelled("Delete Pinned trip").click());
    await act(() => (root.querySelector(".history__danger") as HTMLButtonElement).click());
    expect(props.onDelete).toHaveBeenLastCalledWith("p", true);
  });

  it("closes on Escape", async () => {
    const props = await mount();
    await key(labelled("Search chats by title"), "Escape");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("formats recency compactly", () => {
    expect(formatRelativeTime(now - 20_000, now)).toBe("Just now");
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe("59m ago");
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe("23h ago");
    expect(formatRelativeTime(now - 6 * 86_400_000, now)).toBe("6d ago");
    expect(formatRelativeTime(now - 30 * 86_400_000, now)).not.toMatch(/ago|2026/);
    expect(formatRelativeTime(Date.UTC(2025, 2, 4, 12), now)).toMatch(/2025/);
  });

  it("toggles from the sidebar header, requests a fresh list, and returns focus on close", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const posted: Array<{ type: string; sessionId?: string }> = [];
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: (message: { type: string }) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    expect(posted.map((message) => message.type)).toEqual(["state.subscribe", "session.list"]);
    const emit = (event: Omit<SidebarEvent, "v" | "seq" | "at">) => act(() => listeners.forEach((listener) => listener({ v: 1, seq: 0, at: 1, ...event })));
    await emit({ runId: null, conversationId: "a", type: "state.snapshot", payload: snapshotFor("a") });
    await emit({ runId: null, conversationId: null, type: "session.listed", payload: { sessions: [summary("a", "Alpha"), summary("b", "Beta")] } });

    const toggle = labelled("Chat history") as HTMLButtonElement;
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(posted.at(-1)?.type).toBe("session.list");
    expect(root.querySelector(".sidebar__chat")?.hasAttribute("inert")).toBe(true);
    // A pushed list replaces the rows while the drawer is open.
    await emit({ runId: null, conversationId: null, type: "session.listed", payload: { sessions: [summary("c", "Gamma"), summary("a", "Alpha")] } });
    expect(rows().map((candidate) => candidate.querySelector(".history__title")?.textContent)).toEqual(["Gamma", "Alpha"]);

    await key(labelled("Search chats by title"), "Escape");
    expect(root.querySelector(".history")).toBeNull();
    expect(document.activeElement).toBe(toggle);

    await act(() => toggle.click());
    await act(() => labelled("Export Gamma").click());
    expect(posted.at(-1)).toMatchObject({ type: "context.export", sessionId: "c" });
    expect(isSidebarCommand(posted.at(-1))).toBe(true);
    await act(() => (row("Gamma").querySelector(".history__open") as HTMLButtonElement).click());
    expect(posted.at(-1)).toMatchObject({ type: "session.open", sessionId: "c" });
    expect(root.querySelector(".history")).toBeNull();
  });

  it("introduces bside in an empty chat and titles the header with the chat, with no export button", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: () => {},
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    const emit = (event: Omit<SidebarEvent, "v" | "seq" | "at">) => act(() => listeners.forEach((listener) => listener({ v: 1, seq: 0, at: 1, ...event })));
    await emit({ runId: null, conversationId: "a", type: "state.snapshot", payload: snapshotFor("a") });

    expect(root.querySelector(".sidebar__title")?.textContent).toBe("New chat");
    expect(root.querySelector(".sidebar__empty h2")?.textContent).toBe("Hi, I'm bside");
    expect(root.querySelector(".sidebar__empty .mascot--blink")?.getAttribute("data-mood")).toBe("idle");
    expect(root.querySelector('[aria-label="Download context"]')).toBeNull();

    await emit({ runId: null, conversationId: "a", type: "state.snapshot", payload: { ...snapshotFor("a"), conversation: { ...snapshotFor("a").conversation, title: "Little guy <b>tweet</b>" } } });
    expect(root.querySelector(".sidebar__title")?.textContent).toBe("Little guy <b>tweet</b>");
    expect(root.querySelector(".sidebar__title b")).toBeNull();
  });

  it("lists only the open chat's agent tabs on the composer, watches one, and goes back", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const posted: Array<{ type: string; sessionId?: string; tabId?: number }> = [];
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime, "connect").mockReturnValue({
      postMessage: (message: { type: string }) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
      disconnect: () => {},
    } as never);
    root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    const emit = (event: Omit<SidebarEvent, "v" | "seq" | "at">) => act(() => listeners.forEach((listener) => listener({ v: 1, seq: 0, at: 1, ...event })));
    const tab = (id: number, patch: Partial<AgentTabSummary> = {}): AgentTabSummary => ({
      id, role: "agent", title: `Tab <i>${id}</i>`, url: `https://www.site-${id}.test/page`, favIconUrl: null, lastUsedAt: 0, ...patch,
    });
    const attached = (tabId: number) => ({ tabId, artifactId: `page:${tabId}`, kind: "page" as const, title: `Tab <i>${tabId}</i>`, url: `https://www.site-${tabId}.test/page`, capturedAt: 1 });
    const bySession = { a: [tab(5), tab(6, { favIconUrl: "data:image/png;base64,AAAA" })], b: [tab(9)] };
    await emit({ runId: null, conversationId: "a", type: "state.snapshot", payload: { ...snapshotFor("a"), agentTabs: { bySession: { b: [tab(9)] }, watching: null } } });
    expect(root.querySelector(".agent-tabs-toggle")).toBeNull();

    await emit({ runId: null, conversationId: null, type: "agent-tabs.changed", payload: { bySession, watching: null } });
    const toggle = root.querySelector<HTMLButtonElement>(".agent-tabs-toggle")!;
    expect(toggle.textContent).toBe("2 background tabs");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".agent-tabs")).toBeNull();
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect([...root.querySelectorAll(".agent-tab strong")].map((node) => node.textContent)).toEqual(["Tab <i>5</i>", "Tab <i>6</i>"]);
    expect(root.querySelector(".agent-tab i")).toBeNull();
    expect(root.querySelector(".agent-tab img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(root.querySelector(".agent-tab__icon--letter")?.textContent).toBe("S");

    await act(() => labelled("Watch Tab <i>5</i>").click());
    expect(posted.at(-1)).toEqual(expect.objectContaining({ type: "tabs.watch", tabId: 5 }));
    expect(isSidebarCommand(posted.at(-1))).toBe(true);

    // Watching: the background reports the tab watched, and it is the attached page.
    await emit({ runId: null, conversationId: null, type: "agent-tabs.changed", payload: { bySession, watching: 5 } });
    await emit({ runId: null, conversationId: null, type: "page.attached", payload: attached(5) });
    expect(toggle.textContent).toBe("Watching site-5.test");
    expect(root.querySelector(".composer--watching")).not.toBeNull();
    expect(root.querySelector(".agent-tab--watched small")?.textContent).toBe("You're watching");
    expect(root.querySelector(".context-chip--agent")?.textContent).toBe("Tab <i>5</i>bside's tab");
    expect(root.textContent).not.toContain("Close all");
    await act(() => root.querySelector<HTMLButtonElement>(".agent-tab__action--primary")!.click());
    expect(posted.at(-1)).toEqual(expect.objectContaining({ type: "tabs.unwatch" }));
    expect(isSidebarCommand(posted.at(-1))).toBe(true);

    // Another chat's agent tab is never shown as this chat's attached page.
    await emit({ runId: null, conversationId: null, type: "page.attached", payload: attached(9) });
    expect(root.querySelector(".context-chip")).toBeNull();
    await emit({ runId: null, conversationId: null, type: "page.attached", payload: attached(1) });
    expect(root.querySelector(".context-chip")?.textContent).toBe("Tab <i>1</i>www.site-1.test");

    await emit({ runId: null, conversationId: null, type: "agent-tabs.changed", payload: { bySession, watching: null } });
    await act(() => [...root.querySelectorAll<HTMLButtonElement>(".agent-tabs__close")][0]!.click());
    expect(posted.at(-1)).toEqual(expect.objectContaining({ type: "tabs.closeAgentTabs", sessionId: "a" }));
    expect(isSidebarCommand(posted.at(-1))).toBe(true);
  });
});
