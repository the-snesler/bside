// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { FrameAliases, TabController } from "@/lib/background/tab-controller";
import { createFramedTab, type FakeFrameSpec } from "./helpers/framed-tab";

const TOP = "https://shop.example/";
const EDITOR = "https://editor.example/";

function setup(top: string, frame = "<p>Frame</p>") {
  const specs: FakeFrameSpec[] = [
    { frameId: 0, url: TOP, html: `${top}<iframe title="Editor" data-frame-id="5" data-src="${EDITOR}"></iframe>` },
    { frameId: 5, url: EDITOR, html: frame },
  ];
  const tab = createFramedTab(specs);
  const controller = new TabController(tab.api, undefined, new FrameAliases());
  const onEffect = vi.fn();
  const program = new BrowserProgram(controller, { state: new WorkspaceState(), sessionId: "s1", files: new ScratchFiles() }, onEffect);
  const signal = new AbortController().signal;
  const run = (source: string) => program.execute(`const page = browser.tab("/tabs/1/page.md");\n${source}`, signal);
  return { tab, onEffect, run };
}

describe("hover in browser programs", () => {
  it("hovers by ref, in the top page or a frame, as a page effect with the action diff", async () => {
    const { tab, run, onEffect } = setup('<a id="products" href="/p">Products</a><ul id="menu" hidden><li><a href="/p/a">Alpha</a></li></ul>', '<button id="tools">Tools</button>');
    const document = tab.frames.get(0)!.document;
    document.getElementById("products")!.addEventListener("mouseover", () => { document.getElementById("menu")!.hidden = false; });
    let frameHovered = false;
    tab.frames.get(5)!.document.getElementById("tools")!.addEventListener("mouseenter", () => { frameHovered = true; });

    expect(await run('return await page.ref("e1").hover();')).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    expect(onEffect).not.toHaveBeenCalled();
    await run("await page.snapshot();");
    const hovered = await run('return await page.ref("e1").hover();');
    expect(hovered.ok, hovered.summary).toBe(true);
    expect(hovered.summary).toContain('+ - [e2 link "Alpha" → /p/a]');
    expect(onEffect).toHaveBeenCalledTimes(1);

    const inFrame = await run('return await page.ref("f1:e1").hover();');
    expect(inFrame.ok, inFrame.summary).toBe(true);
    expect(frameHovered).toBe(true);
    expect(tab.requestsTo(5).at(-1)).toMatchObject({ type: "page.execute", refPrefix: "f1:", action: { kind: "hover", target: { kind: "ref", ref: "e1", documentId: "doc-5" } } });
    expect((await run('return await page.ref("e1").hover(1);')).summary).toContain("hover() takes 0 arguments");
  });
});

describe("modifier presses in browser programs", () => {
  it("sends a parsed chord, in a frame too, and refuses keys outside the closed set before any effect", async () => {
    const { tab, run, onEffect } = setup('<textarea aria-label="Reply"></textarea>', '<div contenteditable="true" aria-label="Doc"></div>');
    await run("await page.snapshot();");
    const sent = await run('return await page.ref("e1").press("ctrl+Enter");');
    expect(sent.ok, sent.summary).toBe(true);
    expect(sent.summary).toContain('Pressed Control+Enter on [e1 textbox "Reply"].');
    expect(tab.requestsTo(0).at(-1)).toMatchObject({ type: "page.execute", action: { kind: "press", key: "Enter", modifiers: ["Control"] } });
    const plain = await run('return await page.ref("e1").press("Tab");');
    expect(tab.requestsTo(0).at(-1)).toMatchObject({ action: { kind: "press", key: "Tab" } });
    expect((tab.requestsTo(0).at(-1) as { action: object }).action).not.toHaveProperty("modifiers");
    expect(plain.ok).toBe(true);

    const framed = await run('return await page.ref("f1:e1").press("Shift+Meta+k");');
    expect(framed.ok, framed.summary).toBe(true);
    expect(tab.requestsTo(5).at(-1)).toMatchObject({ action: { kind: "press", key: "k", modifiers: ["Shift", "Meta"] } });

    const effects = onEffect.mock.calls.length;
    for (const [chord, message] of [["Control+c", "never uses the clipboard"], ["F12", "press() supports"], ["q", "type text with fill()"]] as const) {
      expect(await run(`return await page.ref("e1").press(${JSON.stringify(chord)});`)).toMatchObject({ ok: false, summary: expect.stringContaining(message) });
    }
    expect(onEffect.mock.calls.length).toBe(effects);
  });
});

describe("dragTo in browser programs", () => {
  const LIST = '<ul><li draggable="true">Alpha</li><li draggable="true">Beta</li></ul>';

  it("drags between refs or locators in one document, a frame's included", async () => {
    const { tab, run, onEffect } = setup(LIST, LIST);
    for (const document of [tab.frames.get(0)!.document, tab.frames.get(5)!.document]) {
      for (const item of Array.from(document.querySelectorAll("li"))) {
        item.addEventListener("dragstart", (event) => (event as DragEvent).dataTransfer!.setData("text/plain", item.textContent!));
        item.addEventListener("dragover", (event) => event.preventDefault());
        item.addEventListener("drop", () => {
          const dragged = Array.from(document.querySelectorAll("li")).find((candidate) => candidate.textContent === "Beta")!;
          item.before(dragged);
        });
      }
    }
    await run("await page.snapshot();");
    const top = await run('return await page.ref("e2").dragTo(page.getByRole("draggable", {name: "Alpha"}));');
    expect(top.ok, top.summary).toBe(true);
    expect(top.summary).toContain("Page outline reordered");
    expect(tab.requestsTo(0).at(-1)).toMatchObject({ action: { kind: "drag", target: { kind: "ref", ref: "e2", documentId: "doc-0" }, to: { kind: "role", role: "draggable", name: "Alpha" } } });

    const framed = await run('return await page.ref("f1:e2").dragTo("f1:e1");');
    expect(framed.ok, framed.summary).toBe(true);
    expect(tab.requestsTo(5).at(-1)).toMatchObject({ type: "page.execute", refPrefix: "f1:", action: { kind: "drag", target: { ref: "e2", documentId: "doc-5" }, to: { ref: "e1", documentId: "doc-5" } } });
    expect(Array.from(tab.frames.get(5)!.document.querySelectorAll("li"), (item) => item.textContent)).toEqual(["Beta", "Alpha"]);
    expect(onEffect).toHaveBeenCalledTimes(2);
  });

  it("refuses drags across frames, to unread refs, and to other tabs' or non-locator targets, before any effect", async () => {
    const { run, onEffect } = setup(LIST, LIST);
    expect(await run('return await page.ref("e1").dragTo("e2");')).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    await run("await page.snapshot();");
    expect(await run('return await page.ref("e1").dragTo(page.ref("f1:e1"));')).toMatchObject({
      ok: false, code: "INVALID_TOOL_ARGUMENTS", summary: expect.stringContaining("the dragged element is in the top page and the target is in frame f1"),
    });
    expect((await run('return await page.ref("e1").dragTo({ref: "e2"});')).summary).toContain("dragTo() expects a locator");
    expect((await run('return await page.ref("e1").dragTo("#list li");')).summary).toContain("dragTo() expects a locator");
    expect(onEffect).not.toHaveBeenCalled();
  });
});
