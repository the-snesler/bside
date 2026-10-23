// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { SkillsEditor } from "@/lib/ui/SkillsEditor";
import type { Skill } from "@/lib/domain/skills";
import type { SkillsRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function mount(skills: Skill[] = [], builtinNames: string[] = []) {
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
    const request = message as SkillsRequest;
    if (request.type === "skills.save") skills = [...skills.filter((skill) => skill.name !== request.skill.name), request.skill];
    if (request.type === "skills.delete") skills = skills.filter((skill) => skill.name !== request.name);
    return { v: 1, id: request.id, ok: true, skills, builtinNames };
  });
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(SkillsEditor, {}), root));
  await settle();
  return send;
}

/** Lets pending background replies land. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** A button by accessible name: its aria-label, else its text. */
const button = (name: string) => [...root.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name)!;
/** The control a visible label names. */
const field = (label: string) => {
  const element = [...root.querySelectorAll("label")].find((candidate) => candidate.textContent?.startsWith(label))!;
  return document.getElementById(element.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
};
async function click(name: string) {
  await act(async () => { button(name).click(); });
  await settle();
}
async function input(label: string, value: string) {
  await act(async () => {
    const control = field(label);
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("skills options editor", () => {
  it("creates and edits bounded plain-text skills through background messages", async () => {
    const send = await mount();
    expect(root.textContent).toContain("No skills yet.");
    expect(button("Create skill").disabled).toBe(true);
    await input("Name", "research");
    await input("Description", "Research a topic");
    await input("Instructions", "<img src=x onerror=alert(1)>");
    expect((field("Instructions") as HTMLTextAreaElement).maxLength).toBe(16_000);
    await click("Create skill");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "skills.save", skill: { name: "research", description: "Research a topic", body: "<img src=x onerror=alert(1)>" } }));
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("Skill saved.");
    await click("Edit /research");
    expect(root.textContent).toContain("Edit /research");
    expect(field("Name").disabled).toBe(true);
    await input("Instructions", "Updated instructions");
    await click("Save changes");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "skills.save", skill: expect.objectContaining({ body: "Updated instructions" }) }));
    expect(root.textContent).toContain("not encrypted or synced");
  });

  it("requires confirmation for deletion and keeps packaged skills read-only", async () => {
    const send = await mount([{ name: "user-skill", description: "User", body: "Body" }, { name: "packaged", description: "Packaged", body: "Body" }], ["packaged"]);
    await click("Delete /user-skill");
    expect(root.textContent).toContain("Delete /user-skill?");
    expect(document.activeElement).toBe(button("Cancel"));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "skills.delete" }));
    await click("Confirm delete");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "skills.delete", name: "user-skill" }));
    expect(root.textContent).toContain("Packaged");
    await click("View /packaged");
    expect(root.textContent).toContain("View /packaged");
    expect(field("Instructions").disabled).toBe(true);
    expect(button("Save changes").disabled).toBe(true);
    expect(button("Delete /packaged")).toBeUndefined();
  });

  it("preserves the draft when persistence fails", async () => {
    const send = await mount();
    await input("Name", "research");
    await input("Description", "Research");
    await input("Instructions", "Body");
    send.mockRejectedValueOnce(new Error("private detail"));
    await click("Create skill");
    expect(field("Instructions").value).toBe("Body");
    expect(root.querySelector('[role="alert"]')!.textContent).toContain("could not complete");
    expect(root.textContent).not.toContain("private detail");
  });
});
