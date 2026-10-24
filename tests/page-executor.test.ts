// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildOutline,
  createElementRefRegistry,
  describeChanges,
  executeDomAction,
  extractSearchResults,
  extractSnapshot,
  findInPage,
  measureForCapture,
  type ElementRefRegistry,
} from "@/lib/tools/page-executor";
import type { DomAction, ElementTarget } from "@/lib/domain/tools";

const instant = async () => {};

function setBody(html: string): void {
  document.body.innerHTML = html;
}

function outline(registry = createElementRefRegistry("doc")): string {
  return buildOutline(document, registry).lines.join("\n");
}

function role(roleName: string, name: string | null = null, exact = false): ElementTarget {
  return { kind: "role", role: roleName, name, exact };
}

function act(registry: ElementRefRegistry, action: DomAction) {
  return executeDomAction(document, registry, action, instant);
}

/** Mirrors the benchmark's Shadow DOM form: slotted light-DOM inputs, labels in slots, submit button inside a shadow root. */
function mountShadowForm(): void {
  setBody('<style>#ok{display:none}</style><h1>Shadow DOM Form</h1><div id="ok">Success! The secret is: dumbledore</div><div id="host"></div>');
  const form = document.createElement("custom-form");
  const formRoot = form.attachShadow({ mode: "open" });
  formRoot.innerHTML = '<form><slot></slot><div><button type="submit">Submit Form</button></div></form>';
  for (const [label, type] of [["Email Address", "email"], ["Date", "date"]] as const) {
    const field = document.createElement("custom-field");
    field.attachShadow({ mode: "open" }).innerHTML = '<div><label><slot name="label"></slot></label><div><slot name="input"></slot></div></div>';
    const span = Object.assign(document.createElement("span"), { slot: "label", textContent: label });
    const input = Object.assign(document.createElement("input"), { type, slot: "input", name: type });
    field.append(span, input);
    form.append(field);
  }
  formRoot.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    document.getElementById("ok")!.style.display = "block";
  });
  document.getElementById("host")!.append(form);
}

