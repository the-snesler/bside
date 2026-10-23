// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { InstructionsPage } from "@/entrypoints/options/pages/Instructions";
import { SiteNotesPage } from "@/entrypoints/options/pages/SiteNotes";
import type { SiteNote } from "@/lib/domain/instructions";
import type { InstructionsRequest, SiteNotesRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });

/** Lets pending background replies land. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** A button by accessible name: its aria-label, else its text. */
const button = (name: string) => [...root.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name)!;
const field = (label: string) => {
  const element = [...root.querySelectorAll("label")].find((candidate) => candidate.textContent?.startsWith(label))!;
  return document.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
};
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

describe("Instructions settings page", () => {
  async function mount(saved = "") {
    let text = saved;
    const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
      const request = message as InstructionsRequest;
      if (request.type === "instructions.save") text = request.text.trim() ? request.text : "";
      return { v: 1, id: request.id, ok: true, text };
    });
    root = document.createElement("div"); document.body.append(root);
    await act(async () => render(h(InstructionsPage, {}), root));
    await settle();
    return send;
  }

  it("loads, counts characters, saves, and clears through background requests", async () => {
    const send = await mount("Answer in French.");
    const textarea = field("About you") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Answer in French.");
    expect(root.textContent).toContain("17 / 2,000");
    expect(button("Save").disabled).toBe(true);
    await type(textarea, "Keep it short.");
    expect(root.textContent).toContain("14 / 2,000");
    await click("Save");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "instructions.save", text: "Keep it short." }));
    expect(root.textContent).toContain("Instructions saved.");
    await click("Clear");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "instructions.save", text: "" }));
    expect(textarea.value).toBe("");
    expect(root.textContent).toContain("Instructions cleared.");
    expect(button("Clear")).toBeUndefined();
  });

  it("blocks saving over 2,000 characters", async () => {
    const send = await mount();
    await type(field("About you"), "a".repeat(2_001));
    expect(root.querySelector(".settings-count--over")?.textContent).toBe("2,001 / 2,000");
    expect(button("Save").disabled).toBe(true);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "instructions.save" }));
  });
});

describe("Site notes settings page", () => {
  const github: SiteNote = { origin: "https://github.com", includeSubdomains: true, text: "Prefer CLI-style search." };
  const docs: SiteNote = { origin: "https://docs.example", includeSubdomains: false, text: "<img src=x onerror=alert(1)>" };

  async function mount(initial: SiteNote[] = []) {
    let notes = initial;
    const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
      const request = message as SiteNotesRequest;
      if (request.type === "siteNotes.save") {
        const index = notes.findIndex((note) => note.origin === request.note.origin);
        notes = index >= 0 ? notes.map((note, i) => i === index ? request.note : note) : [...notes, request.note];
      }
      if (request.type === "siteNotes.delete") notes = notes.filter((note) => note.origin !== request.origin);
      return { v: 1, id: request.id, ok: true, notes };
    });
    root = document.createElement("div"); document.body.append(root);
    await act(async () => render(h(SiteNotesPage, {}), root));
    await settle();
    return send;
  }

  it("adds a note for a typed domain, refusing duplicates and non-http sites", async () => {
    const send = await mount([github]);
    await type(field("Site"), "ftp://example.com");
    expect(root.textContent).toContain("Enter an http(s) site");
    await type(field("Note"), "Use the v2 docs.");
    expect(button("Add note").disabled).toBe(true);
    await type(field("Site"), "github.com/the-snesler");
    expect(root.textContent).toContain("https://github.com already has a note.");
    expect(button("Add note").disabled).toBe(true);
    await type(field("Site"), "docs.example/guide");
    expect(root.textContent).toContain("Applies to https://docs.example.");
    await click("Add note");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "siteNotes.save", note: { origin: "https://docs.example", includeSubdomains: false, text: "Use the v2 docs." } }));
    expect(root.textContent).toContain("Note for https://docs.example added.");
    expect((field("Site") as HTMLInputElement).value).toBe("");
    expect(root.textContent).toContain("2 notes of 200.");
  });

  it("searches, edits inline, and deletes after confirming; note text renders as text", async () => {
    const send = await mount([github, docs]);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    await type(root.querySelector<HTMLInputElement>("input[type=search]")!, "cli");
    expect(root.textContent).not.toContain("https://docs.example");
    await type(root.querySelector<HTMLInputElement>("input[type=search]")!, "");

    await click("Edit the note for https://github.com");
    const editor = root.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note for https://github.com']")!;
    expect(editor.value).toBe(github.text);
    await type(editor, "Use gh-style queries.");
    await act(async () => { root.querySelector<HTMLInputElement>(".settings-form--inline input[role=switch]")!.click(); });
    await click("Save");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "siteNotes.save", note: { origin: github.origin, includeSubdomains: false, text: "Use gh-style queries." } }));
    expect(root.textContent).toContain("Use gh-style queries.");

    await click("Delete the note for https://docs.example");
    expect(root.textContent).toContain("Delete the note for https://docs.example?");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "siteNotes.delete" }));
    await click("Confirm delete");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "siteNotes.delete", origin: docs.origin }));
    expect(root.textContent).not.toContain("<img");
  });

  it("shows an empty state that points at the sidebar affordance", async () => {
    await mount();
    expect(root.textContent).toContain("No site notes yet.");
    expect(root.textContent).toContain("Remember something about this site");
    expect(root.querySelector("input[type=search]")).toBeNull();
  });
});
