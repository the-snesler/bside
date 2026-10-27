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

describe("drag and drop", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  /** A sortable list built on HTML drag and drop: dropping an item moves the dragged one before it. */
  function sortable(): ElementRegistryAndLog {
    const registry = setup('<ul id="list"><li id="a" draggable="true">Alpha</li><li id="b" draggable="true">Beta</li><li id="c" draggable="true">Gamma</li></ul>');
    const log: string[] = [];
    for (const item of Array.from(document.querySelectorAll("li"))) {
      for (const type of ["dragstart", "drag", "dragenter", "dragleave", "dragover", "drop", "dragend"]) {
        item.addEventListener(type, (event) => { if (event.currentTarget === event.target) log.push(`${item.id}:${type}`); });
      }
      item.addEventListener("dragstart", (event) => (event as DragEvent).dataTransfer!.setData("text/plain", item.id));
      item.addEventListener("dragover", (event) => event.preventDefault());
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const dragged = document.getElementById((event as DragEvent).dataTransfer!.getData("text/plain"))!;
        item.before(dragged);
      });
    }
    return { registry, log };
  }
  interface ElementRegistryAndLog { registry: ElementRegistry; log: string[] }
  type ElementRegistry = ReturnType<typeof setup>;

  const order = () => Array.from(document.querySelectorAll("li"), (item) => item.textContent).join(",");

  it("lists draggable items as drag sources", () => {
    sortable();
    expect(buildOutline(document, createElementRefRegistry("doc")).lines).toEqual(['- [e1 draggable "Alpha"]', '- [e2 draggable "Beta"]', '- [e3 draggable "Gamma"]']);
  });

  it("drags a draggable item with HTML drag and drop, sharing one DataTransfer from dragstart to drop", async () => {
    const { registry, log } = sortable();
    const result = await act(registry, { kind: "drag", target: ref("e3"), to: ref("e1") });
    expect(result).toMatchObject({ ok: true });
    expect(result.summary).toContain('Dragged [e3 draggable "Gamma"] onto [e1 draggable "Alpha"] (HTML drag and drop).');
    expect(order()).toBe("Gamma,Alpha,Beta");
    expect(log).toEqual(["c:dragstart", "c:drag", "a:dragenter", "c:dragleave", "c:drag", "a:dragover", "c:drag", "a:dragover", "a:drop", "c:dragend"]);
    expect(result.summary).toContain('Page outline reordered (3 lines moved); that part now reads:\n~ - [e3 draggable "Gamma"]\n~ - [e1 draggable "Alpha"]\n~ - [e2 draggable "Beta"]');
  });

  it("drops nothing on a target that does not accept drops, and says so", async () => {
    document.body.innerHTML = '<div id="card" draggable="true">Card</div><button id="bin">Bin</button>';
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    let dropped = false;
    document.getElementById("bin")!.addEventListener("drop", () => { dropped = true; });
    expect(await act(registry, { kind: "drag", target: ref("e1"), to: ref("e2") })).toMatchObject({ ok: false, code: "NOT_INTERACTABLE", summary: expect.stringContaining("does not accept drops") });
    expect(dropped).toBe(false);
  });

  it("stops when the page cancels dragstart", async () => {
    const { registry } = sortable();
    document.getElementById("a")!.addEventListener("dragstart", (event) => event.preventDefault());
    expect(await act(registry, { kind: "drag", target: ref("e1"), to: ref("e2") })).toMatchObject({ ok: false, summary: expect.stringContaining("cancelled dragging") });
    expect(order()).toBe("Alpha,Beta,Gamma");
  });

  it("drags other elements with pointer events: down on the source, moves with the button held, up on the target", async () => {
    const registry = setup('<main id="board"><div id="todo"><div id="card" role="button">Write report</div></div><div id="done"><button id="drop">Done column</button></div></main>');
    const log: string[] = [];
    let dragging: Element | null = null;
    for (const type of ["pointerdown", "mousedown", "pointermove", "mousemove", "pointerup", "mouseup"]) {
      // Like a board library, listen above the items (the board, not the document, so later tests do not hear it).
      document.getElementById("board")!.addEventListener(type, (event) => {
        const mouse = event as MouseEvent;
        log.push(`${(event.target as Element).id}:${type}:${mouse.buttons}`);
        if (type === "pointerdown") dragging = event.target as Element;
        if (type === "pointerup" && dragging) document.getElementById("done")!.append(dragging);
      });
    }
    const result = await act(registry, { kind: "drag", target: ref("e1"), to: ref("e2") });
    expect(result.summary).toContain('Dragged [e1 button "Write report"] onto [e2 button "Done column"] (pointer events).');
    expect(document.getElementById("card")!.parentElement!.id).toBe("done");
    expect(log.filter((line) => /down|up/.test(line))).toEqual(["card:pointerdown:1", "card:mousedown:1", "drop:pointerup:0", "drop:mouseup:0"]);
    expect(log.filter((line) => /move:1$/.test(line)).length).toBeGreaterThanOrEqual(8);
    expect(log).toContain("drop:pointermove:1");
  });

  it("refuses a stale drop target and dropping an element onto itself", async () => {
    const { registry } = sortable();
    expect(await act(registry, { kind: "drag", target: ref("e1"), to: ref("e2", "old") })).toMatchObject({ ok: false, code: "STALE_SNAPSHOT", summary: expect.stringContaining("Drop target: Ref e2 came from an earlier page load") });
    expect(await act(registry, { kind: "drag", target: ref("e1"), to: ref("e1") })).toMatchObject({ ok: false, code: "INVALID_TOOL_ARGUMENTS" });
  });
});

