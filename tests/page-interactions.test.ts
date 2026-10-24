// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { buildOutline, createElementRefRegistry, executeDomAction, type ElementRefRegistry } from "@/lib/tools/page-executor";
import type { DomAction, ElementTarget } from "@/lib/domain/tools";

const instant = async () => {};

function ref(name: string, documentId = "doc"): ElementTarget {
  return { kind: "ref", ref: name, documentId };
}

function setup(html: string): ElementRefRegistry {
  document.body.innerHTML = html;
  const registry = createElementRefRegistry("doc");
  buildOutline(document, registry);
  return registry;
}

function act(registry: ElementRefRegistry, action: DomAction) {
  return executeDomAction(document, registry, action, instant);
}

/** Records the events of `types` each element receives, as "id:type". */
function record(types: string[]): string[] {
  const log: string[] = [];
  for (const element of Array.from(document.querySelectorAll("[id]"))) {
    for (const type of types) element.addEventListener(type, (event) => { if (event.currentTarget === event.target || !event.bubbles) log.push(`${element.id}:${type}`); });
  }
  return log;
}

describe("hover", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  const MENU = `
    <nav id="nav">
      <a id="products" href="/products">Products</a>
      <ul id="menu" hidden><li><a href="/products/a">Alpha</a></li></ul>
      <a id="about" href="/about">About</a>
    </nav>`;

  function wireMenu(): void {
    const menu = document.getElementById("menu")!;
    document.getElementById("products")!.addEventListener("mouseenter", () => { menu.hidden = false; });
    document.getElementById("products")!.addEventListener("mouseleave", () => { menu.hidden = true; });
  }

  it("opens a mouseover menu and reports what appeared", async () => {
    const registry = setup(MENU);
    wireMenu();
    const result = await act(registry, { kind: "hover", target: ref("e1") });
    expect(result).toMatchObject({ ok: true });
    expect(result.summary).toContain('Hovered over [e1 link "Products"].');
    expect(result.summary).toContain('+ - [e3 link "Alpha" → /products/a]');
  });

  it("dispatches over, enter, and move with pointer coordinates, and leaves the previous element first", async () => {
    const registry = setup(MENU);
    wireMenu();
    const log = record(["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove", "pointerout", "mouseout", "pointerleave", "mouseleave"]);
    await act(registry, { kind: "hover", target: ref("e1") });
    expect(log).toEqual([
      "products:pointerover", "products:mouseover",
      "nav:pointerenter", "nav:mouseenter", "products:pointerenter", "products:mouseenter",
      "products:pointermove", "products:mousemove",
    ]);
    log.length = 0;
    const moved = await act(registry, { kind: "hover", target: ref("e2") });
    // Leaving Products closes its menu again; the shared nav ancestor is neither left nor re-entered.
    expect(log).toEqual([
      "products:pointerout", "products:mouseout", "products:pointerleave", "products:mouseleave",
      "about:pointerover", "about:mouseover", "about:pointerenter", "about:mouseenter",
      "about:pointermove", "about:mousemove",
    ]);
    expect(document.getElementById("menu")!.hidden).toBe(true);
    expect(moved.summary).toContain("Hovered over [e2 link \"About\"].");
  });

  it("says when nothing opened, since CSS :hover menus ignore the agent's pointer", async () => {
    const registry = setup('<button>Account</button>');
    const result = await act(registry, { kind: "hover", target: ref("e1") });
    expect(result.summary).toContain("Page outline unchanged.");
    expect(result.summary).toContain("CSS :hover");
  });

  it("requires the exact document its ref came from", async () => {
    const registry = setup(MENU);
    expect(await act(registry, { kind: "hover", target: ref("e1", "old") })).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
  });
});

describe("modifier presses", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  function keys(id: string): string[] {
    const log: string[] = [];
    for (const type of ["keydown", "keypress", "keyup"]) {
      document.getElementById(id)!.addEventListener(type, (event) => {
        const key = event as KeyboardEvent;
        const held = [key.ctrlKey && "C", key.altKey && "A", key.shiftKey && "S", key.metaKey && "M"].filter(Boolean).join("");
        log.push(`${type} ${key.key}/${key.code}${held ? ` +${held}` : ""}`);
      });
    }
    return log;
  }

  it("holds each modifier down around the key, with the flags set, then releases them in reverse", async () => {
    const registry = setup('<textarea id="message" aria-label="Message"></textarea>');
    const log = keys("message");
    const result = await act(registry, { kind: "press", target: ref("e1"), key: "Enter", modifiers: ["Control", "Shift"] });
    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('Pressed Control+Shift+Enter on [e1 textbox "Message"].') });
    expect(log).toEqual([
      "keydown Control/ControlLeft +C", "keydown Shift/ShiftLeft +CS",
      "keydown Enter/Enter +CS", "keyup Enter/Enter +CS",
      "keyup Shift/ShiftLeft +C", "keyup Control/ControlLeft",
    ]);
  });

  it("sends a page's own Control+Enter handler the chord, without the unmodified Enter's form submit", async () => {
    const registry = setup('<form id="form"><input id="q" aria-label="Query"><p id="out"></p></form>');
    let submitted = 0;
    document.getElementById("form")!.addEventListener("submit", (event) => { event.preventDefault(); submitted++; });
    document.getElementById("q")!.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter" && (event as KeyboardEvent).ctrlKey) document.getElementById("out")!.textContent = "Sent with Ctrl+Enter";
    });
    const result = await act(registry, { kind: "press", target: ref("e1"), key: "Enter", modifiers: ["Control"] });
    expect(result.summary).toContain("+ Sent with Ctrl+Enter");
    expect(submitted).toBe(0);
    await act(registry, { kind: "press", target: ref("e1"), key: "Enter" });
    expect(submitted).toBe(1);
  });

  it("presses letters with their key codes, uppercase under Shift", async () => {
    const registry = setup('<div id="editor" contenteditable="true" aria-label="Doc"></div>');
    const log = keys("editor");
    await act(registry, { kind: "press", target: ref("e1"), key: "k", modifiers: ["Meta"] });
    await act(registry, { kind: "press", target: ref("e1"), key: "z", modifiers: ["Control", "Shift"] });
    await act(registry, { kind: "press", target: ref("e1"), key: "7", modifiers: ["Alt"] });
    expect(log.filter((line) => line.startsWith("keydown") && !/Left/.test(line))).toEqual(["keydown k/KeyK +M", "keydown Z/KeyZ +CS", "keydown 7/Digit7 +A"]);
  });
});