describe("outline extraction", () => {
  beforeEach(() => setBody(""));

  it("interleaves text and controls in document order with headings, lists, and tables", () => {
    setBody(`
      <h1>Agent Fixture</h1>
      <p>Orchid launch moved to Friday.</p>
      <ul><li>First</li><li>Second</li></ul>
      <table><tr><th>Rank</th><th>Title</th></tr><tr><td>1</td><td><a href="/m/1">Bad Boys</a></td></tr></table>
      <button>Submit</button>`);
    const text = outline();
    expect(text).toContain("# Agent Fixture\nOrchid launch moved to Friday.");
    expect(text).toContain("- First\n- Second");
    expect(text).toContain("| Rank | Title\n| 1 | [e1 link \"Bad Boys\" → /m/1]");
    expect(text).toContain('[e2 button "Submit"]');
  });

  it("omits hidden content, templates, and aria-hidden subtrees", () => {
    setBody('<p>Visible ranking</p><div style="display:none">Hidden inventory</div><div hidden>Secret template</div><div aria-hidden="true">Decor</div><template><p>Tpl</p></template>');
    const text = outline();
    expect(text).toContain("Visible ranking");
    for (const hidden of ["Hidden inventory", "Secret template", "Decor", "Tpl"]) expect(text).not.toContain(hidden);
  });

  it("names a select from its label, not its option text, and lists options with values", () => {
    setBody('<label for="sort">Sort by</label><select id="sort"><option value="oldest">Oldest</option><option value="questionsperday">Questions Per Day</option></select>');
    expect(outline()).toContain('[e1 combobox "Sort by" selected="Oldest" options: Oldest (oldest) | Questions Per Day (questionsperday)]');
  });

  it("does not name container roles from their content or list role=none elements", () => {
    setBody('<div role="menubar"><span role="none"><a href="/movies" role="menuitem">Movies</a></span></div>');
    expect(outline()).toBe('[e1 menuitem "Movies" → /movies]');
  });

  it("follows accessible-name precedence", () => {
    setBody(`
      <span id="lbl">Labelled By</span><button aria-labelledby="lbl" aria-label="Aria">Visible</button>
      <label for="b">Label Text</label><input id="b" aria-label="Aria Only">
      <label for="c">Label C</label><input id="c">
      <input placeholder="Search movies">`);
    const text = outline();
    expect(text).toContain('[e1 button "Labelled By"]');
    expect(text).toContain('[e2 textbox "Aria Only"]');
    expect(text).toContain('[e3 textbox "Label C"]');
    expect(text).toContain('[e4 textbox "Search movies"]');
  });

  it("never exposes password values or file contents", () => {
    setBody('<label>Password <input type="password" value="secret123"></label><label>Email <input type="email" value="sam@example.com"></label>');
    const text = outline();
    expect(text).not.toContain("secret123");
    expect(text).toContain('type=password value="••••"');
    expect(text).toContain('value="sam@example.com"');
  });

  it("walks shadow roots and slots, naming unlabelled slotted fields from adjacent label text", () => {
    mountShadowForm();
    const text = outline();
    expect(text).toContain('Email Address\n[e1 textbox "Email Address" type=email]');
    expect(text).toContain('Date\n[e2 textbox "Date" type=date]');
    expect(text).toContain('[e3 button "Submit Form"]');
    expect(text).not.toContain("dumbledore");
  });

  it("descends into same-origin frames and lists cross-origin frames by URL", async () => {
    setBody('<h2>Level 1</h2><iframe title="Level 2" srcdoc="<label for=n>Name</label><input id=n><button>Send</button>"></iframe>');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const text = outline();
    expect(text).toContain('[frame "Level 2" (inline)]');
    expect(text).toContain('[e1 textbox "Name"]');
    expect(text).toContain('[e2 button "Send"]');
    expect(text).toContain("[/frame]");

    const crossOrigin = document.createElement("iframe");
    crossOrigin.title = "Ad-free widget";
    crossOrigin.setAttribute("src", "about:blank#remote");
    Object.defineProperty(crossOrigin, "contentDocument", { get: () => null });
    document.body.append(crossOrigin);
    expect(outline()).toContain('[frame "Ad-free widget" cross-origin → about:blank#remote]');
  });

  it("exposes hidden radios through their visible labels and contenteditable editors as textboxes", () => {
    setBody(`
      <style>.rating input { display: none; }</style>
      <div class="rating"><input type="radio" id="c3" name="contact" value="phone"><label for="c3" title="Phone"></label></div>
      <div class="ql-editor" contenteditable="true" data-placeholder="Enter your email address"><p>draft</p></div>
      <input type="radio" id="orphan" style="display:none">`);
    const text = outline();
    expect(text).toContain('[e1 radio "Phone" via-label]');
    expect(text).toContain('[e2 textbox "Enter your email address" editable value="draft"]');
    expect(text).not.toContain("e3");
  });

  it("surfaces painted numeric values from data attributes", () => {
    setBody('<div class="user_score_chart" data-percent="76.0"><span class="icon"></span></div><span>User Score</span>');
    expect(outline()).toContain("[percent: 76.0]");
  });

  it("drops an unnamed image link duplicating the adjacent named link", () => {
    setBody('<a href="https://stackoverflow.com/"><img src="x.png"></a><a href="https://stackoverflow.com/">Stack Overflow</a>');
    expect(outline()).toBe('[e2 link "Stack Overflow" → https://stackoverflow.com/]');
  });

  it("keeps refs stable for the same element across outlines", () => {
    setBody('<button>One</button>');
    const registry = createElementRefRegistry("doc");
    outline(registry);
    document.body.insertAdjacentHTML("afterbegin", "<button>Zero</button>");
    const text = outline(registry);
    expect(text).toContain('[e2 button "Zero"]');
    expect(text).toContain('[e1 button "One"]');
  });
});

