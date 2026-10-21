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
import type { Conversation, ConversationIndexV1, ConversationItem, ConversationSummary, HistorySettingsV1, MessageQueueV1, QueuedMessage } from "@/lib/domain/conversation";
import { COMPACTION_SUMMARY_MAX_CHARS, HISTORY_RETENTIONS, isTurnStart, MAX_QUEUED_MESSAGES, titleFromPrompt } from "@/lib/domain/conversation";
import { digestFromItems, isValidRunDigest } from "@/lib/domain/run-digest";
import { addRunUsage, EMPTY_USAGE, hasTokens, isValidRunUsage, isValidUsageTotals, type RunUsageV1 } from "@/lib/domain/usage";
import { DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "@/lib/providers/openai-models";
import { deviceKey, type DeviceKey } from "@/lib/background/device-key";
import { isSessionId, isWorkspacePath, validatePromptText, WORKSPACE_MAX_FILE_CHARS, WORKSPACE_MAX_FILES } from "@/lib/validation";
import type { ScratchFileEntry, ScratchStore } from "@/lib/background/browser-program";

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

export interface RunCheckpointV2 {
  version: 2;
  runId: string;
  /** The run's session; recovery appends the interrupted marker there. */
  sessionId: string;
  status: RunStatus;
  partialAssistantText: string;
  /** The run's usage so far; recovery persists it for an interrupted run. */
  usage: RunUsageV1 | null;
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

const runCheckpointItem = storage.defineItem<RunCheckpointV2>("local:runCheckpoint", {
  version: 2,
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
    if (v.role === "user") return (v.context === null || typeof v.context === "object") && (v.delivery === undefined || v.delivery === "steer");
    return v.role === "assistant";
  }
  if (v.kind === "tool-call") return typeof v.call === "object" && v.call !== null;
  if (v.kind === "tool-result") return typeof v.callId === "string" && typeof v.result === "object" && v.result !== null;
  if (v.kind === "run-digest") return isValidRunDigest(v.digest);
  if (v.kind === "run-usage") return isValidRunUsage(v.usage);
  if (v.kind === "compaction") {
    return typeof v.summary === "string" && v.summary.length <= COMPACTION_SUMMARY_MAX_CHARS && typeof v.firstKeptItemId === "string" &&
      Number.isSafeInteger(v.tokensBefore) && (v.tokensBefore as number) >= 0;
  }
  return false;
}

function isValidRunCheckpoint(value: unknown): value is RunCheckpointV2 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 2 &&
    typeof v.runId === "string" &&
    isSessionId(v.sessionId) &&
    (RUN_STATUSES as readonly string[]).includes(v.status as string) &&
    typeof v.partialAssistantText === "string" &&
    (v.usage === null || isValidRunUsage(v.usage)) &&
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

const DEFAULT_HISTORY_SETTINGS: HistorySettingsV1 = { version: 1, retention: "forever" };

const historySettingsItem = storage.defineItem<HistorySettingsV1>("local:historySettings", { version: 1 });

export async function getHistorySettings(): Promise<HistorySettingsV1> {
  const raw: unknown = await historySettingsItem.getValue();
  const settings = raw as { version?: unknown; retention?: unknown } | null;
  if (settings?.version === 1 && (HISTORY_RETENTIONS as readonly unknown[]).includes(settings.retention)) return settings as HistorySettingsV1;
  if (raw !== null) await historySettingsItem.removeValue();
  return DEFAULT_HISTORY_SETTINGS;
}

export async function saveHistorySettings(settings: HistorySettingsV1): Promise<void> {
  await historySettingsItem.setValue(settings);
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
  // Notice first: an interruption between the writes must not drop the
  // connection silently; the next read deletes the record again.
  await chatgptSignInNoticeItem.setValue({ version: 1, createdAt: Date.now() });
  await chatgptCredentialItem.removeValue();
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
// Conversations — one index, plus a record and fixed-size item chunks per session.
//
//   local:conversationIndex            ConversationIndexV1 (listing data for every session)
//   local:conversation:<id>            ConversationRecordV2 (item count; the commit point for appends)
//   local:conversation:<id>:items:<n>  ConversationChunkV1 (items n*CHUNK .. n*CHUNK+CHUNK-1)
//   local:openConversation             OpenConversationV1 (the session the sidebar shows)
//   local:workspace:<id>:<slot>        WorkspaceFileV1 (one /workspace file of the session; see below)
//   local:queue:<id>                   MessageQueueV1 (messages typed while a run worked, until delivered)
//
// An append writes only the tail chunk and the session record, in one
// `storage.local.set`, so its cost does not grow with history. The index is
// rewritten only by session-level changes and `touchSession` at turn boundaries,
// so its item count and `updatedAt` may lag the record mid-run.
// ---------------------------------------------------------------------------

/** Items per chunk; bounds the bytes an append rewrites. */
export const CONVERSATION_CHUNK_SIZE = 32;
/** Id of the single pre-sessions conversation; it keeps the id as the first session. */
const LEGACY_SESSION_ID = "default";

export interface ConversationRecordV2 {
  version: 2;
  id: string;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
}

export interface ConversationChunkV1 {
  version: 1;
  items: ConversationItem[];
}

export interface OpenConversationV1 {
  version: 1;
  id: string;
}

/** The pre-sessions single-thread record, read only by the migration. */
interface LegacyConversationRecordV1 {
  version: 1;
  id: "default";
  items: ConversationItem[];
  updatedAt: number;
}

const conversationIndexItem = storage.defineItem<ConversationIndexV1>("local:conversationIndex", { version: 1 });
const openConversationItem = storage.defineItem<OpenConversationV1>("local:openConversation", { version: 1 });
const legacyConversationItem = storage.defineItem<LegacyConversationRecordV1>("local:conversation", { version: 1 });

const recordKey = (id: string) => `local:conversation:${id}` as const;
const chunkKey = (id: string, n: number) => `local:conversation:${id}:items:${n}` as const;
const chunkKeys = (id: string, itemCount: number) =>
  Array.from({ length: Math.ceil(itemCount / CONVERSATION_CHUNK_SIZE) }, (_, n) => chunkKey(id, n));

let conversationLock: Promise<unknown> = Promise.resolve();

/** Serializes every conversation read-modify-write. Exported functions take it once; the helpers they call never do. */
function withConversationLock<T>(task: () => Promise<T>): Promise<T> {
  const result = conversationLock.then(task);
  conversationLock = result.catch(() => {});
  return result;
}

function isValidSummary(value: unknown): value is ConversationSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isSessionId(v.id) && typeof v.title === "string" && v.title.length <= 200 &&
    (v.titleSource === "prompt" || v.titleSource === "user") && Number.isFinite(v.createdAt) && Number.isFinite(v.updatedAt) &&
    typeof v.pinned === "boolean" && Number.isSafeInteger(v.itemCount) && (v.itemCount as number) >= 0 &&
    (v.lastModelId === null || (typeof v.lastModelId === "string" && v.lastModelId.length <= 200)) && isValidUsageTotals(v.usage);
}

/** An index entry as stored; one written before usage totals existed, or with corrupt totals, counts from zero. */
function readSummary(value: unknown): ConversationSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  const summary = isValidUsageTotals(entry.usage) ? entry : { ...entry, usage: { ...EMPTY_USAGE } };
  return isValidSummary(summary) ? summary : null;
}

function isValidRecord(value: unknown, id: string): value is ConversationRecordV2 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 2 && v.id === id && Number.isFinite(v.createdAt) && Number.isFinite(v.updatedAt) &&
    Number.isSafeInteger(v.itemCount) && (v.itemCount as number) >= 0;
}

