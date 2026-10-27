// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOutline, createElementRefRegistry, excludeFromOutline, executeDomAction, findInPage, measureForCapture, type ElementRefRegistry } from "@/lib/tools/page-executor";
import { blocksPageInput, createPageShield, type PageShield } from "@/lib/tools/page-shield";
import type { DomAction } from "@/lib/domain/tools";

const instant = async () => {};

/** The shield's closed shadow root, which page scripts cannot reach; captured here only to inspect it. */
let shieldRoot: ShadowRoot | null = null;
const mounted: PageShield[] = [];

function mountShield(onTakeOver = vi.fn()): { shield: PageShield; onTakeOver: typeof onTakeOver; host: () => Element | null } {
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    if (this.localName === "bside-shield") shieldRoot = root;
    return root;
  });
  const shield = createPageShield(document, onTakeOver);
  mounted.push(shield);
  return { shield, onTakeOver, host: () => document.querySelector("bside-shield") };
}

function act(registry: ElementRefRegistry, action: DomAction) {
  return executeDomAction(document, registry, action, instant);
}

beforeEach(() => {
  document.body.innerHTML = `
    <h1>Checkout</h1>
    <label>Email <input id="email" type="email"></label>
    <button id="save" type="button">Save</button>
    <p id="log"></p>`;
  document.querySelector("#save")!.addEventListener("click", () => { document.querySelector("#log")!.textContent = "Saved!"; });
});

afterEach(() => {
  for (const shield of mounted.splice(0)) shield.set("off");
  shieldRoot = null;
  vi.restoreAllMocks();
});

