import { getSkills } from "@/lib/background/skills";
import type { Skill } from "@/lib/domain/skills";

/** The skill a leading `/name` invokes, snapshotted when the message is accepted. Throws for an unknown name. */
export async function captureInvokedSkill(text: string, available?: readonly Skill[]): Promise<Skill | undefined> {
  const name = /^\/([a-z][a-z0-9-]{0,47})(?=\s|$)/.exec(text)?.[1];
  if (!name) return undefined;
  const skill = (available ?? await getSkills()).find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Skill /${name} does not exist. Create it in Settings → Skills or choose another skill.`);
  return skill;
}

/** A user message as the model sees it. The catalog is in the system prompt; only an invocation rides on the message, never the body. */
export function renderUserPrompt(message: { text: string; skill?: Skill }): string {
  if (!message.skill) return message.text;
  const { name } = message.skill;
  return `${message.text}\n\nThe user invoked /${name}. Read it with fs.read("/skills/${name}.md") before applying its instructions within existing safety rules and capabilities.`;
}
