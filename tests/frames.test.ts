// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { FRAME_LIMITS, FrameAliases, TabController } from "@/lib/background/tab-controller";
import { createFramedTab, type FakeFrameSpec } from "./helpers/framed-tab";

const TOP = "https://shop.example/checkout";
const PAY = "https://pay.example/card";
const RECAPTCHA = "https://captcha.example/anchor";

function checkoutTab(extra: FakeFrameSpec[] = []) {
  return createFramedTab([
    { frameId: 0, url: TOP, title: "Checkout", html: '<h1>Checkout</h1><iframe title="Payment" data-frame-id="5" data-src="https://pay.example/card"></iframe><p>Total: $5</p><button>Place order</button>' },
    { frameId: 5, url: PAY, html: '<label for="card">Card number</label><input id="card"><button>Pay</button><iframe data-frame-id="6" data-src="https://captcha.example/anchor"></iframe>' },
    { frameId: 6, url: RECAPTCHA, html: '<p>I am not a robot</p><input type="checkbox" id="robot" aria-label="Not a robot">' },
    ...extra,
  ]);
}

async function bound(api: ReturnType<typeof createFramedTab>["api"], frames = new FrameAliases()) {
  const controller = await new TabController(api, undefined, frames).forTab(1);
  return controller;
}