function isValidChunk(value: unknown): value is ConversationChunkV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.items) && v.items.length <= CONVERSATION_CHUNK_SIZE && v.items.every(isValidConversationItem);
}

function isValidLegacyConversation(value: unknown): value is LegacyConversationRecordV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && v.id === LEGACY_SESSION_ID && Array.isArray(v.items) && v.items.every(isValidConversationItem) &&
    typeof v.updatedAt === "number";
}

function firstPromptTitle(items: readonly ConversationItem[]): string {
  const prompt = items.find(isTurnStart);
  return prompt ? titleFromPrompt(prompt.text) : "";
}

/** Pinned first, then most recently updated; ties go to the later-created session. */
function sortSessions(sessions: readonly ConversationSummary[]): ConversationSummary[] {
  return [...sessions].reverse().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

/** Reads the index, dropping invalid or duplicate entries; a corrupt index is rebuilt from the session records. */
async function readIndex(): Promise<ConversationSummary[]> {
  const raw: unknown = await conversationIndexItem.getValue();
  if (raw === null) return [];
  const index = raw as { version?: unknown; sessions?: unknown };
  if (index.version === 1 && Array.isArray(index.sessions)) {
    const all = (index.sessions as unknown[]).map(readSummary);
    const sessions = all.filter((entry, i): entry is ConversationSummary =>
      entry !== null && all.findIndex((other) => other?.id === entry.id) === i);
    if (sessions.length !== all.length) await writeIndex(sessions);
    return sessions;
  }
  const sessions = await rebuildIndex();
  await writeIndex(sessions);
  return sessions;
}

async function writeIndex(sessions: ConversationSummary[]): Promise<void> {
  await conversationIndexItem.setValue({ version: 1, sessions });
}

/** Corruption recovery only: scans every stored key, so it is O(stored data). Pins and user titles are lost; usage totals are summed from the items. */
async function rebuildIndex(): Promise<ConversationSummary[]> {
  const all = await storage.snapshot("local");
  const sessions: ConversationSummary[] = [];
  for (const [key, value] of Object.entries(all)) {
    const id = /^conversation:([A-Za-z0-9_-]{1,64})$/.exec(key)?.[1];
    if (!id || !isValidRecord(value, id)) continue;
    const first = all[`conversation:${id}:items:0`];
    let usage = EMPTY_USAGE;
    for (const chunk of chunkKeys(id, value.itemCount).map((chunk) => all[chunk.slice("local:".length)])) {
      if (!isValidChunk(chunk)) break;
      for (const item of chunk.items) if (item.kind === "run-usage") usage = addRunUsage(usage, item.usage);
    }
    sessions.push({
      id, title: isValidChunk(first) ? firstPromptTitle(first.items) : "", titleSource: "prompt", createdAt: value.createdAt,
      updatedAt: value.updatedAt, pinned: false, itemCount: value.itemCount, lastModelId: null, usage: { ...usage },
    });
  }
  return sessions;
}

async function readRecord(id: string): Promise<ConversationRecordV2 | null> {
  const raw = await storage.getItem<unknown>(recordKey(id));
  return isValidRecord(raw, id) ? raw : null;
}

/**
 * Reads a session's items. Items past the record's count (a write the record
 * never committed) are ignored. A missing or corrupt chunk truncates history
 * there, and the record is repaired in place.
 */
async function readItems(record: ConversationRecordV2): Promise<ConversationItem[]> {
  const keys = chunkKeys(record.id, record.itemCount);
  if (keys.length === 0) return [];
  const chunks = await storage.getItems(keys);
  const items: ConversationItem[] = [];
  for (const [n, { value }] of chunks.entries()) {
    const expected = Math.min(CONVERSATION_CHUNK_SIZE, record.itemCount - n * CONVERSATION_CHUNK_SIZE);
    if (!isValidChunk(value) || value.items.length < expected) {
      await storage.setItem(recordKey(record.id), { ...record, itemCount: items.length });
      await storage.removeItems(keys.slice(n));
      break;
    }
    items.push(...value.items.slice(0, expected));
  }
  return items;
}

function newSummary(id: string, now: number): ConversationSummary {
  return { id, title: "", titleSource: "prompt", createdAt: now, updatedAt: now, pinned: false, itemCount: 0, lastModelId: null, usage: { ...EMPTY_USAGE } };
}

async function insertSession(sessions: ConversationSummary[]): Promise<ConversationSummary> {
  const now = Date.now();
  const summary = newSummary(crypto.randomUUID(), now);
  const record: ConversationRecordV2 = { version: 2, id: summary.id, createdAt: now, updatedAt: now, itemCount: 0 };
  await storage.setItems([
    { key: recordKey(summary.id), value: record },
    { item: conversationIndexItem, value: { version: 1, sessions: [...sessions, summary] } },
  ]);
  return summary;
}

/** Index entries sorted pinned first, then most recently updated first. */
export function listSessions(): Promise<ConversationSummary[]> {
  return withConversationLock(async () => sortSessions(await readIndex()));
}

/** The session materialized for display, or `null` if it is not in the index. */
export function getConversation(id: string): Promise<Conversation | null> {
  return withConversationLock(async () => {
    const summary = (await readIndex()).find((session) => session.id === id);
    if (!summary) return null;
    const record = await readRecord(id);
    if (!record) return { ...summary, itemCount: 0, items: [] };
    const items = await readItems(record);
    return { ...summary, updatedAt: record.updatedAt, itemCount: items.length, items };
  });
}

/** Creates an empty session; it is not opened. */
export function createSession(): Promise<ConversationSummary> {
  return withConversationLock(async () => insertSession(await readIndex()));
}

/**
 * Whether a session is an untouched new chat: no items, not pinned, no user
 * title. The record is read, so a lagging index count does not matter.
 */
export function isSessionUntouched(id: string): Promise<boolean> {
  return withConversationLock(async () => {
    const session = (await readIndex()).find((candidate) => candidate.id === id);
    return !session?.pinned && session?.titleSource !== "user" && ((await readRecord(id))?.itemCount ?? 0) === 0;
  });
}

/**
 * Appends one item, writing only the tail chunk and the record. Throws for a
 * session missing from the index. A corrupt tail chunk loses only its own items.
 */
export function appendConversationItem(id: string, item: ConversationItem): Promise<void> {
  return withConversationLock(async () => {
    let record = await readRecord(id);
    if (!record) {
      const summary = (await readIndex()).find((session) => session.id === id);
      if (!summary) throw new Error("Unknown session.");
      record = { version: 2, id, createdAt: summary.createdAt, updatedAt: summary.updatedAt, itemCount: 0 };
    }
    const n = Math.floor(record.itemCount / CONVERSATION_CHUNK_SIZE);
    const offset = record.itemCount - n * CONVERSATION_CHUNK_SIZE;
    let tail: ConversationItem[] = [];
    let itemCount = record.itemCount;
    if (offset > 0) {
      const raw = await storage.getItem<unknown>(chunkKey(id, n));
      if (isValidChunk(raw) && raw.items.length >= offset) tail = raw.items.slice(0, offset);
      else itemCount -= offset;
    }
    await storage.setItems([
      { key: chunkKey(id, n), value: { version: 1, items: [...tail, item] } satisfies ConversationChunkV1 },
      { key: recordKey(id), value: { ...record, itemCount: itemCount + 1, updatedAt: Date.now() } satisfies ConversationRecordV2 },
    ]);
  });
}

/**
 * Refreshes a session's index entry at a turn boundary: item count and
 * `updatedAt` from its record, the run's model, a title from the first
 * prompt unless the session already has one, and an ended run's usage added
 * to the running total.
 */
export function touchSession(id: string, turn: { prompt?: string; modelId?: string; usage?: RunUsageV1 } = {}): Promise<void> {
  return withConversationLock(async () => {
    const sessions = await readIndex();
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;
    const session = sessions[index]!;
    const record = await readRecord(id);
    sessions[index] = {
      ...session,
      itemCount: record?.itemCount ?? session.itemCount,
      updatedAt: record?.updatedAt ?? session.updatedAt,
      lastModelId: turn.modelId ?? session.lastModelId,
      usage: turn.usage ? addRunUsage(session.usage, turn.usage) : session.usage,
      title: session.titleSource === "prompt" && !session.title && turn.prompt ? titleFromPrompt(turn.prompt) : session.title,
    };
    await writeIndex(sessions);
  });
}

/** Renames (a user title, never auto-overwritten) and/or pins a session. Returns `null` for an unknown session. */
export function updateSession(id: string, patch: { title?: string; pinned?: boolean }): Promise<ConversationSummary | null> {
  return withConversationLock(async () => {
    const sessions = await readIndex();
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return null;
    const session: ConversationSummary = {
      ...sessions[index]!,
      ...(patch.title !== undefined ? { title: patch.title, titleSource: "user" as const } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    };
    sessions[index] = session;
    await writeIndex(sessions);
    return session;
  });
}

/** Deletes a session's items, record, scratch files, and message queue, then its index entry, and clears the open pointer if it pointed there. */
export function deleteSession(id: string): Promise<void> {
  return withConversationLock(async () => {
    const sessions = await readIndex();
    const entry = sessions.find((session) => session.id === id);
    const record = await readRecord(id);
    await storage.removeItems([recordKey(id), ...chunkKeys(id, Math.max(record?.itemCount ?? 0, entry?.itemCount ?? 0)), ...workspaceKeys(id), queueKey(id)]);
    if (entry) await writeIndex(sessions.filter((session) => session !== entry));
    if ((await openConversationItem.getValue())?.id === id) await openConversationItem.removeValue();
  });
}

/** Deletes several sessions' items, records, scratch files, and message queues, then their index entries in one write. Clears the open pointer if it pointed at one. */
async function removeSessions(sessions: ConversationSummary[], doomed: readonly ConversationSummary[]): Promise<void> {
  if (doomed.length === 0) return;
  const records = await Promise.all(doomed.map((session) => readRecord(session.id)));
  await storage.removeItems(doomed.flatMap((session, i) =>
    [recordKey(session.id), ...chunkKeys(session.id, Math.max(records[i]?.itemCount ?? 0, session.itemCount)), ...workspaceKeys(session.id), queueKey(session.id)]));
  const ids = new Set(doomed.map((session) => session.id));
  await writeIndex(sessions.filter((session) => !ids.has(session.id)));
  const open = await openConversationItem.getValue();
  if (open && ids.has(open.id)) await openConversationItem.removeValue();
}

/** Retention: deletes unpinned sessions last updated before `cutoff`, except `keep`. Returns the deleted ids. */
export function pruneSessions(cutoff: number, keep: readonly string[]): Promise<string[]> {
  return withConversationLock(async () => {
    const sessions = await readIndex();
    const doomed = sessions.filter((session) => !session.pinned && session.updatedAt < cutoff && !keep.includes(session.id));
    await removeSessions(sessions, doomed);
    return doomed.map((session) => session.id);
  });
}

/** Deletes every session except `keep`, pinned ones included. Returns the deleted ids. */
export function deleteAllSessions(keep: readonly string[]): Promise<string[]> {
  return withConversationLock(async () => {
    const sessions = await readIndex();
    const doomed = sessions.filter((session) => !keep.includes(session.id));
    await removeSessions(sessions, doomed);
    return doomed.map((session) => session.id);
  });
}

export async function getOpenSessionId(): Promise<string | null> {
  const raw = await openConversationItem.getValue();
  if (raw?.version === 1 && isSessionId(raw.id)) return raw.id;
  if (raw !== null) await openConversationItem.removeValue();
  return null;
}

export async function setOpenSessionId(id: string): Promise<void> {
  await openConversationItem.setValue({ version: 1, id });
}

/** Returns the open session, else opens the most recently updated one, else creates and opens an empty one. */
export function ensureOpenSession(): Promise<string> {
  return withConversationLock(async () => {
    const sessions = await readIndex();
    const open = await getOpenSessionId();
    if (open && sessions.some((session) => session.id === open)) return open;
    const recent = sessions.reduce<ConversationSummary | null>((best, session) => !best || session.updatedAt >= best.updatedAt ? session : best, null);
    const id = recent?.id ?? (await insertSession(sessions)).id;
    await setOpenSessionId(id);
    return id;
  });
}

/**
 * Idempotent startup migration of the pre-sessions `local:conversation`
 * record into the first session (keeping its id). The session's chunks,
 * record, and index entry are written in one `storage.local.set`; the legacy
 * record is removed only after the session reads back with the same items.
 * A malformed or empty legacy record is removed without creating a session.
 */
export async function migrateConversation(): Promise<void> {
  const raw: unknown = await legacyConversationItem.getValue();
  if (raw === null) return;
  if (!isValidLegacyConversation(raw) || raw.items.length === 0) {
    await legacyConversationItem.removeValue();
    return;
  }
  const legacy = raw;
  await withConversationLock(async () => {
    const sessions = await readIndex();
    const record = await readRecord(LEGACY_SESSION_ID);
    // A previous attempt that wrote the session but failed to remove the legacy record must not overwrite later items.
    if (!record || !sessions.some((session) => session.id === LEGACY_SESSION_ID) || record.itemCount < legacy.items.length) {
      const createdAt = legacy.items[0]!.at;
      const updatedAt = legacy.updatedAt || legacy.items.at(-1)!.at;
      const summary: ConversationSummary = {
        ...newSummary(LEGACY_SESSION_ID, createdAt), title: firstPromptTitle(legacy.items), updatedAt, itemCount: legacy.items.length,
      };
      const chunks = Array.from({ length: Math.ceil(legacy.items.length / CONVERSATION_CHUNK_SIZE) }, (_, n) => ({
        key: chunkKey(LEGACY_SESSION_ID, n),
        value: { version: 1, items: legacy.items.slice(n * CONVERSATION_CHUNK_SIZE, (n + 1) * CONVERSATION_CHUNK_SIZE) } satisfies ConversationChunkV1,
      }));
      await storage.setItems([
        ...chunks,
        { key: recordKey(LEGACY_SESSION_ID), value: { version: 2, id: LEGACY_SESSION_ID, createdAt, updatedAt, itemCount: legacy.items.length } satisfies ConversationRecordV2 },
        { item: conversationIndexItem, value: { version: 1, sessions: [...sessions.filter((session) => session.id !== LEGACY_SESSION_ID), summary] } },
      ]);
    }
    if (!(await getOpenSessionId())) await setOpenSessionId(LEGACY_SESSION_ID);
    const migrated = await readRecord(LEGACY_SESSION_ID);
    const items = migrated ? await readItems(migrated) : [];
    if (JSON.stringify(items.slice(0, legacy.items.length)) !== JSON.stringify(legacy.items) ||
      !(await readIndex()).some((session) => session.id === LEGACY_SESSION_ID)) {
      throw new Error("The conversation migration did not verify; the original record was kept.");
    }
  });
  await legacyConversationItem.removeValue();
}

// ---------------------------------------------------------------------------
// Workspace — each session's /workspace scratch files, one key per file slot.
//
// A session has WORKSPACE_MAX_FILES fixed slots, so writing, removing, or
// renaming a file touches one key of at most WORKSPACE_MAX_FILE_CHARS, never
// the whole workspace, and deleting a session removes a known key set without
// listing storage. The slot record carries its path; there is no separate
// manifest that could disagree with the files.
// ---------------------------------------------------------------------------

export interface WorkspaceFileV1 {
  version: 1;
  path: string;
  content: string;
}

const workspaceKey = (id: string, slot: number) => `local:workspace:${id}:${slot}` as const;
const workspaceKeys = (id: string) => Array.from({ length: WORKSPACE_MAX_FILES }, (_, slot) => workspaceKey(id, slot));

function isValidWorkspaceFile(value: unknown): value is WorkspaceFileV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && isWorkspacePath(v.path) && typeof v.content === "string" && v.content.length <= WORKSPACE_MAX_FILE_CHARS;
}

/** A session's scratch files by slot. Malformed slots and later duplicates of a path are deleted. */
export async function loadWorkspaceFiles(sessionId: string): Promise<ScratchFileEntry[]> {
  const slots = await storage.getItems(workspaceKeys(sessionId));
  const files: ScratchFileEntry[] = [];
  const invalid: (typeof slots)[number]["key"][] = [];
  for (const [slot, { key, value }] of slots.entries()) {
    if (value === null || value === undefined) continue;
    if (isValidWorkspaceFile(value) && !files.some((file) => file.path === value.path)) files.push({ slot, path: value.path, content: value.content });
    else invalid.push(key);
  }
  if (invalid.length > 0) await storage.removeItems(invalid);
  return files;
}

/** Persistence for one session's `/workspace`, used by its runs' programs. */
export function workspaceStore(sessionId: string): ScratchStore {
  return {
    load: () => loadWorkspaceFiles(sessionId),
    write: ({ slot, path, content }) => storage.setItem(workspaceKey(sessionId, slot), { version: 1, path, content } satisfies WorkspaceFileV1),
    remove: (slot) => storage.removeItem(workspaceKey(sessionId, slot)),
  };
}

// ---------------------------------------------------------------------------
// Message queue — each session's messages typed while a run was working.
// ---------------------------------------------------------------------------

const queueKey = (id: string) => `local:queue:${id}` as const;

function isValidQueuedMessage(value: unknown): value is QueuedMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 64 && (v.mode === "follow-up" || v.mode === "steer") &&
    typeof v.text === "string" && validatePromptText(v.text) === v.text && Number.isFinite(v.at);
}

