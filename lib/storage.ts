/**
 * Versioned `storage.local` records. Only background code should import
 * `getOpenAICredential`/`saveOpenAICredential`; every other surface reads
 * `getCredentialStatus()`, which never exposes the raw key.
 *
 * Every getter defensively revalidates the stored shape and resets to the
 * documented default on malformed/corrupt data — WXT's `version`/`migrations`
 * options only cover a version bump with a declared migration function, not
 * arbitrary corruption.
 */

import { storage } from "wxt/utils/storage";
import type { AppSettingsV1, ModelDefinition, ReasoningEffort } from "@/lib/domain/provider";
import type { ConversationItem, ConversationRecordV1 } from "@/lib/domain/conversation";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "@/lib/providers/openai-models";

export type { AppSettingsV1 } from "@/lib/domain/provider";

export interface OpenAICredentialV1 {
  version: 1;
  apiKey: string;
  updatedAt: number;
}

export interface ChatGPTCredentialV1 {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
  models: ModelDefinition[];
}

export interface ChatGPTRegistrationV1 {
  version: 1;
  hostId: string;
  clientId: string | null;
  subject: string | null;
  redirectUri: string;
}

export type RunStatus = "running" | "awaiting-approval" | "cancelled" | "failed" | "completed";

export interface RunCheckpointV1 {
  version: 1;
  runId: string;
  status: RunStatus;
  partialAssistantText: string;
  lastSeq: number;
  updatedAt: number;
}

/**
 * Hidden tabs the agent owns, keyed by tab ID. Firefox reuses tab IDs after a
 * browser restart, so `url` lets startup reject an ID that now names a
 * different tab. Scratch files are not part of this record.
 */
export interface AgentTabsV1 {
  version: 1;
  tabs: Record<string, { url: string; lastUsedAt: number }>;
  searchTabId: number | null;
}

const MAX_AGENT_TABS = 500;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const RUN_STATUSES: readonly RunStatus[] = ["running", "awaiting-approval", "cancelled", "failed", "completed"];

const DEFAULT_APP_SETTINGS: AppSettingsV1 = {
  version: 1,
  providerId: "openai",
  modelId: DEFAULT_MODEL_ID,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
};

const DEFAULT_CONVERSATION: ConversationRecordV1 = { version: 1, id: "default", items: [], updatedAt: 0 };

const appSettingsItem = storage.defineItem<AppSettingsV1>("local:appSettings", {
  version: 1,
  fallback: DEFAULT_APP_SETTINGS,
});

const openaiCredentialItem = storage.defineItem<OpenAICredentialV1>("local:openaiCredential", {
  version: 1,
});

const chatgptCredentialItem = storage.defineItem<ChatGPTCredentialV1>("local:chatgptCredential", { version: 1 });
const chatgptRegistrationItem = storage.defineItem<ChatGPTRegistrationV1>("local:chatgptRegistration", { version: 1 });

const conversationItem = storage.defineItem<ConversationRecordV1>("local:conversation", {
  version: 1,
  fallback: DEFAULT_CONVERSATION,
});

const runCheckpointItem = storage.defineItem<RunCheckpointV1>("local:runCheckpoint", {
  version: 1,
});

const DEFAULT_AGENT_TABS: AgentTabsV1 = { version: 1, tabs: {}, searchTabId: null };
const agentTabsItem = storage.defineItem<AgentTabsV1>("local:agentTabs", { version: 1, fallback: DEFAULT_AGENT_TABS });

// ---------------------------------------------------------------------------
// Shape validators — reject anything that doesn't match, never trust raw storage.
// ---------------------------------------------------------------------------

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function isValidAppSettings(value: unknown): value is AppSettingsV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    v.providerId === "openai" &&
    typeof v.modelId === "string" &&
    v.modelId.length > 0 &&
    isReasoningEffort(v.reasoningEffort)
  );
}

function isValidCredential(value: unknown): value is OpenAICredentialV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && typeof v.apiKey === "string" && v.apiKey.length > 0 && typeof v.updatedAt === "number";
}

function isValidConversationItem(value: unknown): value is ConversationItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.at !== "number") return false;
  if (v.kind === "message") {
    if (typeof v.text !== "string") return false;
    if (v.role === "user") return v.context === null || typeof v.context === "object";
    return v.role === "assistant";
  }
  if (v.kind === "tool-call") return typeof v.call === "object" && v.call !== null;
  if (v.kind === "tool-result") return typeof v.callId === "string" && typeof v.result === "object" && v.result !== null;
  return false;
}