describe("choose in comboboxes", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  const COUNTRIES = ["Cameroon", "Canada", "Chile", "Denmark"];

  /** An ARIA 1.2 editable combobox that filters its listbox as the user types and fills itself from a clicked option. */
  function autocomplete(options: { async?: boolean; inert?: boolean } = {}): ElementRegistry {
    const registry = setup('<label for="country">Country</label><input id="country" role="combobox" aria-controls="country-list" aria-expanded="false" autocomplete="off"><ul id="country-list" role="listbox" hidden></ul><p id="out"></p>');
    const input = document.getElementById("country") as HTMLInputElement;
    const list = document.getElementById("country-list")!;
    const render = () => {
      list.innerHTML = COUNTRIES.filter((country) => country.toLowerCase().includes(input.value.toLowerCase()))
        .map((country) => `<li role="option" id="opt-${country}">${country}</li>`).join("");
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    input.addEventListener("input", () => (options.async ? setTimeout(render, 30) : render()));
    input.addEventListener("click", render);
    list.addEventListener("click", (event) => {
      if (options.inert) return;
      const option = (event.target as Element).closest("[role=option]")!;
      input.value = option.textContent!;
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      document.getElementById("out")!.textContent = `Country set: ${input.value}`;
    });
    return registry;
  }
  type ElementRegistry = ReturnType<typeof setup>;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  it("types to filter, picks the only option containing the text, and confirms the value", async () => {
    const registry = autocomplete();
    const result = await act(registry, { kind: "choose", target: ref("e1"), option: "Can" });
    expect(result).toMatchObject({ ok: true });
    expect(result.summary).toContain('Chose "Canada" in [e1 combobox "Country"]; it shows "Canada".');
    expect(result.summary).toContain("+ Country set: Canada");
    expect((document.getElementById("country") as HTMLInputElement).value).toBe("Canada");
  });

  it("waits for options a widget renders later", async () => {
    const registry = autocomplete({ async: true });
    const result = await executeDomAction(document, registry, { kind: "choose", target: ref("e1"), option: "denmark" }, tick);
    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('Chose "Denmark"') });
  });

  it("never guesses among several matches, and lists the options when none match", async () => {
    const registry = autocomplete();
    expect(await act(registry, { kind: "choose", target: ref("e1"), option: "C" })).toMatchObject({
      ok: false, code: "TARGET_MISSING", summary: expect.stringContaining('3 options match "C" in [e1 combobox "Country"]: "Cameroon", "Canada", "Chile"'),
    });
    expect((document.getElementById("out")!.textContent)).toBe("");
    expect(await act(registry, { kind: "choose", target: ref("e1"), option: "Narnia" })).toMatchObject({
      ok: false, code: "TARGET_MISSING", summary: expect.stringContaining("No options appeared for [e1 combobox"),
    });
  });

  it("opens a button-like combobox with a click and picks from its listbox without typing", async () => {
    const registry = setup('<div id="size" role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-controls="sizes" aria-label="Size">Medium</div><div id="sizes" role="listbox" hidden><div role="option">Small</div><div role="option" aria-disabled="true">Large</div><div role="option">Medium</div></div>');
    const size = document.getElementById("size")!;
    const sizes = document.getElementById("sizes")!;
    size.addEventListener("click", () => { sizes.hidden = false; size.setAttribute("aria-expanded", "true"); });
    sizes.addEventListener("click", (event) => {
      const option = (event.target as Element).closest("[role=option]")!;
      if (option.getAttribute("aria-disabled") === "true") return;
      size.textContent = option.textContent;
      sizes.hidden = true;
    });
    expect(await act(registry, { kind: "choose", target: ref("e1"), option: "small" })).toMatchObject({ ok: true, summary: expect.stringContaining('Chose "Small" in [e1 combobox "Size"]; it shows "Small".') });
    expect(await act(registry, { kind: "choose", target: ref("e1"), option: "Large" })).toMatchObject({ ok: false, code: "NOT_INTERACTABLE", summary: 'Option "Large" is disabled.' });
    expect(await act(registry, { kind: "choose", target: ref("e1"), option: "Huge" })).toMatchObject({ ok: false, summary: expect.stringContaining('Options shown: "Small", "Large", "Medium".') });
  });

  it("says so when the clicked option did not show up in the field", async () => {
    const registry = autocomplete({ inert: true });
    const result = await act(registry, { kind: "choose", target: ref("e1"), option: "Chile" });
    expect(result).toMatchObject({ ok: true, summary: expect.stringContaining('Clicked option "Chile" in [e1 combobox "Country"], but could not confirm it: the field shows "Chile".') });
  });

  it("selects native options and datalist suggestions, and refuses controls that are not comboboxes", async () => {
    const registry = setup('<select aria-label="Plan"><option>Free</option><option>Team</option></select><input aria-label="City" list="cities"><datalist id="cities"><option value="Oslo"></option><option value="Osaka"></option></datalist><button>Go</button>');
    expect(await act(registry, { kind: "choose", target: ref("e1"), option: "Team" })).toMatchObject({ ok: true, summary: expect.stringContaining('Selected "Team"') });
    expect(await act(registry, { kind: "choose", target: ref("e2"), option: "osl" })).toMatchObject({ ok: true });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("Oslo");
    expect(await act(registry, { kind: "choose", target: ref("e2"), option: "Os" })).toMatchObject({ ok: false, summary: expect.stringContaining('2 suggestions match "Os"') });
    expect(await act(registry, { kind: "choose", target: ref("e3"), option: "x" })).toMatchObject({ ok: false, code: "NOT_INTERACTABLE", summary: expect.stringContaining("fill(text, {commit: true})") });
  });
});

