import { getSkills } from "@/lib/background/skills";
import { skillCatalog, renderSkillContext, type Skill, type SkillContext } from "@/lib/domain/skills";

export async function captureSkillContext(text: string, available?: readonly Skill[]): Promise<SkillContext | undefined> {
  const skills = available ?? await getSkills();
  const name = /^\/([a-z][a-z0-9-]{0,47})(?=\s|$)/.exec(text)?.[1];
  const invoked = name ? skills.find((skill) => skill.name === name) : undefined;
  if (name && !invoked) throw new Error(`Skill /${name} does not exist. Create it in Settings → Skills or choose another skill.`);
  if (!skills.length) return undefined;
  return { version: 1, catalog: skillCatalog(skills), ...(invoked ? { invoked } : {}) };
}

export function renderUserPrompt(message: { text: string; skills?: SkillContext }): string {
  const context = message.skills ? renderSkillContext(message.skills) : "";
  return context ? `${message.text}\n\n${context}` : message.text;
}