describe("page shield", () => {
  it("covers the page from a closed shadow root outside <body>, and leaves nothing behind when off", () => {
    const { shield, host } = mountShield();
    expect(host()).toBeNull();

    shield.set("working");
    expect(host()?.parentElement).toBe(document.documentElement);
    expect(host()?.shadowRoot).toBeNull();
    expect(shieldRoot?.textContent).toContain("bside is working in this tab");
    expect(shieldRoot?.querySelector("button")?.textContent).toBe("Take over");
    // Page CSS cannot hide or move the host: its own styles are important inline declarations.
    expect((host() as HTMLElement).style.getPropertyPriority("position")).toBe("important");

    shield.set("idle");
    expect(shieldRoot?.textContent).toContain("This is bside's tab");
    expect(document.querySelectorAll("bside-shield")).toHaveLength(1);

    shield.set("off");
    expect(host()).toBeNull();
    expect(shield.state).toBe("off");
  });

  it("is never part of a snapshot, find, or action diff", async () => {
    const { shield } = mountShield();
    shield.set("working");
    const registry = createElementRefRegistry("doc");
    const outline = buildOutline(document, registry).lines.join("\n");
    expect(outline).toContain("Save");
    expect(outline).not.toMatch(/bside|Take over/);
    expect(findInPage(document, registry, "Take over").count).toBe(0);

    const result = await act(registry, { kind: "click", target: { kind: "role", role: "button", name: "Save", exact: true } });
    expect(result.summary).not.toMatch(/bside|Take over/);
  });

  it("skips any element registered as bside's own, even inside <body> with an open shadow root", () => {
    const own = document.createElement("div");
    own.attachShadow({ mode: "open" }).innerHTML = "<button>Take over</button>";
    document.body.append(own);
    const registry = createElementRefRegistry("doc");
    expect(buildOutline(document, registry).lines.join("\n")).toContain("Take over");
    excludeFromOutline(own);
    expect(buildOutline(document, registry).lines.join("\n")).not.toContain("Take over");
  });

  it("lets the agent's click, fill, and press through while it is up", async () => {
    const { shield } = mountShield();
    shield.set("working");
    const registry = createElementRefRegistry("doc");
    const keys: string[] = [];
    document.querySelector("#email")!.addEventListener("keydown", (event) => keys.push((event as KeyboardEvent).key));

    expect(await act(registry, { kind: "click", target: { kind: "role", role: "button", name: "Save", exact: true } })).toMatchObject({ ok: true });
    expect(document.querySelector("#log")!.textContent).toBe("Saved!");
    expect(await act(registry, { kind: "fill", target: { kind: "role", role: "textbox", name: "Email", exact: true }, text: "a@b.test" })).toMatchObject({ ok: true });
    expect((document.querySelector("#email") as HTMLInputElement).value).toBe("a@b.test");
    expect(document.activeElement?.id).toBe("email");
    expect(await act(registry, { kind: "press", target: { kind: "role", role: "textbox", name: "Email", exact: true }, key: "Enter" })).toMatchObject({ ok: true });
    expect(keys).toEqual(["Enter"]);
  });

  it("blocks only trusted input aimed at the page, never the agent's synthetic events or the shield's own", () => {
    const host = document.createElement("bside-shield");
    const path = (...targets: EventTarget[]) => () => targets;
    expect(blocksPageInput({ isTrusted: true, composedPath: path(document.body, document, window) }, host)).toBe(true);
    expect(blocksPageInput({ isTrusted: false, composedPath: path(document.body, document, window) }, host)).toBe(false);
    expect(blocksPageInput({ isTrusted: true, composedPath: path(host, document.documentElement, document, window) }, host)).toBe(false);
  });

  it("keeps its own clicks from reaching the page, and ignores a synthetic Take over", () => {
    const { shield, onTakeOver } = mountShield();
    shield.set("working");
    const pageClicks = vi.fn();
    document.addEventListener("click", pageClicks);
    const button = shieldRoot!.querySelector("button")!;
    button.click();
    expect(onTakeOver).not.toHaveBeenCalled();
    expect(shield.state).toBe("working");
    expect(pageClicks).not.toHaveBeenCalled();
    document.removeEventListener("click", pageClicks);
  });

  it("takes over on a trusted click: hides at once and tells the background", () => {
    const { shield, onTakeOver, host } = mountShield();
    shield.set("working");
    const click = new MouseEvent("click", { bubbles: true, composed: true });
    Object.defineProperty(click, "isTrusted", { value: true });
    shieldRoot!.querySelector("button")!.dispatchEvent(click);
    expect(onTakeOver).toHaveBeenCalledOnce();
    expect(shield.state).toBe("off");
    expect(host()).toBeNull();
  });

  it("comes back if the page removes it while it is up", async () => {
    const { shield, host } = mountShield();
    shield.set("working");
    host()!.remove();
    await vi.waitFor(() => expect(host()?.parentElement).toBe(document.documentElement));
    shield.set("off");
    expect(host()).toBeNull();
  });

  it("is hidden from a screenshot but keeps blocking the user's input, and shows again after", () => {
    const { shield, host } = mountShield();
    shield.set("working");
    shield.hideForCapture(true);
    expect((host() as HTMLElement).style.getPropertyValue("visibility")).toBe("hidden");
    expect((host() as HTMLElement).style.getPropertyPriority("visibility")).toBe("important");
    const pageKeys = vi.fn();
    document.addEventListener("keydown", pageKeys);
    const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true });
    Object.defineProperty(key, "isTrusted", { value: true });
    document.querySelector("#email")!.dispatchEvent(key);
    expect(pageKeys).not.toHaveBeenCalled();
    document.removeEventListener("keydown", pageKeys);
    shield.hideForCapture(false);
    expect((host() as HTMLElement).style.getPropertyValue("visibility")).toBe("visible");
  });

  it("is not measured as a screenshot target", () => {
    mountShield().shield.set("working");
    const registry = createElementRefRegistry("doc");
    expect(measureForCapture(document, registry, { kind: "role", role: "button", name: "Take over", exact: false })).toMatchObject({ ok: false, result: { code: "TARGET_MISSING" } });
  });
});
