import { storage } from "wxt/utils/storage";
import { isSkill, type Skill } from "@/lib/domain/skills";
import { isSkillsRequest, type SkillsRequest, type SkillsResponse } from "@/lib/protocol";
import youtubeBody from "@/lib/skills/youtube.md?raw";

/** Packaged skills, listed before saved ones; each guides one site API in `lib/sites`. */
export const BUILTIN_SKILLS: readonly Skill[] = [
  { name: "youtube", description: "Search YouTube, read video metadata and transcripts, and inspect comments through youtube.* calls, without opening YouTube pages.", body: youtubeBody },
];

let mutations: Promise<unknown> = Promise.resolve();

async function readSkills(): Promise<Skill[]> {
  const value = await storage.getItem<unknown>("local:skills");
  const record = value as { version?: unknown; skills?: unknown } | null;
  const users = record?.version === 1 && Array.isArray(record.skills) ? record.skills : [];
  const skills = BUILTIN_SKILLS.map(({ name, description, body }) => ({ name, description, body }));
  const names = new Set(skills.map((skill) => skill.name));
  for (const skill of users) {
    if (!isSkill(skill) || names.has(skill.name)) continue;
    skills.push({ name: skill.name, description: skill.description, body: skill.body });
    names.add(skill.name);
  }
  return skills;
}

export async function getSkills(): Promise<Skill[]> {
  await mutations;
  return readSkills();
}

export function handleSkillsRequest(request: SkillsRequest): Promise<SkillsResponse> {
  const operation = mutations.then(async (): Promise<SkillsResponse> => {
    const invalid = (message: string): SkillsResponse => ({ v: 1, id: request.id, ok: false,
      error: { code: "INVALID_REQUEST", message, retryable: false, phase: "setup" } });
    if (!isSkillsRequest(request)) return invalid("Invalid skill. Check the name, description, and body limits.");
    try {
      let skills = await readSkills();
      const builtinNames = BUILTIN_SKILLS.map((skill) => skill.name);
      if (request.type !== "skills.list") {
        const name = request.type === "skills.save" ? request.skill.name : request.name;
        if (builtinNames.includes(name)) return invalid("Packaged skills cannot be changed or deleted.");
        if (request.type === "skills.save") {
          const { description, body } = request.skill;
          const index = skills.findIndex((skill) => skill.name === name);
          if (index < 0) skills.push({ name, description, body });
          else skills[index] = { name, description, body };
        } else skills = skills.filter((skill) => skill.name !== name);
        await storage.setItem("local:skills", { version: 1, skills: skills.filter((skill) => !builtinNames.includes(skill.name)) });
      }
      return { v: 1, id: request.id, ok: true, skills, builtinNames };
    } catch {
      return { v: 1, id: request.id, ok: false, error: { code: "PROTOCOL_ERROR", message: "Skills could not be read or saved. Try again.", retryable: true, phase: "persistence" } };
    }
  });
  mutations = operation.then(() => undefined, () => undefined);
  return operation;
}
