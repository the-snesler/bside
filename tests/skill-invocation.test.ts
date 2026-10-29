import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureInvokedSkill, renderUserPrompt } from "@/lib/background/skill-context";
import { handleSkillsRequest } from "@/lib/background/skills";
import { BrowserProgram, parseProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { TabController } from "@/lib/background/tab-controller";
import { appendConversationItem, createSession, getConversation, loadMessageQueue, saveMessageQueue } from "@/lib/storage";

const skill = { name: "summarize", description: "Summarize the attached page", body: "BODY_ONLY_ON_DEMAND: Read the page and summarize it." };
const save = (body = skill.body) => handleSkillsRequest({ v: 1, id: "save", type: "skills.save", skill: { ...skill, body } });

beforeEach(() => fakeBrowser.reset());

describe("skill invocation", () => {
  it("captures only a leading explicit slug and never injects the body or the catalog", async () => {
    await save();
    const invoked = await captureInvokedSkill("/summarize briefly");
    expect(invoked).toEqual(skill);
    const rendered = renderUserPrompt({ text: "/summarize briefly", skill: invoked });
    expect(rendered).toContain("/skills/summarize.md");
    expect(rendered).not.toContain("BODY_ONLY_ON_DEMAND");
    expect(rendered).not.toContain(skill.description);
    const read = rendered.match(/fs\.read\([^)]*\)/)![0];
    expect(() => parseProgram(`${read};`)).not.toThrow();
    expect(await captureInvokedSkill("Discuss /summarize")).toBeUndefined();
    expect(renderUserPrompt({ text: "Discuss /summarize" })).toBe("Discuss /summarize");
    await expect(captureInvokedSkill("/missing")).rejects.toThrow("does not exist");
  });

  it("pins invocation bodies across storage, edits, deletion, and replay", async () => {
    await save();
    const invoked = await captureInvokedSkill("/summarize");
    const message = { id: "q1", text: "/summarize", skill: invoked, at: 1 };
    const { id } = await createSession();
    await saveMessageQueue(id, [{ ...message, mode: "follow-up" }]);
    await save("Changed body");
    await handleSkillsRequest({ v: 1, id: "delete", type: "skills.delete", name: skill.name });
    const queued = (await loadMessageQueue(id))[0]!;
    expect(queued.skill).toEqual(skill);
    await appendConversationItem(id, { ...queued, kind: "message", role: "user", context: null });
    const item = (await getConversation(id))!.items[0]!;
    expect(item).toMatchObject({ skill });
    expect(renderUserPrompt(queued)).toBe(renderUserPrompt(message));
  });

  it("exposes only read-only exact skill paths and no page effects", async () => {
    const effect = vi.fn();
    const program = new BrowserProgram(new TabController({ tabs: { query: vi.fn(async () => []), update: vi.fn(async () => {}), goBack: vi.fn(async () => {}), sendMessage: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } } }), {
      state: new WorkspaceState(), runId: "r1", sessionId: "s1", files: new ScratchFiles(), skills: new Map([[skill.name, skill]]),
    }, effect);
    const run = (source: string) => program.execute(source, new AbortController().signal);
    expect((await run('return fs.list("/skills");')).summary).toContain("Summarize the attached page");
    expect((await run('return fs.list("/skills");')).summary).not.toContain("BODY_ONLY_ON_DEMAND");
    expect((await run('return fs.read("/skills/summarize.md");')).summary).toContain(skill.body);
    for (const source of [
      'fs.write("/skills/summarize.md", "changed");', 'fs.remove("/skills/summarize.md");',
      'fs.move("/skills/summarize.md", "/workspace/a");', 'fs.read("/skills/../summarize.md");',
      'fs.read("/skills/missing.md");', 'fs.read("/skills/summarize.md", {});',
      'fs.write("/workspace/a", "text"); fs.move("/workspace/a", "/skills/summarize.md");',
    ]) expect((await run(source)).ok, source).toBe(false);
    expect(effect).not.toHaveBeenCalled();
    expect((await run('return fs.read("/skills/summarize.md");')).summary).toContain(skill.body);
  });
});
