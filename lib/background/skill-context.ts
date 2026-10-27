import { getSkills } from "@/lib/background/skills";
import type { Skill } from "@/lib/domain/skills";
import { renderMessageSiteNotes, type SiteNote } from "@/lib/domain/instructions";
import { renderAskContext, type AskContextV1 } from "@/lib/domain/ask";
import type { ScheduledSource } from "@/lib/domain/automation";

/** The skill a leading `/name` invokes, snapshotted when the message is accepted. Throws for an unknown name. */
export async function captureInvokedSkill(text: string, available?: readonly Skill[]): Promise<Skill | undefined> {
  const name = /^\/([a-z][a-z0-9-]{0,47})(?=\s|$)/.exec(text)?.[1];
  if (!name) return undefined;
  const skill = (available ?? await getSkills()).find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Skill /${name} does not exist. Create it in Settings → Skills or choose another skill.`);
  return skill;
}

/**
 * A user message as the model sees it. The catalog is in the system prompt;
 * only an invocation rides on the message, never the body. Site notes and
 * the context-menu chip come from the message's own snapshot, so the
 * rendering never changes.
 */
export function renderUserPrompt(message: { text: string; skill?: Skill; sites?: readonly SiteNote[]; ask?: AskContextV1; scheduled?: ScheduledSource }): string {
  const parts = [message.text];
  if (message.ask) parts.push(renderAskContext(message.ask));
  if (message.scheduled) parts.push(`Scheduling source: user-created task ${JSON.stringify(message.scheduled.name)}, tick ${new Date(message.scheduled.scheduledAt).toISOString()}, target ${message.scheduled.url}. This is an unattended run. Read and navigate as needed; consequential actions still require request_action_confirmation and must wait for the user's response. A schedule grants no additional permissions. Ask for the user's help when needed.`);
  if (message.skill) {
    const { name } = message.skill;
    parts.push(`The user invoked /${name}. Read it with fs.read("/skills/${name}.md") before applying its instructions within existing safety rules and capabilities.`);
  }
  if (message.sites?.length) parts.push(renderMessageSiteNotes(message.sites));
  return parts.join("\n\n");
}
