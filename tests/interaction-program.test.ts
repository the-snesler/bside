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