function isValidConversation(value: unknown): value is ConversationRecordV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && v.id === "default" && Array.isArray(v.items) && v.items.every(isValidConversationItem);
}

function isValidRunCheckpoint(value: unknown): value is RunCheckpointV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.runId === "string" &&
    (RUN_STATUSES as readonly string[]).includes(v.status as string) &&
    typeof v.partialAssistantText === "string" &&
    typeof v.lastSeq === "number" &&
    typeof v.updatedAt === "number"
  );
}

function isValidAgentTabs(value: unknown): value is AgentTabsV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.tabs !== "object" || v.tabs === null || Array.isArray(v.tabs)) return false;
  const entries = Object.entries(v.tabs);
  return (
    entries.length <= MAX_AGENT_TABS &&
    entries.every(([key, entry]) => {
      if (!/^\d{1,15}$/.test(key) || typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      return typeof e.url === "string" && e.url.length > 0 && e.url.length <= 8_192 &&
        typeof e.lastUsedAt === "number" && Number.isFinite(e.lastUsedAt);
    }) &&
    (v.searchTabId === null || (Number.isSafeInteger(v.searchTabId) && Object.hasOwn(v.tabs, String(v.searchTabId))))
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getAppSettings(): Promise<AppSettingsV1> {
  const raw = await appSettingsItem.getValue();
  if (isValidAppSettings(raw)) return raw;
  if (raw !== null) await appSettingsItem.setValue(DEFAULT_APP_SETTINGS);
  return DEFAULT_APP_SETTINGS;
}

export async function saveAppSettings(settings: AppSettingsV1): Promise<void> {
  await appSettingsItem.setValue(settings);
}

// ---------------------------------------------------------------------------
// Credential — background-only; every other surface must use getCredentialStatus.
// ---------------------------------------------------------------------------

/** Background-only. Never expose the return value of this function outside the background context. */
export async function getOpenAICredential(): Promise<OpenAICredentialV1 | null> {
  const raw = await openaiCredentialItem.getValue();
  if (isValidCredential(raw)) return raw;
  if (raw !== null) await openaiCredentialItem.removeValue();
  return null;
}

export async function saveOpenAICredential(apiKey: string): Promise<void> {
  await openaiCredentialItem.setValue({ version: 1, apiKey, updatedAt: Date.now() });
}

export async function deleteOpenAICredential(): Promise<void> {
  await openaiCredentialItem.removeValue();
}

export interface CredentialStatus {
  configured: boolean;
  maskedSuffix: string | null;
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  const credential = await getOpenAICredential();
  if (!credential) return { configured: false, maskedSuffix: null };
  return { configured: true, maskedSuffix: credential.apiKey.slice(-4) };
}

/** Background-only. OAuth tokens are encrypted; catalog metadata contains no credentials. */
export async function getChatGPTCredential(): Promise<ChatGPTCredentialV1 | null> {
  const raw = await chatgptCredentialItem.getValue();
  if (raw?.version === 1 && typeof raw.salt === "string" && raw.salt.length === 24 &&
    typeof raw.iv === "string" && raw.iv.length === 16 && typeof raw.ciphertext === "string" &&
    raw.ciphertext.length > 0 && raw.ciphertext.length < 200_000 && Array.isArray(raw.models) &&
    raw.models.length > 0 && raw.models.length <= 200 && raw.models.every((model) =>
      model && typeof model.id === "string" && /^[\w.:-]{1,200}$/.test(model.id) &&
      typeof model.name === "string" && model.name.length <= 200 && Array.isArray(model.reasoningEfforts) &&
      model.reasoningEfforts.length > 0 && model.reasoningEfforts.every(isReasoningEffort) &&
      isReasoningEffort(model.defaultReasoningEffort) && model.reasoningEfforts.includes(model.defaultReasoningEffort))) return raw;
  if (raw !== null) await chatgptCredentialItem.removeValue();
  return null;
}

export async function saveChatGPTCredential(credential: ChatGPTCredentialV1): Promise<void> {
  await chatgptCredentialItem.setValue(credential);
}

export async function deleteChatGPTCredential(): Promise<void> {
  await chatgptCredentialItem.removeValue();
}

/** Non-secret registration survives disconnect so reauthorization reuses the issued client ID. */
export async function getChatGPTRegistration(): Promise<ChatGPTRegistrationV1 | null> {
  const raw = await chatgptRegistrationItem.getValue();
  if (raw?.version === 1 && typeof raw.hostId === "string" && /^urn:uuid:[\da-f-]{36}$/i.test(raw.hostId) &&
    (raw.clientId === null || (typeof raw.clientId === "string" && /^[\w-]{1,200}$/.test(raw.clientId))) &&
    (raw.subject === null || typeof raw.subject === "string") && typeof raw.redirectUri === "string" &&
    /^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/mozoauth2\/[\w-]+$/.test(raw.redirectUri)) return raw;
  if (raw !== null) await chatgptRegistrationItem.removeValue();
  return null;
}

export async function saveChatGPTRegistration(registration: ChatGPTRegistrationV1): Promise<void> {
  await chatgptRegistrationItem.setValue(registration);
}

// ---------------------------------------------------------------------------
// Conversation — one local thread.
// ---------------------------------------------------------------------------

export async function getConversation(): Promise<ConversationRecordV1> {
  const raw = await conversationItem.getValue();
  if (isValidConversation(raw)) return raw;
  if (raw !== null) await conversationItem.setValue(DEFAULT_CONVERSATION);
  return DEFAULT_CONVERSATION;
}

export async function resetConversation(): Promise<void> {
  await conversationItem.setValue({ ...DEFAULT_CONVERSATION, items: [], updatedAt: Date.now() });
  await clearRunCheckpoint();
}

export async function appendConversationItem(item: ConversationItem): Promise<ConversationRecordV1> {
  const conversation = await getConversation();
  const next: ConversationRecordV1 = {
    ...conversation,
    items: [...conversation.items, item],
    updatedAt: Date.now(),
  };
  await conversationItem.setValue(next);
  return next;
}

// ---------------------------------------------------------------------------
// Run checkpoint — run-local recovery marker, not the transcript itself.
// ---------------------------------------------------------------------------

export async function getRunCheckpoint(): Promise<RunCheckpointV1 | null> {
  const raw = await runCheckpointItem.getValue();
  if (isValidRunCheckpoint(raw)) return raw;
  if (raw !== null) await runCheckpointItem.removeValue();
  return null;
}

export async function saveRunCheckpoint(checkpoint: RunCheckpointV1): Promise<void> {
  await runCheckpointItem.setValue(checkpoint);
}

export async function clearRunCheckpoint(): Promise<void> {
  await runCheckpointItem.removeValue();
}

// ---------------------------------------------------------------------------
// Agent tabs — ownership of hidden workspace tabs across background restarts.
// ---------------------------------------------------------------------------

export async function getAgentTabs(): Promise<AgentTabsV1> {
  const raw = await agentTabsItem.getValue();
  if (isValidAgentTabs(raw)) return raw;
  if (raw !== null) await agentTabsItem.removeValue();
  return DEFAULT_AGENT_TABS;
}

export async function saveAgentTabs(record: AgentTabsV1): Promise<void> {
  await agentTabsItem.setValue(record);
}

const INTERRUPTED_SUFFIX ="\n\n[Interrupted: the extension restarted before this response finished.]";

/**
 * Startup recovery: a checkpoint left "running"/"awaiting-approval" means the
 * background died mid-run. Convert it into a visible interrupted assistant
 * message rather than silently dropping it or claiming stream resumption.
 * Returns whether a run was interrupted.
 */
export async function recoverInterruptedRun(): Promise<boolean> {
  const checkpoint = await getRunCheckpoint();
  if (!checkpoint) return false;
  if (checkpoint.status !== "running" && checkpoint.status !== "awaiting-approval") {
    await clearRunCheckpoint();
    return false;
  }

  const text = checkpoint.partialAssistantText
    ? `${checkpoint.partialAssistantText}${INTERRUPTED_SUFFIX}`
    : INTERRUPTED_SUFFIX.trim();

  await appendConversationItem({
    id: `interrupted-${checkpoint.runId}`,
    kind: "message",
    role: "assistant",
    text,
    at: Date.now(),
  });
  await clearRunCheckpoint();
  return true;
}