describe("typed-date pickers", () => {
  /** A picker input that parses MM/DD/YYYY on Enter or blur and shows it as "Mon D, YYYY", clearing anything else. */
  function datePicker(): ReturnType<typeof setup> {
    const registry = setup('<label for="when">Departure</label><input id="when" placeholder="MM/DD/YYYY"><p id="log"></p>');
    const input = document.getElementById("when") as HTMLInputElement;
    const commit = () => {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.value);
      if (!match) { if (!/^[A-Z][a-z]{2} /.test(input.value)) input.value = ""; return; }
      const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[1]) - 1];
      input.value = `${month} ${Number(match[2])}, ${match[3]}`;
      document.getElementById("log")!.textContent = "Committed";
    };
    input.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") commit(); });
    input.addEventListener("blur", commit);
    return registry;
  }

  it("commits typed dates with Enter and blur, and reports the value the picker kept", async () => {
    const registry = datePicker();
    const result = await act(registry, { kind: "fill", target: ref("e1"), text: "11/03/2026", commit: true });
    expect(result).toMatchObject({ ok: true });
    expect(result.summary).toContain('Filled and committed [e1 textbox "Departure"]; it shows "Nov 3, 2026" (the field reformatted it).');
    expect(result.summary).toContain("+ Committed");
  });

  it("fails when the picker rejects the text, pointing at its placeholder", async () => {
    const registry = datePicker();
    expect(await act(registry, { kind: "fill", target: ref("e1"), text: "2026-11-03", commit: true })).toMatchObject({
      ok: false, code: "NOT_INTERACTABLE", summary: expect.stringContaining('did not keep "2026-11-03"; it is empty after Enter and blur. Its placeholder suggests the format "MM/DD/YYYY".'),
    });
  });

  it("does not submit the field's form on the commit's Enter", async () => {
    const registry = setup('<form id="f"><input aria-label="Date"></form>');
    let submitted = false;
    document.getElementById("f")!.addEventListener("submit", (event) => { event.preventDefault(); submitted = true; });
    expect(await act(registry, { kind: "fill", target: ref("e1"), text: "2026-11-03", commit: true })).toMatchObject({ ok: true, summary: expect.stringContaining('it shows "2026-11-03".') });
    expect(submitted).toBe(false);
  });
});
