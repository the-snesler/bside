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