describe("composed tab outlines", () => {
  it("reads each cross-origin frame through its own content script and splices it in at the frame's position", async () => {
    const tab = checkoutTab();
    const snapshot = await (await bound(tab.api)).snapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.text.split("\n")).toEqual([
      "# Checkout",
      `[frame f1 "Payment" (${PAY})]`,
      '  Card number [f1:e1 textbox "Card number"] [f1:e2 button "Pay"]',
      `  [frame f2 (${RECAPTCHA})]`,
      "    I am not a robot",
      '    [f2:e1 checkbox "Not a robot"]',
      "  [/frame f2]",
      "[/frame f1]",
      "Total: $5",
      '[e1 button "Place order"]',
    ]);
    expect(snapshot.value).toMatchObject({ documentId: "doc-0", url: TOP, title: "Checkout", frames: { f1: "doc-5", f2: "doc-6" } });
    expect(snapshot.value.totalChars).toBe(snapshot.value.text.length);
    // Each frame is asked by its own id, with the prefix its refs carry.
    expect(tab.requestsTo(5)).toEqual([expect.objectContaining({ type: "page.outline", frameId: 5, refPrefix: "f1:", maxChars: FRAME_LIMITS.charsPerFrame })]);
    expect(tab.requestsTo(6)).toEqual([expect.objectContaining({ type: "page.outline", frameId: 6, refPrefix: "f2:" })]);
  });

  it("asks only the top frame when the page has no cross-origin frames", async () => {
    const tab = createFramedTab([{ frameId: 0, url: TOP, html: '<p>Plain</p><iframe title="Same-origin" data-frame-id="5"></iframe>' }]);
    const snapshot = await (await bound(tab.api)).snapshot();
    // A same-origin frame is walked inline by the top frame, never asked for separately.
    expect(snapshot.ok && snapshot.value.text).toBe('Plain\n[frame "Same-origin" about:blank]\n[/frame]');
    expect(snapshot.ok && snapshot.value.frames).toBeUndefined();
    expect(tab.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("pages the composed outline like any other", async () => {
    const tab = checkoutTab();
    const controller = await bound(tab.api);
    const first = await controller.snapshot({ offset: 0, maxChars: 500 });
    const whole = await controller.snapshot();
    if (!first.ok || !whole.ok) throw new Error("snapshot failed");
    expect(first.value.totalChars).toBe(whole.value.text.length);
    const second = await controller.snapshot({ offset: 40, maxChars: 500 });
    expect(second.ok && second.value.text.startsWith('[frame f1 "Payment"')).toBe(true);
  });

  it("keeps a frame's name across snapshots, and gives a new frame the next one", async () => {
    const tab = checkoutTab([{ frameId: 9, url: "https://chat.example/", html: "<p>Chat</p>" }]);
    const frames = new FrameAliases();
    await (await bound(tab.api, frames)).snapshot();
    tab.frames.get(0)!.document.body.insertAdjacentHTML("afterbegin", '<iframe data-frame-id="9" data-src="https://chat.example/"></iframe>');
    for (const frame of Array.from(tab.frames.get(0)!.document.querySelectorAll<HTMLIFrameElement>("iframe[data-frame-id='9']"))) {
      Object.defineProperty(frame, "contentDocument", { get: () => null });
      Object.defineProperty(frame, "src", { get: () => frame.dataset.src });
    }
    // A fresh controller shares the background's names.
    const again = await (await bound(tab.api, frames)).snapshot();
    expect(again.ok && again.value.text).toMatch(/^\[frame f3 \(https:\/\/chat\.example\/\)\]\n {2}Chat\n\[\/frame f3\]\n# Checkout\n\[frame f1 "Payment"/);
    expect(frames.lookup(1, 2)).toEqual({ frameId: 6, parentFrameId: 5 });
  });

  it("shows a frame no content script answers in as a placeholder with its URL", async () => {
    const tab = createFramedTab([
      { frameId: 0, url: TOP, html: '<iframe title="Report" data-frame-id="5" data-src="https://docs.example/report.pdf"></iframe><p>After</p>' },
      { frameId: 5, url: "https://docs.example/report.pdf", html: "", unreadable: true },
    ]);
    const snapshot = await (await bound(tab.api)).snapshot();
    expect(snapshot.ok && snapshot.value.text).toBe('[frame f1 "Report" (https://docs.example/report.pdf) not readable: its content is not available to bside]\nAfter');
    expect(snapshot.ok && snapshot.value.frames).toEqual({});
  });

  it("bounds nesting depth, the number of frames, and each frame's size", async () => {
    // Four levels of frames, each inside the last.
    const nested = createFramedTab([
      { frameId: 0, url: TOP, html: '<iframe data-frame-id="1" data-src="https://a.example/"></iframe>' },
      { frameId: 1, url: "https://a.example/", html: '<p>A</p><iframe data-frame-id="2" data-src="https://b.example/"></iframe>' },
      { frameId: 2, url: "https://b.example/", html: '<p>B</p><iframe data-frame-id="3" data-src="https://c.example/"></iframe>' },
      { frameId: 3, url: "https://c.example/", html: '<p>C</p><iframe data-frame-id="4" data-src="https://d.example/"></iframe>' },
      { frameId: 4, url: "https://d.example/", html: "<p>D</p>" },
    ]);
    const deep = await (await bound(nested.api)).snapshot();
    expect(deep.ok && deep.value.text).toContain("      [frame f4 (https://d.example/) not shown: nested too deeply]");
    expect(deep.ok && deep.value.text).not.toContain("D\n");
    expect(nested.requestsTo(4)).toEqual([]);

    const many = createFramedTab([
      { frameId: 0, url: TOP, html: Array.from({ length: FRAME_LIMITS.frames + 2 }, (_, i) => `<iframe data-frame-id="${i + 1}" data-src="https://w${i + 1}.example/"></iframe>`).join("") },
      ...Array.from({ length: FRAME_LIMITS.frames + 2 }, (_, i) => ({ frameId: i + 1, url: `https://w${i + 1}.example/`, html: `<p>Widget ${i + 1}</p>` })),
    ]);
    const wide = await (await bound(many.api)).snapshot({ offset: 0, maxChars: 40_000 });
    expect(wide.ok && wide.value.text).toContain(`Widget ${FRAME_LIMITS.frames}`);
    expect(wide.ok && wide.value.text).toContain(`[frame f${FRAME_LIMITS.frames + 1} (https://w${FRAME_LIMITS.frames + 1}.example/) not shown: frame limit for one page reached]`);
    expect(many.requestsTo(FRAME_LIMITS.frames + 1)).toEqual([]);

    const big = createFramedTab([
      { frameId: 0, url: TOP, html: '<iframe data-frame-id="1" data-src="https://big.example/"></iframe><p>End</p>' },
      { frameId: 1, url: "https://big.example/", html: Array.from({ length: 2_000 }, (_, i) => `<p>Row ${i} of a very long frame</p>`).join("") },
    ]);
    const capped = await (await bound(big.api)).snapshot({ offset: 0, maxChars: 40_000 });
    if (!capped.ok) throw new Error("snapshot failed");
    expect(capped.value.text).toContain("  [Frame outline truncated: it exceeds the frame size limit]\n[/frame f1]\nEnd");
    expect(capped.value.totalChars).toBeLessThan(FRAME_LIMITS.charsPerFrame + 2_000 * 4);
  });

  it("finds text inside frames, with frame-prefixed refs and offsets in the composed outline", async () => {
    const tab = checkoutTab();
    const controller = await bound(tab.api);
    const found = await controller.find("pay");
    const whole = await controller.snapshot();
    if (!found.ok || !whole.ok) throw new Error("find failed");
    expect(found.value).toMatchObject({ documentId: "doc-0", url: TOP, query: "pay", frames: { f1: "doc-5", f2: "doc-6" } });
    const match = found.value.matches.find((candidate) => candidate.text.includes("f1:e2"))!;
    expect(match.text).toContain('[f1:e2 button "Pay"]');
    expect(whole.value.text.slice(match.offset)).toMatch(/^ {2}Card number/);
  });
});