describe("snapshot paging and find", () => {
  beforeEach(() => setBody(""));

  it("pages the outline on line boundaries and reports totals", () => {
    setBody(Array.from({ length: 200 }, (_, i) => `<p>Paragraph number ${i} with some filler text.</p>`).join(""));
    const registry = createElementRefRegistry("doc");
    const first = extractSnapshot(document, 1, registry, { offset: 0, maxChars: 1000 });
    expect(first.offset).toBe(0);
    expect(first.end).toBeLessThan(first.totalChars);
    expect(first.text.endsWith("text.")).toBe(true);
    const second = extractSnapshot(document, 1, registry, { offset: first.end, maxChars: 1000 });
    expect(second.text.startsWith("Paragraph number")).toBe(true);
    expect(first.text + second.text).not.toContain("Paragraph number 0 with some filler text.Paragraph");
    expect(second.documentId).toBe("doc");
  });

  it("finds matching outline lines with refs and offsets", () => {
    setBody('<h2>Ratings</h2><p>User Score 76%</p><p>Other</p><label for="q">Search</label><input id="q">');
    const result = findInPage(document, createElementRefRegistry("doc"), "user score");
    expect(result.count).toBe(1);
    expect(result.matches[0]!.text).toContain("## Ratings\nUser Score 76%");
    expect(findInPage(document, createElementRefRegistry("doc"), "search").matches[0]!.text).toContain('[e1 textbox "Search"]');
  });
});

describe("search result extraction", () => {
  it("unwraps redirect links into organic results with snippets and skips engine links", () => {
    setBody(`
      <div class="result"><h2><a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.boxofficemojo.com%2Fyear%2Fworld%2F2020%2F&rut=x">2020 Worldwide Box Office</a></h2>
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.boxofficemojo.com%2Fyear%2Fworld%2F2020%2F">The top grossing movies worldwide in 2020, ranked by total gross.</a></div>
      <div class="result"><h2><a href="https://duckduckgo.com/y.js?ad_domain=ads.example">Sponsored</a></h2></div>
      <a href="https://duckduckgo.com/settings">Settings</a>`);
    expect(extractSearchResults(document)).toEqual([{
      title: "2020 Worldwide Box Office",
      url: "https://www.boxofficemojo.com/year/world/2020/",
      snippet: expect.stringContaining("ranked by total gross"),
    }]);
  });
});

describe("action targeting", () => {
  beforeEach(() => setBody(""));

  it("rejects a ref from another document as stale", async () => {
    setBody("<button>Click me</button>");
    const registry = createElementRefRegistry("current");
    outline(registry);
    const result = await act(registry, { kind: "click", target: { kind: "ref", ref: "e1", documentId: "previous" } });
    expect(result).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
  });

  it("distinguishes removed, hidden, and disabled targets", async () => {
    setBody('<button id="a">A</button><button id="b">B</button><button id="c">C</button>');
    const registry = createElementRefRegistry("doc");
    outline(registry);
    document.getElementById("a")!.remove();
    document.getElementById("b")!.style.display = "none";
    (document.getElementById("c") as HTMLButtonElement).disabled = true;
    const ref = (value: string): DomAction => ({ kind: "click", target: { kind: "ref", ref: value, documentId: "doc" } });
    expect(await act(registry, ref("e1"))).toMatchObject({ ok: false, code: "TARGET_MISSING" });
    expect(await act(registry, ref("e2"))).toMatchObject({ ok: false, code: "NOT_INTERACTABLE" });
    expect(await act(registry, ref("e3"))).toMatchObject({ ok: false, code: "NOT_INTERACTABLE", summary: expect.stringContaining("disabled") });
  });

  it("lists candidate refs when a role locator is ambiguous or missing", async () => {
    setBody('<input aria-label="From date"><input aria-label="To date"><button>Search</button>');
    const registry = createElementRefRegistry("doc");
    const ambiguous = await act(registry, { kind: "fill", target: role("textbox", "date"), text: "2022-01-01" });
    expect(ambiguous.summary).toContain('matched 2 elements: [e1 textbox "From date"]; [e2 textbox "To date"]');
    const missing = await act(registry, { kind: "fill", target: role("textbox", "from", true), text: "x" });
    expect(missing).toMatchObject({ ok: false, code: "TARGET_MISSING" });
    expect(missing.summary).toContain('[e1 textbox "From date"]');
  });

  it("prefers the sole whole-name match for an ambiguous substring locator", async () => {
    setBody('<button>Submit</button><button>Submit Form</button>');
    const result = await act(createElementRefRegistry("doc"), { kind: "click", target: role("button", "submit") });
    expect(result.summary).toContain('Clicked [e1 button "Submit"]');
  });

  it("matches any interactive element by name for getByText targets", async () => {
    setBody('<a href="#x">Questions Per Day</a>');
    expect(await act(createElementRefRegistry("doc"), { kind: "click", target: role("*", "questions per day") })).toMatchObject({ ok: true });
  });
});

