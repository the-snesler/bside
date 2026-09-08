// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { createElementRefRegistry, executeDomCall, extractSnapshot } from "@/lib/tools/page-executor";
import type { DomToolCall } from "@/lib/protocol";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("extractSnapshot: readable extraction", () => {
  beforeEach(() => setBody(""));

  it("captures the page's readable text content", () => {
    setBody(`
      <article>
        <h1>Agent Fixture</h1>
        <p>Orchid launch moved to Friday.</p>
      </article>
    `);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "readable");
    expect(snapshot.readableText).toContain("Orchid launch moved to Friday.");
  });

  it("includes controls in readable mode so navigation needs no second snapshot", () => {
    setBody(`<button>Submit</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "readable");
    expect(snapshot.nodes).toMatchObject([{ role: "button", name: "Submit" }]);
  });

  it("reads visible content and controls rather than hidden inventories or article-only text", () => {
    setBody('<nav><a href="/sites">Sites</a></nav><main><label>Sort by <select><option>Activity</option></select></label><p>Visible ranking</p></main><div style="display:none">Hidden inventory in launch order</div><div hidden>Secret template</div>');
    const snapshot = extractSnapshot(document, 1, createElementRefRegistry(), "readable");
    expect(snapshot.readableText).toContain("Sort by");
    expect(snapshot.readableText).toContain("Visible ranking");
    expect(snapshot.readableText).not.toContain("Hidden inventory");
    expect(snapshot.readableText).not.toContain("Secret template");
    expect(snapshot.nodes[0]?.href).toContain("/sites");
  });

  it("exposes option labels and machine values together", () => {
    setBody('<label for="priority">Priority</label><select id="priority"><option value="low">Low</option><option value="high">High</option></select>');
    const snapshot = extractSnapshot(document, 1, createElementRefRegistry(), "readable");
    expect(snapshot.nodes[0]?.options).toMatchObject([{ label: "Low", value: "low" }, { label: "High", value: "high" }]);
  });

  it("resolves exact locators beyond the display cap while detecting a late duplicate", () => {
    setBody('<a href="/sites">Sites</a>' + '<button>Other</button>'.repeat(350));
    const registry = createElementRefRegistry();
    expect(extractSnapshot(document, 1, registry, "interactive").truncated.nodes).toBe(true);
    const resolved = extractSnapshot(document, 1, registry, "interactive", undefined, { role: "link", name: "Sites" });
    expect(resolved.nodes).toHaveLength(1);
    expect(resolved.truncated.nodes).toBe(false);
    document.body.insertAdjacentHTML("beforeend", '<a href="/other">Sites</a>');
    expect(extractSnapshot(document, 1, registry, "interactive", undefined, { role: "link", name: "Sites" }).nodes).toHaveLength(2);
  });
});

describe("extractSnapshot: accessible-name precedence", () => {
  beforeEach(() => setBody(""));

  it("prefers aria-labelledby over aria-label and visible text", () => {
    setBody(`
      <span id="lbl">Labelled By Text</span>
      <button id="a" aria-labelledby="lbl" aria-label="Aria Label">Visible Text</button>
    `);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.name).toBe("Labelled By Text");
  });

  it("prefers aria-label over an associated label and visible text", () => {
    setBody(`<label for="b">Label Text</label><input id="b" aria-label="Aria Label Only" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.name).toBe("Aria Label Only");
  });

  it("prefers an associated label over alt and visible text", () => {
    setBody(`<label for="c">Label Text</label><input id="c" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.name).toBe("Label Text");
  });

  it("prefers alt over visible text", () => {
    setBody(`<button id="d" alt="Alt Text" role="img">Visible Text</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.name).toBe("Alt Text");
  });

  it("falls back to visible text when nothing else is present", () => {
    setBody(`<button id="e">Plain Text</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.name).toBe("Plain Text");
  });
});

describe("extractSnapshot: truncation markers", () => {
  beforeEach(() => setBody(""));

  it("truncates readable text at the configured character limit", () => {
    const longText = "Lorem ipsum dolor sit amet consectetur. ".repeat(2000);
    setBody(`<article><p>${longText}</p></article>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "readable", { maxText: 40_000, maxNodes: 300 });
    expect(snapshot.readableText.length).toBe(40_000);
    expect(snapshot.truncated.readableText).toBe(true);
  });

  it("does not mark short readable text as truncated", () => {
    setBody(`<article><p>Orchid launch moved to Friday.</p></article>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "readable", { maxText: 40_000, maxNodes: 300 });
    expect(snapshot.truncated.readableText).toBe(false);
  });

  it("truncates interactive nodes at the configured count limit", () => {
    const buttons = Array.from({ length: 310 }, (_, i) => `<button>Button ${i}</button>`).join("");
    setBody(buttons);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive", { maxText: 40_000, maxNodes: 300 });
    expect(snapshot.nodes.length).toBe(300);
    expect(snapshot.truncated.nodes).toBe(true);
  });

  it("does not mark nodes as truncated when under the limit", () => {
    setBody(`<button>One</button><button>Two</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive", { maxText: 40_000, maxNodes: 300 });
    expect(snapshot.truncated.nodes).toBe(false);
  });
});

