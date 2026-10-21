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
  return send;
}

const button = (text: string) => [...root.querySelectorAll("button")].find((element) => element.textContent === text)!;
async function input(label: string, value: string) {
  await act(async () => {
    const field = [...root.querySelectorAll("label")].find((element) => element.textContent?.startsWith(label))!.querySelector("input, textarea") as HTMLInputElement;
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("skills options editor", () => {
  it("creates and edits bounded plain-text skills through background messages", async () => {
    const send = await mount();
    expect(button("Create skill").disabled).toBe(true);
    await input("Name", "research");
    await input("Description", "Research a topic");
    await input("Instructions", "<img src=x onerror=alert(1)>");
    expect(root.querySelector("textarea")!.maxLength).toBe(16_000);
    await act(async () => { button("Create skill").click(); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "skills.save", skill: { name: "research", description: "Research a topic", body: "<img src=x onerror=alert(1)>" } }));
    expect(root.querySelector("img")).toBeNull();
    await act(async () => { button("/research").click(); });
    expect(root.querySelector("input")!.disabled).toBe(true);
    await input("Instructions", "Updated instructions");
    await act(async () => { button("Save changes").click(); });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "skills.save", skill: expect.objectContaining({ body: "Updated instructions" }) }));
    expect(root.textContent).toContain("not encrypted or synced");
  });

  it("requires confirmation for deletion and keeps packaged skills read-only", async () => {
    const send = await mount([{ name: "user-skill", description: "User", body: "Body" }, { name: "packaged", description: "Packaged", body: "Body" }], ["packaged"]);
    await act(async () => { button("Delete").click(); });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "skills.delete" }));
    await act(async () => { button("Confirm delete").click(); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "skills.delete", name: "user-skill" }));
    await act(async () => { button("/packaged (packaged)").click(); });
    expect(root.querySelector("textarea")!.disabled).toBe(true);
    expect(button("Save changes").disabled).toBe(true);
    expect(button("Delete")).toBeUndefined();
  });

  it("preserves the draft when persistence fails", async () => {
    const send = await mount();
    await input("Name", "research");
    await input("Description", "Research");
    await input("Instructions", "Body");
    send.mockRejectedValueOnce(new Error("private detail"));
    await act(async () => { button("Create skill").click(); });
    expect(root.querySelector("textarea")!.value).toBe("Body");
    expect(root.querySelector('[role="alert"]')!.textContent).toContain("could not complete");
    expect(root.textContent).not.toContain("private detail");
  });
});
