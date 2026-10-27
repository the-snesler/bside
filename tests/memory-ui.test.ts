// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { MemoryPage } from "@/entrypoints/options/pages/Memory";
import { itemFromHash, routeFromHash, searchPages } from "@/entrypoints/options/navigation";
import { SETTINGS_PAGES } from "@/entrypoints/options/pages";
import { handleMemoryRequest, listMemories, writeMemory } from "@/lib/background/memory";
import { isMemoryRequest, type MemoryRequest } from "@/lib/protocol";
import { getMemorySettings } from "@/lib/storage";

let root: HTMLDivElement;
beforeEach(() => { fakeBrowser.reset(); history.replaceState(null, "", "#/memory"); });
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (name: string) => [...root.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name)!;
const row = (name: string) => document.getElementById(`memory-row-${name}`)!;
async function click(name: string) {
  await act(async () => { button(name).click(); });
  await settle();
}
async function type(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Seeds two memories and mounts the page against the real background handler. */
async function mount() {
  await writeMemory({ name: "coffee", description: "Usual coffee order", body: "Oat flat white, no sugar." }, { sessionId: "session-1234567890", runId: "run-abcdefghij", tainted: false }, 1_000);
  await writeMemory({ name: "seat", description: "Seat on flights", body: "Window." }, { sessionId: "session-2", runId: "run-2", tainted: true }, 2_000);
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => handleMemoryRequest(message as MemoryRequest));
  root = document.createElement("div");
  document.body.append(root);
  await act(async () => render(h(MemoryPage, {}), root));
  await settle();
  return send;
}

describe("Memory settings page", () => {
  it("is a registry page in the Agent group, found by search, deep-linkable to one entry", () => {
    const page = SETTINGS_PAGES.find((candidate) => candidate.id === "memory")!;
    expect(page).toMatchObject({ label: "Memory", group: "Agent" });
    expect(searchPages(SETTINGS_PAGES, "forget").map((result) => result.page.id)).toContain("memory");
    expect(routeFromHash("#/memory/coffee")).toBe("memory");
    expect(itemFromHash("#/memory/coffee")).toBe("coffee");
    expect(itemFromHash("#/memory")).toBeNull();
    expect(routeFromHash("#/memory/../x")).toBeNull();
  });

  it("lists memories newest first with provenance and a badge on those saved after web content, and searches them", async () => {
    await mount();
    const names = [...root.querySelectorAll(".settings-memory .settings-skill__name")].map((element) => element.textContent);
    expect(names).toEqual(["seat", "coffee"]);
    expect(row("seat").querySelector(".settings-badge--warning")?.textContent).toBe("After web content");
    expect(row("coffee").querySelector(".settings-badge--warning")).toBeNull();
    expect(row("coffee").querySelector(".settings-memory__provenance")?.textContent).toMatch(/^Saved by bside · /);
    expect(root.textContent).toContain("2 memories of 200");

    const search = root.querySelector<HTMLInputElement>('input[aria-label="Search memories"]')!;
    await type(search, "oat");
    expect([...root.querySelectorAll(".settings-memory")].map((element) => element.id)).toEqual(["memory-row-coffee"]);
    await type(search, "zebra");
    expect(root.textContent).toContain("No matching memories.");
  });

  it("opens the entry a deep link names, with its body and where it came from", async () => {
    history.replaceState(null, "", "#/memory/coffee");
    await mount();
    expect(row("coffee").querySelector(".settings-memory__body")?.textContent).toBe("Oat flat white, no sugar.");
    expect(row("coffee").textContent).toContain("chat session- · run run-abcd");
    expect(row("coffee").textContent).toContain("None read before saving.");
    expect(row("seat").querySelector(".settings-memory__body")).toBeNull();
    await click("View seat");
    expect(location.hash).toBe("#/memory/seat");
    expect(row("seat").textContent).toContain("a page may have influenced this");
  });

  it("edits an entry as the user's, refusing secret-looking text, and deletes after a confirmation", async () => {
    const send = await mount();
    await click("Edit seat");
    const body = row("seat").querySelector("textarea")!;
    await type(body, "Card 4111 1111 1111 1111");
    expect(row("seat").textContent).toContain("looks like it contains a payment card number");
    expect(button("Save").disabled).toBe(true);
    await type(body, "Aisle, near the front.");
    await click("Save");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "memory.save", entry: { name: "seat", description: "Seat on flights", body: "Aisle, near the front." } }));
    expect(root.textContent).toContain("Saved “seat”.");
    const seat = (await listMemories()).find((entry) => entry.name === "seat")!;
    expect(seat).toMatchObject({ body: "Aisle, near the front.", createdAt: 2_000, provenance: { by: "user" } });
    expect(row("seat").querySelector(".settings-badge--warning")).toBeNull();
    expect(row("seat").querySelector(".settings-memory__provenance")?.textContent).toMatch(/^Edited by you · /);

    await click("Delete coffee");
    expect(root.querySelector('[aria-label="Confirm deleting coffee"]')).not.toBeNull();
    await click("Cancel");
    expect((await listMemories())).toHaveLength(2);
    await click("Delete coffee");
    await click("Confirm delete");
    expect((await listMemories()).map((entry) => entry.name)).toEqual(["seat"]);
    expect(root.textContent).toContain("Deleted “coffee”.");
  });

  it("saves the write policy, exports JSON through a blob link, and forgets everything after a confirmation", async () => {
    await mount();
    const select = root.querySelector<HTMLSelectElement>("#memory-policy")!;
    expect(select.value).toBe("auto");
    await act(async () => { select.value = "ask"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(await getMemorySettings()).toEqual({ version: 1, writes: "ask" });
    expect(root.textContent).toContain("asks you to approve each save");

    let exported: Blob | null = null;
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => { exported = blob; return "blob:memory"; }, revokeObjectURL: () => {} }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toMatch(/^bside-memory-\d{4}-\d{2}-\d{2}\.json$/);
      expect(this.href).toBe("blob:memory");
    });
    await click("Export JSON");
    expect(clicked).toHaveBeenCalledOnce();
    const json = JSON.parse(await exported!.text());
    expect(json).toMatchObject({ version: 1, memories: [{ name: "seat", provenance: { tainted: true } }, { name: "coffee" }] });

    await click("Forget everything");
    expect(root.querySelector('[aria-label="Confirm forgetting every memory"]')?.textContent).toContain("Delete 2 memories");
    await act(async () => { [...root.querySelectorAll<HTMLButtonElement>('[aria-label="Confirm forgetting every memory"] button')].at(-1)!.click(); });
    await settle();
    expect(await listMemories()).toEqual([]);
    expect(root.textContent).toContain("No memories yet.");
  });

  it("accepts only well-formed requests", () => {
    expect(isMemoryRequest({ v: 1, id: "a", type: "memory.save", entry: { name: "x", description: "X", body: "" } })).toBe(true);
    expect(isMemoryRequest({ v: 1, id: "a", type: "memory.save", entry: { name: "X", description: "X", body: "" } })).toBe(false);
    expect(isMemoryRequest({ v: 1, id: "a", type: "memory.delete", name: "../x" })).toBe(false);
    expect(isMemoryRequest({ v: 1, id: "a", type: "memory.settings.save", settings: { version: 1, writes: "always" } })).toBe(false);
    expect(isMemoryRequest({ v: 1, id: "a", type: "memory.settings.save", settings: { version: 1, writes: "off" } })).toBe(true);
    expect(isMemoryRequest({ v: 1, id: "a", type: "memory.undo", changeIds: ["x"] })).toBe(false);
  });
});
