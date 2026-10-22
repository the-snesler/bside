import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "wxt/utils/storage";
import { BUILTIN_SKILLS, getSkills, handleSkillsRequest } from "@/lib/background/skills";
import { isSkill, renderSkillCatalog, skillCatalog, type Skill } from "@/lib/domain/skills";
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

  it("renders a catalog of names, descriptions, and paths without bodies", () => {
    const rendered = renderSkillCatalog(skillCatalog([skill]));
    expect(rendered).toContain(JSON.stringify({ name: "research", description: "Research a topic", path: "/skills/research.md" }));
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
    expect(await getSkills()).toEqual([]);
    expect((await save(skill)).ok).toBe(true);
    expect((await save({ ...skill, body: "Updated" })).ok).toBe(true);
    expect(await getSkills()).toEqual([{ ...skill, body: "Updated" }]);
    expect(await handleSkillsRequest({ v: 1, id: "list", type: "skills.list" })).toEqual({ v: 1, id: "list", ok: true, skills: [{ ...skill, body: "Updated" }], builtinNames: [] });
    expect((await handleSkillsRequest({ v: 1, id: "delete", type: "skills.delete", name: skill.name })).ok).toBe(true);
    expect(await getSkills()).toEqual([]);
  });

  it("serializes concurrent changes without losing records", async () => {
    await Promise.all(Array.from({ length: 32 }, (_, i) => save({ ...skill, name: `skill-${i}` })));
    expect(await getSkills()).toHaveLength(32);
    expect((await save({ ...skill, name: "skill-0", body: "Updated" })).ok).toBe(true);
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
      expect(await getSkills()).toEqual([]);
    }
    await storage.setItem("local:skills", { version: 1, skills: [null, { ...skill, body: "" }, { ...skill, extra: "discard" }, skill] });
    expect(await getSkills()).toEqual([skill]);
    await storage.setItem("local:skills", { version: 1, skills: Array.from({ length: 100 }, (_, i) => ({ ...skill, name: `skill-${i}` })) });
    expect(await getSkills()).toHaveLength(100);
  });

  it("protects packaged skills against shadowing, saves, and deletion", async () => {
    const builtins = BUILTIN_SKILLS as Skill[];
    builtins.push(skill);
    try {
      await storage.setItem("local:skills", { version: 1, skills: [{ ...skill, body: "Shadow" }] });
      expect(await getSkills()).toEqual([skill]);
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
      expect(await getSkills()).toEqual([skill]);
    } finally { write.mockRestore(); }
  });
});