/** A session's queued messages, oldest first. A malformed record is deleted and reads as empty. */
export async function loadMessageQueue(sessionId: string): Promise<QueuedMessage[]> {
  const raw = await storage.getItem<unknown>(queueKey(sessionId));
  const queue = raw as { version?: unknown; messages?: unknown } | null;
  if (queue?.version === 1 && Array.isArray(queue.messages) && queue.messages.length <= MAX_QUEUED_MESSAGES && queue.messages.every(isValidQueuedMessage)) {
    return queue.messages;
  }
  if (raw !== null) await storage.removeItem(queueKey(sessionId));
  return [];
}

/** Replaces a session's queue; an empty queue removes the record. */
export async function saveMessageQueue(sessionId: string, messages: readonly QueuedMessage[]): Promise<void> {
  if (messages.length === 0) await storage.removeItem(queueKey(sessionId));
  else await storage.setItem(queueKey(sessionId), { version: 1, messages: [...messages] } satisfies MessageQueueV1);
}

// ---------------------------------------------------------------------------
// Run checkpoint — run-local recovery marker, not the transcript itself.
// ---------------------------------------------------------------------------

export async function getRunCheckpoint(): Promise<RunCheckpointV2 | null> {
  const raw: unknown = await runCheckpointItem.getValue();
  if (isValidRunCheckpoint(raw)) return raw;
  // A pre-sessions checkpoint belonged to the legacy conversation.
  const legacy = { ...(raw as object), version: 2, sessionId: LEGACY_SESSION_ID, usage: null };
  if ((raw as { version?: unknown } | null)?.version === 1 && isValidRunCheckpoint(legacy)) return legacy;
  if (raw !== null) await runCheckpointItem.removeValue();
  return null;
}