describe("actions and outcome feedback", () => {
  beforeEach(() => setBody(""));

  it("fills a slotted shadow-DOM field and reports the success message that appears after submit", async () => {
    mountShadowForm();
    const registry = createElementRefRegistry("doc");
    expect(await act(registry, { kind: "fill", target: role("textbox", "Email Address", true), text: "alex@example.com" })).toMatchObject({ ok: true });
    expect(await act(registry, { kind: "fill", target: role("textbox", "Date", true), text: "2024-01-15" })).toMatchObject({ ok: true });
    const submitted = await act(registry, { kind: "click", target: role("button", "Submit Form") });
    expect(submitted.ok).toBe(true);
    expect(submitted.summary).toContain("+ Success! The secret is: dumbledore");
  });

  it("reports a value the input rejected, with the expected format", async () => {
    setBody('<label for="d">Date</label><input id="d" type="date">');
    const result = await act(createElementRefRegistry("doc"), { kind: "fill", target: role("textbox", "Date"), text: "01/15/2024" });
    expect(result).toMatchObject({ ok: false, code: "NOT_INTERACTABLE" });
    expect(result.summary).toContain("YYYY-MM-DD");
  });

  it("notes invalid fields after fill and native validation blocking a submit", async () => {
    setBody('<form><label for="e">Email</label><input id="e" type="email" required><button>Send</button></form>');
    const registry = createElementRefRegistry("doc");
    const filled = await act(registry, { kind: "fill", target: role("textbox", "Email"), text: "not-an-email" });
    expect(filled.summary).toContain("Field reports invalid");
    const clicked = await act(registry, { kind: "click", target: role("button", "Send") });
    expect(clicked.summary).toContain('Native validation will block this submission: [e1 textbox "Email"');
  });

  it("fills a contenteditable editor", async () => {
    setBody('<div contenteditable="true" aria-label="Message"><p></p></div>');
    let inputs = 0;
    document.querySelector("[contenteditable]")!.addEventListener("input", () => inputs++);
    const result = await act(createElementRefRegistry("doc"), { kind: "fill", target: role("textbox", "Message"), text: "hello@example.com" });
    expect(result.ok).toBe(true);
    expect(document.querySelector("[contenteditable]")!.textContent).toBe("hello@example.com");
    expect(inputs).toBeGreaterThan(0);
  });

  it("selects by visible label or by value", async () => {
    setBody('<label for="c">Country</label><select id="c"><option value="">Pick</option><option value="مصر">مصر</option><option value="us">United States</option></select>');
    const registry = createElementRefRegistry("doc");
    expect(await act(registry, { kind: "select", target: role("combobox", "Country"), values: ["united states"] })).toMatchObject({ ok: true });
    expect((document.getElementById("c") as HTMLSelectElement).value).toBe("us");
    expect(await act(registry, { kind: "select", target: role("combobox", "Country"), values: ["مصر"] })).toMatchObject({ ok: true });
    expect((document.getElementById("c") as HTMLSelectElement).value).toBe("مصر");
    expect(await act(registry, { kind: "select", target: role("combobox", "Country"), values: ["Mars"] })).toMatchObject({ ok: false, code: "TARGET_MISSING" });
  });

  it("checks a hidden radio by clicking its visible label", async () => {
    setBody('<style>input{display:none}</style><input type="radio" id="r" name="m" value="email"><label for="r" title="Email"></label>');
    const result = await act(createElementRefRegistry("doc"), { kind: "check", target: role("radio", "Email"), checked: true });
    expect(result.ok).toBe(true);
    expect((document.getElementById("r") as HTMLInputElement).checked).toBe(true);
  });

  it("attaches workspace text files to a file input", async () => {
    setBody('<label for="f">Upload Document</label><input type="file" id="f">');
    let changed = false;
    document.getElementById("f")!.addEventListener("change", () => { changed = true; });
    const result = await act(createElementRefRegistry("doc"), { kind: "upload", target: role("file", "Upload"), files: [{ name: "doc.txt", mimeType: "text/plain", text: "hello" }] });
    expect(result.ok).toBe(true);
    const input = document.getElementById("f") as HTMLInputElement;
    expect(input.files?.[0]?.name).toBe("doc.txt");
    expect(changed).toBe(true);
  });

  it("attaches a binary workspace file's decoded bytes", async () => {
    setBody('<input type="file" aria-label="Photo" accept="image/png">');
    const result = await act(createElementRefRegistry("doc"), { kind: "upload", target: role("file", "Photo"), files: [{ name: "shot.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }] });
    expect(result.ok, result.summary).toBe(true);
    const file = (document.querySelector("input") as HTMLInputElement).files![0]!;
    expect(file).toMatchObject({ name: "shot.png", type: "image/png", size: 8 });
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("submits the form on Enter from a text field", async () => {
    setBody('<form><input aria-label="Query"><button>Go</button></form>');
    let submitted = false;
    document.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); submitted = true; });
    expect(await act(createElementRefRegistry("doc"), { kind: "press", target: role("textbox", "Query"), key: "Enter" })).toMatchObject({ ok: true });
    expect(submitted).toBe(true);
  });

  it("refuses new-tab links with a usable navigation hint, and password fills", async () => {
    setBody('<a href="https://example.com/x" target="_blank">Open</a><input type="password" aria-label="Pass">');
    const registry = createElementRefRegistry("doc");
    const link = await act(registry, { kind: "click", target: role("link", "Open") });
    expect(link).toMatchObject({ ok: false, code: "NOT_INTERACTABLE" });
    expect(link.summary).toContain('page.navigate("https://example.com/x")');
    expect(await act(registry, { kind: "fill", target: role("textbox", "Pass"), text: "x" })).toMatchObject({ ok: false, code: "NOT_INTERACTABLE" });
  });
});

describe("change descriptions", () => {
  it("reports added and removed lines and an unchanged outline", () => {
    expect(describeChanges(["a", "b"], ["a", "b"])).toBe("Page outline unchanged.");
    expect(describeChanges(["a", "b"], ["a", "c", "c"])).toBe("Page changes (+2 −1 lines):\n+ c\n+ c\n- b");
  });
});

describe("measureForCapture", () => {
  it("reports the viewport, the page size, and a target's box in document coordinates", () => {
    setBody('<button id="go">Go</button><button disabled>Off</button>');
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    const button = document.querySelector("#go")!;
    button.getBoundingClientRect = () => ({ left: 20, top: 30, width: 60, height: 24, right: 80, bottom: 54, x: 20, y: 30, toJSON: () => ({}) });
    window.scrollTo(0, 0);
    const measured = measureForCapture(document, registry, role("button", "Go"));
    expect(measured).toMatchObject({ ok: true, geometry: { documentId: "doc", element: { x: 20, y: 30, width: 60, height: 24 } } });
    if (!measured.ok) return;
    expect(measured.geometry.viewport.width).toBeGreaterThan(0);
    expect(measured.geometry.page.height).toBeGreaterThanOrEqual(measured.geometry.viewport.height);
    expect(measureForCapture(document, registry, null)).toMatchObject({ ok: true, geometry: { element: null } });
  });

  it("rejects a ref from an earlier document and an element without a box; a disabled control is fine to look at", () => {
    setBody('<button>Go</button><button disabled id="off">Off</button>');
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    expect(measureForCapture(document, registry, { kind: "ref", ref: "e1", documentId: "old" })).toMatchObject({ ok: false, result: { code: "STALE_SNAPSHOT" } });
    expect(measureForCapture(document, registry, role("button", "Go"))).toMatchObject({ ok: false, result: { code: "NOT_INTERACTABLE" } });
    const off = document.querySelector("#off")!;
    off.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    expect(measureForCapture(document, registry, role("button", "Off")).ok).toBe(true);
  });
});

