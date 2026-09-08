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
import type { AppSettingsV1, ReasoningEffort } from "@/lib/domain/provider";
import type { ConversationItem, ConversationRecordV1 } from "@/lib/domain/conversation";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "@/lib/providers/openai-models";

export type { AppSettingsV1 } from "@/lib/domain/provider";

export interface OpenAICredentialV1 {
  version: 1;
  apiKey: string;
  updatedAt: number;
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

const conversationItem = storage.defineItem<ConversationRecordV1>("local:conversation", {
  version: 1,
  fallback: DEFAULT_CONVERSATION,
});

const runCheckpointItem = storage.defineItem<RunCheckpointV1>("local:runCheckpoint", {
  version: 1,
});

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

const INTERRUPTED_SUFFIX = "\n\n[Interrupted: the extension restarted before this response finished.]";

/**
 * Startup recovery: a checkpoint left "running"/"awaiting-approval" means the
 * background died mid-run. Convert it into a visible interrupted assistant
 * message rather than silently dropping it or claiming stream resumption.
 */
export async function recoverInterruptedRun(): Promise<void> {
  const checkpoint = await getRunCheckpoint();
  if (!checkpoint) return;
  if (checkpoint.status !== "running" && checkpoint.status !== "awaiting-approval") {
    await clearRunCheckpoint();
    return;
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
}