export async function saveRunCheckpoint(checkpoint: RunCheckpointV2): Promise<void> {
  await runCheckpointItem.setValue(checkpoint);
}

export async function clearRunCheckpoint(): Promise<void> {
  await runCheckpointItem.removeValue();
}

const INTERRUPTED_SUFFIX ="\n\n[Interrupted: the extension restarted before this response finished.]";

/**
 * Startup recovery: a checkpoint left "running"/"awaiting-approval" means the
 * background died mid-run. Convert it into a visible interrupted assistant
 * message in the run's session rather than silently dropping it or claiming
 * stream resumption, followed by a digest of the calls it had started and
 * the usage it had checkpointed.
 * Returns the session a run was interrupted in, if any.
 */
export async function recoverInterruptedRun(): Promise<string | null> {
  const checkpoint = await getRunCheckpoint();
  if (!checkpoint) return null;
  if (checkpoint.status !== "running" && checkpoint.status !== "awaiting-approval") {
    await clearRunCheckpoint();
    return null;
  }
  if (!(await listSessions()).some((session) => session.id === checkpoint.sessionId)) {
    await clearRunCheckpoint();
    return null;
  }

  const text = checkpoint.partialAssistantText
    ? `${checkpoint.partialAssistantText}${INTERRUPTED_SUFFIX}`
    : INTERRUPTED_SUFFIX.trim();

  await appendConversationItem(checkpoint.sessionId, {
    id: `interrupted-${checkpoint.runId}`,
    kind: "message",
    role: "assistant",
    text,
    at: Date.now(),
  });
  // The tool ledger died with the background; the persisted calls still say what the run did.
  const digest = digestFromItems((await getConversation(checkpoint.sessionId))?.items ?? []);
  if (digest) await appendConversationItem(checkpoint.sessionId, { id: `digest-${checkpoint.runId}`, kind: "run-digest", digest, at: Date.now() });
  // Usage as of the last checkpoint; a response that ended after it is not counted.
  const usage = checkpoint.usage && hasTokens(checkpoint.usage) ? checkpoint.usage : undefined;
  if (usage) await appendConversationItem(checkpoint.sessionId, { id: `usage-${checkpoint.runId}`, kind: "run-usage", usage, at: Date.now() });
  await touchSession(checkpoint.sessionId, { usage });
  await clearRunCheckpoint();
  return checkpoint.sessionId;
}
