/**
 * Versioned `storage.local` records. Only background code should import
 * `getOpenAICredential`/`saveOpenAICredential`; every other surface reads
 * `getCredentialStatus()`, which never exposes the raw key. The API key and
 * ChatGPT tokens are sealed with the background's device key at rest.
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
import { deviceKey, type DeviceKey } from "@/lib/background/device-key";

export type { AppSettingsV1 } from "@/lib/domain/provider";

/** The API key sealed with the device key; never stored in plaintext. */
export interface OpenAICredentialV2 {
  version: 2;
  iv: string;
  ciphertext: string;
  updatedAt: number;
}

/** Background-only decrypted view of `OpenAICredentialV2`. */
export interface OpenAICredential {
  apiKey: string;
  updatedAt: number;
}

/** ChatGPT tokens sealed with the device key, plus the account's non-secret model catalog. */
export interface ChatGPTCredentialV2 {
  version: 2;
  iv: string;
  ciphertext: string;
  models: ModelDefinition[];
}

/** Set when an upgrade removed a PIN-wrapped ChatGPT credential; cleared on dismissal or sign-in. */
export interface ChatGPTSignInNoticeV1 {
  version: 1;
  createdAt: number;
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

const openaiCredentialItem = storage.defineItem<OpenAICredentialV2>("local:openaiCredential", {
  version: 2,
});

const OPENAI_CREDENTIAL_CONTEXT = "bside:openai-credential:v2";

const chatgptCredentialItem = storage.defineItem<ChatGPTCredentialV2>("local:chatgptCredential", { version: 2 });
const chatgptRegistrationItem = storage.defineItem<ChatGPTRegistrationV1>("local:chatgptRegistration", { version: 1 });
const chatgptSignInNoticeItem = storage.defineItem<ChatGPTSignInNoticeV1>("local:chatgptSignInNotice", { version: 1 });

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

function isValidCredential(value: unknown): value is OpenAICredentialV2 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 2 && typeof v.iv === "string" && v.iv.length === 16 && typeof v.ciphertext === "string" &&
    v.ciphertext.length > 0 && v.ciphertext.length < 20_000 && typeof v.updatedAt === "number";
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

/**
 * Background-only. Never expose the return value of this function outside the
 * background context. A record the device key cannot open (lost key,
 * tampering) is deleted and reported absent; if the key store itself is
 * unavailable the record is kept and also reported absent.
 */
export async function getOpenAICredential(key: DeviceKey = deviceKey): Promise<OpenAICredential | null> {
  let raw: unknown;
  try { raw = await sealLegacyOpenAICredential(key); }
  catch { return null; }
  if (!isValidCredential(raw)) {
    if (raw !== null) await openaiCredentialItem.removeValue();
    return null;
  }
  let apiKey: string | null;
  try { apiKey = await key.open(raw, OPENAI_CREDENTIAL_CONTEXT); }
  catch { return null; }
  if (apiKey) return { apiKey, updatedAt: raw.updatedAt };
  await openaiCredentialItem.removeValue();
  return null;
}

export async function saveOpenAICredential(apiKey: string, key: DeviceKey = deviceKey): Promise<void> {
  const sealed = await key.seal(apiKey, OPENAI_CREDENTIAL_CONTEXT);
  await openaiCredentialItem.setValue({ version: 2, ...sealed, updatedAt: Date.now() });
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
export async function getChatGPTCredential(): Promise<ChatGPTCredentialV2 | null> {
  const raw = await deleteLegacyChatGPTCredential();
  if (raw?.version === 2 && typeof raw.iv === "string" && raw.iv.length === 16 && typeof raw.ciphertext === "string" &&
    raw.ciphertext.length > 0 && raw.ciphertext.length < 200_000 && Array.isArray(raw.models) &&
    raw.models.length > 0 && raw.models.length <= 200 && raw.models.every((model) =>
      model && typeof model.id === "string" && /^[\w.:-]{1,200}$/.test(model.id) &&
      typeof model.name === "string" && model.name.length <= 200 && Array.isArray(model.reasoningEfforts) &&
      model.reasoningEfforts.length > 0 && model.reasoningEfforts.every(isReasoningEffort) &&
      isReasoningEffort(model.defaultReasoningEffort) && model.reasoningEfforts.includes(model.defaultReasoningEffort))) return raw;
  if (raw !== null) await chatgptCredentialItem.removeValue();
  return null;
}

export async function saveChatGPTCredential(credential: ChatGPTCredentialV2): Promise<void> {
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

export async function deleteChatGPTRegistration(): Promise<void> {
  await chatgptRegistrationItem.removeValue();
}

export async function hasChatGPTSignInNotice(): Promise<boolean> {
  const raw = await chatgptSignInNoticeItem.getValue();
  if (raw?.version === 1 && typeof raw.createdAt === "number") return true;
  if (raw !== null) await chatgptSignInNoticeItem.removeValue();
  return false;
}

export async function clearChatGPTSignInNotice(): Promise<void> {
  await chatgptSignInNoticeItem.removeValue();
}

// ---------------------------------------------------------------------------
// Credential migration — PIN removal and device-key encryption.
// ---------------------------------------------------------------------------

/** Re-encrypts a v1 plaintext API key in place; returns the current raw record. Rejects if the device key is unavailable. */
async function sealLegacyOpenAICredential(key: DeviceKey): Promise<unknown> {
  const raw: unknown = await openaiCredentialItem.getValue();
  const legacy = raw as { version?: unknown; apiKey?: unknown; updatedAt?: unknown } | null;
  if (legacy?.version !== 1 || typeof legacy.apiKey !== "string" || !legacy.apiKey) return raw;
  const sealed = await key.seal(legacy.apiKey, OPENAI_CREDENTIAL_CONTEXT);
  const record: OpenAICredentialV2 = { version: 2, ...sealed, updatedAt: typeof legacy.updatedAt === "number" ? legacy.updatedAt : Date.now() };
  await openaiCredentialItem.setValue(record);
  return record;
}

/**
 * Deletes a v1 PIN-wrapped ChatGPT credential without migrating it and flags
 * the one-time sign-in notice; returns the current raw record otherwise.
 */
async function deleteLegacyChatGPTCredential(): Promise<ChatGPTCredentialV2 | null> {
  const raw = await chatgptCredentialItem.getValue();
  if ((raw as { version?: unknown } | null)?.version !== 1) return raw;
  await chatgptCredentialItem.removeValue();
  await chatgptSignInNoticeItem.setValue({ version: 1, createdAt: Date.now() });
  return null;
}

/**
 * Idempotent startup migration. The getters apply the same upgrades lazily,
 * so a credential read racing startup never discards a legacy record. If the
 * device key is unavailable, a plaintext key stays put until the next start.
 */
export async function migrateCredentials(key: DeviceKey = deviceKey): Promise<void> {
  try { await sealLegacyOpenAICredential(key); }
  catch { console.warn("[bside] Could not encrypt the saved API key; will retry at next startup."); }
  await deleteLegacyChatGPTCredential();
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
