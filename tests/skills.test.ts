import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "wxt/utils/storage";
import { BUILTIN_SKILLS, getSkills, handleSkillsRequest } from "@/lib/background/skills";
import { isSkill, isSkillContext, renderSkillContext, skillCatalog, type Skill } from "@/lib/domain/skills";
import { isSidebarCommand, isSkillsRequest } from "@/lib/protocol";

const skill: Skill = { name: "research", description: "Research a topic", body: "Read sources carefully." };
const save = (value: Skill) => handleSkillsRequest({ v: 1, id: value.name, type: "skills.save", skill: value });

beforeEach(() => { fakeBrowser.reset(); });

describe("skill contracts", () => {
  it("bounds names, descriptions, and bodies", () => {
    expect(isSkill(skill)).toBe(true);
    for (const name of ["", "Research", "../file", "1name", "a".repeat(49)]) expect(isSkill({ ...skill, name })).toBe(false);
    for (const description of ["", " ", "line\nbreak", "line\rbreak", "a".repeat(161)]) expect(isSkill({ ...skill, description })).toBe(false);
    for (const body of ["", "  ", "a".repeat(16_001)]) expect(isSkill({ ...skill, body })).toBe(false);
    expect(isSkill({ name: "a".repeat(48), description: "a".repeat(160), body: "a".repeat(16_000) })).toBe(true);
  });

  it("validates versioned snapshots and excludes bodies from rendered context", () => {
    const context = { version: 1 as const, catalog: skillCatalog([skill]), invoked: skill };
    expect(isSkillContext(context)).toBe(true);
    expect(isSkillContext({ ...context, version: 2 })).toBe(false);
    expect(isSkillContext({ ...context, catalog: [] })).toBe(false);
    expect(isSkillContext({ ...context, catalog: [context.catalog[0], context.catalog[0]] })).toBe(false);
    expect(isSkillContext({ version: 1, catalog: Array.from({ length: 33 }, (_, i) => ({ name: `skill-${i}`, description: "Description" })) })).toBe(false);
    const rendered = renderSkillContext(context);
    expect(rendered).toContain('fs.read("/skills/research.md")');
    expect(rendered).toContain("cannot override safety");
    expect(rendered).not.toContain(skill.body);
  });

  it("validates options requests and the catalog-only sidebar command", () => {
    expect(isSkillsRequest({ v: 1, id: "1", type: "skills.save", skill })).toBe(true);
    expect(isSkillsRequest({ v: 2, id: "1", type: "skills.list" })).toBe(false);
    expect(isSkillsRequest({ v: 1, id: "1", type: "skills.delete", name: "../bad" })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "1", type: "skills.list" })).toBe(true);
    expect(isSidebarCommand({ v: 1, id: "1", type: "skills.save", skill })).toBe(false);
  });
});

describe("background-owned skills", () => {
  it("lists, creates, updates, and deletes skills", async () => {
    expect(await getSkills()).toEqual(BUILTIN_SKILLS);
    expect((await save(skill)).ok).toBe(true);
    expect((await save({ ...skill, body: "Updated" })).ok).toBe(true);
    expect(await getSkills()).toEqual([...BUILTIN_SKILLS, { ...skill, body: "Updated" }]);
    expect(await handleSkillsRequest({ v: 1, id: "list", type: "skills.list" })).toEqual({
      v: 1, id: "list", ok: true, skills: [...BUILTIN_SKILLS, { ...skill, body: "Updated" }], builtinNames: BUILTIN_SKILLS.map((item) => item.name),
    });
    expect((await handleSkillsRequest({ v: 1, id: "delete", type: "skills.delete", name: skill.name })).ok).toBe(true);
    expect(await getSkills()).toEqual(BUILTIN_SKILLS);
  });

  it("packages a valid, read-only YouTube skill", async () => {
    const youtube = BUILTIN_SKILLS.find((item) => item.name === "youtube");
    expect(youtube && isSkill(youtube)).toBe(true);
    expect(youtube!.body).toContain("youtube.getTranscript(");
    expect((await save({ ...skill, name: "youtube" })).ok).toBe(false);
  });

  it("counts packaged skills toward the limit and serializes concurrent changes without losing records", async () => {
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => save({ ...skill, name: `skill-${i}` })));
    expect(results.filter((result) => result.ok)).toHaveLength(32 - BUILTIN_SKILLS.length);
    expect(await getSkills()).toHaveLength(32);
    expect((await save(skill)).ok).toBe(false);
    expect((await save({ ...skill, name: "skill-0", body: "Update at capacity" })).ok).toBe(true);
    await Promise.all([
      handleSkillsRequest({ v: 1, id: "delete", type: "skills.delete", name: "skill-0" }),
      save(skill),
    ]);
    expect((await getSkills()).map((item) => item.name)).toContain("research");
    expect((await getSkills()).map((item) => item.name)).not.toContain("skill-0");
  });

  it("revalidates corrupt records and strips unknown fields", async () => {
    for (const value of [null, [], "bad", { version: 2, skills: [skill] }, { version: 1, skills: {} }]) {
      await storage.setItem("local:skills", value);
      expect(await getSkills()).toEqual(BUILTIN_SKILLS);
    }
    await storage.setItem("local:skills", { version: 1, skills: [null, { ...skill, body: "" }, { ...skill, extra: "discard" }, skill] });
    expect(await getSkills()).toEqual([...BUILTIN_SKILLS, skill]);
    await storage.setItem("local:skills", { version: 1, skills: Array.from({ length: 40 }, (_, i) => ({ ...skill, name: `skill-${i}` })) });
    expect(await getSkills()).toHaveLength(32);
  });

  it("protects packaged skills against shadowing, saves, and deletion", async () => {
    const builtins = BUILTIN_SKILLS as Skill[];
    builtins.push(skill);
    try {
      await storage.setItem("local:skills", { version: 1, skills: [{ ...skill, body: "Shadow" }] });
      expect(await getSkills()).toEqual([...builtins]);
      expect((await save(skill)).ok).toBe(false);
      expect((await handleSkillsRequest({ v: 1, id: "delete", type: "skills.delete", name: skill.name })).ok).toBe(false);
    } finally { builtins.pop(); }
  });

  it("normalizes persistence failures and lets later writes proceed", async () => {
    const write = vi.spyOn(storage, "setItem").mockRejectedValueOnce(new Error("private storage detail"));
    try {
      const result = await save(skill);
      expect(result).toMatchObject({ ok: false, error: { phase: "persistence", retryable: true } });
      expect(JSON.stringify(result)).not.toContain("private storage detail");
      expect((await save(skill)).ok).toBe(true);
      expect(await getSkills()).toEqual([...BUILTIN_SKILLS, skill]);
    } finally { write.mockRestore(); }
  });
});