describe("extractSnapshot: password/file value omission", () => {
  beforeEach(() => setBody(""));

  it("omits password input values", () => {
    setBody(`<input id="pw" type="password" value="secret123" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.inputType).toBe("password");
    expect(snapshot.nodes[0]?.value).toBeUndefined();
  });

  it("omits file input values", () => {
    setBody(`<input id="file" type="file" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.inputType).toBe("file");
    expect(snapshot.nodes[0]?.value).toBeUndefined();
  });

  it("still exposes ordinary text input values", () => {
    setBody(`<input id="e" type="email" value="sam@example.com" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    expect(snapshot.nodes[0]?.value).toBe("sam@example.com");
  });
});

describe("executeDomCall: stale revision rejection", () => {
  beforeEach(() => setBody(""));

  it("rejects a call whose revision does not match the current registry", () => {
    setBody(`<button id="a">Click me</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const call: DomToolCall = { id: "c1", name: "page_click", arguments: { ref, revision: "stale-revision" } };
    const result = executeDomCall(document, registry, call);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("STALE_SNAPSHOT");
  });
});

describe("executeDomCall: disconnected/hidden/disabled target rejection", () => {
  beforeEach(() => setBody(""));

  it("rejects a target removed from the document after the snapshot", () => {
    setBody(`<button id="a">Click me</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    document.getElementById("a")?.remove();
    const call: DomToolCall = { id: "c1", name: "page_click", arguments: { ref, revision: snapshot.revision } };
    const result = executeDomCall(document, registry, call);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TARGET_MISSING");
  });

  it("rejects a target hidden after the snapshot", () => {
    setBody(`<button id="a">Click me</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    document.getElementById("a")!.style.display = "none";
    const call: DomToolCall = { id: "c1", name: "page_click", arguments: { ref, revision: snapshot.revision } };
    const result = executeDomCall(document, registry, call);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_INTERACTABLE");
  });

  it("rejects a target disabled after the snapshot", () => {
    setBody(`<button id="a">Click me</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    (document.getElementById("a") as HTMLButtonElement).disabled = true;
    const call: DomToolCall = { id: "c1", name: "page_click", arguments: { ref, revision: snapshot.revision } };
    const result = executeDomCall(document, registry, call);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_INTERACTABLE");
  });
});

describe("executeDomCall: unknown operations", () => {
  beforeEach(() => setBody(""));

  it("rejects an unrecognized tool name", () => {
    setBody(`<button id="a">Click me</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const call = { id: "c1", name: "page_teleport", arguments: {} } as unknown as DomToolCall;
    const result = executeDomCall(document, registry, call);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_TOOL_ARGUMENTS");
    void snapshot;
  });

  it("rejects a call with malformed arguments", () => {
    setBody(`<button id="a">Click me</button>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const call: DomToolCall = { id: "c1", name: "page_click", arguments: { ref } };
    const result = executeDomCall(document, registry, call);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INVALID_TOOL_ARGUMENTS");
  });
});

describe("executeDomCall: allowed DOM effects", () => {
  beforeEach(() => setBody(""));

  it("clicks a button", () => {
    setBody(`<button id="a">Click me</button>`);
    let clicked = false;
    document.getElementById("a")!.addEventListener("click", () => {
      clicked = true;
    });
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const result = executeDomCall(document, registry, {
      id: "c1",
      name: "page_click",
      arguments: { ref, revision: snapshot.revision },
    });
    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it("fills a text input", () => {
    setBody(`<label for="email">Email</label><input id="email" type="email" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const result = executeDomCall(document, registry, {
      id: "c1",
      name: "page_fill",
      arguments: { ref, revision: snapshot.revision, text: "sam@example.com" },
    });
    expect(result.ok).toBe(true);
    expect((document.getElementById("email") as HTMLInputElement).value).toBe("sam@example.com");
  });

  it("rejects fill on a password input", () => {
    setBody(`<input id="pw" type="password" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const result = executeDomCall(document, registry, {
      id: "c1",
      name: "page_fill",
      arguments: { ref, revision: snapshot.revision, text: "hunter2" },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_INTERACTABLE");
  });

  it("selects an option", () => {
    setBody(`
      <select id="priority">
        <option value="low">Low</option>
        <option value="high">High</option>
      </select>
    `);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const result = executeDomCall(document, registry, {
      id: "c1",
      name: "page_select_option",
      arguments: { ref, revision: snapshot.revision, values: ["high"] },
    });
    expect(result.ok).toBe(true);
    expect((document.getElementById("priority") as HTMLSelectElement).value).toBe("high");
  });

  it("checks a checkbox", () => {
    setBody(`<input id="notify" type="checkbox" />`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const result = executeDomCall(document, registry, {
      id: "c1",
      name: "page_set_checked",
      arguments: { ref, revision: snapshot.revision, checked: true },
    });
    expect(result.ok).toBe(true);
    expect((document.getElementById("notify") as HTMLInputElement).checked).toBe(true);
  });

  it("refuses to click a link that opens a new tab", () => {
    setBody(`<a id="a" href="https://example.com" target="_blank">Open</a>`);
    const registry = createElementRefRegistry();
    const snapshot = extractSnapshot(document, 1, registry, "interactive");
    const ref = snapshot.nodes[0]!.ref;
    const result = executeDomCall(document, registry, {
      id: "c1",
      name: "page_click",
      arguments: { ref, revision: snapshot.revision },
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_INTERACTABLE");
  });
});
