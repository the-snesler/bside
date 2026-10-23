import type { ComponentType, JSX } from "preact";
import Settings from "~icons/tabler/settings";
import UserCircle from "~icons/tabler/user-circle";
import Sparkles from "~icons/tabler/sparkles";
import ShieldLock from "~icons/tabler/shield-lock";
import MessageUser from "~icons/tabler/message-user";
import WorldPin from "~icons/tabler/world-pin";
import { SkillsEditor } from "@/lib/ui/SkillsEditor";
import type { OptionsApp } from "../state";
import { GeneralPage } from "./General";
import { AccountPage } from "./Account";
import { HistoryPage } from "./History";
import { InstructionsPage } from "./Instructions";
import { SiteNotesPage } from "./SiteNotes";

export interface SettingsPageProps {
  app: OptionsApp;
}

/** Sidebar groups, in display order. */
export const SETTINGS_GROUPS = ["Personal", "Agent", "Data"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/**
 * One settings page. Adding a page is one entry in `SETTINGS_PAGES`: the
 * shell builds the sidebar, the `#/<id>` route, the title, and search from it.
 */
export interface SettingsPage {
  /** Route segment: the page lives at `#/<id>`. Lowercase, stable once shipped. */
  id: string;
  label: string;
  group: SettingsGroup;
  icon: ComponentType<JSX.SVGAttributes<SVGSVGElement>>;
  /** One line under the page title. */
  description?: string;
  /** Row titles and other words a user might search for, beyond the label. */
  keywords: readonly string[];
  component: ComponentType<SettingsPageProps>;
}

/** Every page, in sidebar order within its group. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: "general",
    label: "General",
    group: "Personal",
    icon: Settings,
    keywords: ["Model", "Reasoning effort", "Thinking", "Provider", "OpenAI account", "Connection"],
    component: GeneralPage,
  },
  {
    id: "account",
    label: "Account",
    group: "Personal",
    icon: UserCircle,
    description: "How bside reaches OpenAI. Credentials stay encrypted in this Firefox profile.",
    keywords: ["ChatGPT", "Sign in", "Sign out", "Disconnect", "Test connection", "Subscription", "Plan", "OpenAI API key", "Replace key", "Delete key", "Credentials"],
    component: AccountPage,
  },
  {
    id: "instructions",
    label: "Instructions",
    group: "Personal",
    icon: MessageUser,
    description: "Tell bside about yourself and how you like answers. Sent with every message.",
    keywords: ["Custom instructions", "About me", "How to respond", "Preferences", "Personalization", "Tone", "System prompt"],
    component: InstructionsPage,
  },
  {
    id: "skills",
    label: "Skills",
    group: "Agent",
    icon: Sparkles,
    description: "Reusable Markdown instructions you invoke with /name in chat.",
    keywords: ["Your skills", "New skill", "Edit skill", "Delete skill", "Slash commands", "Instructions", "Markdown", "Packaged skills", "YouTube", "Prompts"],
    component: SkillsEditor,
  },
  {
    id: "site-notes",
    label: "Site notes",
    group: "Agent",
    icon: WorldPin,
    description: "Notes bside reads when it works on a particular site.",
    keywords: ["Site instructions", "Per-site", "Websites", "Domains", "Origins", "Subdomains", "Remember this site", "Memory"],
    component: SiteNotesPage,
  },
  {
    id: "history",
    label: "History & privacy",
    group: "Data",
    icon: ShieldLock,
    keywords: ["Keep chats", "Retention", "Delete all history", "Saved chats", "Pinned", "Storage", "Data", "Sync"],
    component: HistoryPage,
  },
];
