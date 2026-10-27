import { MAX_MEMORIES, MemoryError, memoryDraftProblem, memoryPath, renderMemoryIndex, sortMemories, type MemoryChange, type MemoryDraft, type MemoryEntry } from "@/lib/domain/memory";
import { getMemorySettings, loadMemories, removeAllMemories, removeMemory, saveMemory, saveMemorySettings, type MemorySlot } from "@/lib/storage";
import { isMemoryRequest, type MemoryRequest, type MemoryResponse, type NormalizedError } from "@/lib/protocol";
import type { MemoryAccess } from "@/lib/background/browser-program";

/**
 * Background-owned agent memory. Runs write through `/memory` with the run's
 * provenance; the options page browses, edits, deletes, and forgets; the
 * sidebar can only undo a run's recent change. Every change is revalidated
 * here (the secret check included) and serialized with the others.
 */

let mutations: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const operation = mutations.then(task);
  mutations = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Who made a change: a run's changes carry its session, run, and whether it had read untrusted content. */
export interface MemorySource {
  sessionId: string;
  runId: string;
  tainted: boolean;
}

/**
 * Recent changes runs made, newest last, so the sidebar can undo them. In
 * memory only: after a restart, a change can no longer be undone (edit the
 * entry in Settings instead), and no copy of a forgotten entry survives.
 */
interface JournalEntry {
  id: string;
  name: string;
  before: MemoryEntry | null;
  after: MemoryEntry | null;
}

const UNDO_JOURNAL_SIZE = 64;
let journal: JournalEntry[] = [];

function recordChange(op: MemoryChange["op"], name: string, before: MemoryEntry | null, after: MemoryEntry | null, tainted: boolean): MemoryChange {
  const id = crypto.randomUUID();
  journal.push({ id, name, before, after });
  if (journal.length > UNDO_JOURNAL_SIZE) journal.shift();
  return { id, op, name, tainted };
}

function freeSlot(slots: readonly MemorySlot[]): number | null {
  const used = new Set(slots.map((slot) => slot.slot));
  return Array.from({ length: MAX_MEMORIES }, (_, n) => n).find((n) => !used.has(n)) ?? null;
}

async function persist(write: () => Promise<void>): Promise<void> {
  try { await write(); }
  catch { throw new MemoryError("Could not save the memory change; nothing was changed. Retry once."); }
}

/** Every entry, most recently updated first. */
export function listMemories(): Promise<MemoryEntry[]> {
  return serialized(async () => sortMemories((await loadMemories()).map((slot) => slot.entry)));
}

/** The index line block for a run's current user turn, from memory and the write policy as they are now. */
export function readMemoryIndex(): Promise<string | null> {
  return serialized(async () => renderMemoryIndex((await loadMemories()).map((slot) => slot.entry), (await getMemorySettings()).writes));
}

/** Saves or replaces one entry from a run. Throws a `MemoryError`. */
export function writeMemory(draft: MemoryDraft, source: MemorySource, now = Date.now()): Promise<MemoryChange> {
  return serialized(async () => {
    const problem = memoryDraftProblem(draft);
    if (problem) throw new MemoryError(problem);
    const slots = await loadMemories();
    const existing = slots.find((slot) => slot.entry.name === draft.name);
    const slot = existing?.slot ?? freeSlot(slots);
    if (slot === null) throw new MemoryError(`Memory is full (${MAX_MEMORIES} entries). Remove one that is no longer useful first.`, true);
    const entry: MemoryEntry = {
      name: draft.name, description: draft.description, body: draft.body, createdAt: existing?.entry.createdAt ?? now,
      provenance: { by: "agent", sessionId: source.sessionId, runId: source.runId, at: now, tainted: source.tainted },
    };
    await persist(() => saveMemory({ slot, entry }));
    return recordChange("write", draft.name, existing?.entry ?? null, entry, source.tainted);
  });
}

/** Removes one entry for a run. Throws a `MemoryError` if it does not exist. */
export function forgetMemory(name: string, source: MemorySource): Promise<MemoryChange> {
  return serialized(async () => {
    const existing = (await loadMemories()).find((slot) => slot.entry.name === name);
    if (!existing) throw new MemoryError(`${memoryPath(name)} does not exist. List memories with fs.list("/memory").`);
    await persist(() => removeMemory(existing.slot));
    return recordChange("remove", name, existing.entry, null, source.tainted);
  });
}

/**
 * The sidebar's Undo: reverts the given run changes, newest first. A change
 * is reverted only while its entry is still exactly as that change left it,
 * so Undo never overwrites a later edit. Returns the ids undone and a safe
 * message for any that were not.
 */
export function undoMemoryChanges(ids: readonly string[]): Promise<{ undone: string[]; error: string | null }> {
  return serialized(async () => {
    const wanted = new Set(ids);
    const targets = journal.filter((change) => wanted.has(change.id)).toReversed();
    const undone: string[] = [];
    let changedSince = 0;
    let failed = false;
    for (const change of targets) {
      const slots = await loadMemories();
      const current = slots.find((slot) => slot.entry.name === change.name);
      const slot = current?.slot ?? freeSlot(slots);
      if (JSON.stringify(current?.entry ?? null) !== JSON.stringify(change.after) || slot === null) {
        changedSince++;
        continue;
      }
      try {
        if (change.before) await saveMemory({ slot, entry: change.before });
        else await removeMemory(slot);
      } catch {
        failed = true;
        break;
      }
      journal = journal.filter((other) => other !== change);
      undone.push(change.id);
    }
    const expired = ids.length - targets.length;
    const error = failed ? "The memory change could not be undone. Try again."
      : changedSince ? `${changedSince === 1 ? "A memory has" : `${changedSince} memories have`} changed since, so ${changedSince === 1 ? "it was" : "they were"} left as ${changedSince === 1 ? "it is" : "they are"}. Edit it in Settings → Memory.`
      : expired ? "This change can no longer be undone here. Edit the memory in Settings → Memory."
      : null;
    return { undone, error };
  });
}

/** "Forget everything": deletes every entry and the undo journal. */
export function forgetAllMemories(): Promise<void> {
  return serialized(async () => {
    await removeAllMemories();
    journal = [];
  });
}

/** One run's `/memory`: its changes carry the run's session and id; the write policy is read at each change. */
export function runMemory(sessionId: string, runId: string): MemoryAccess {
  return {
    list: listMemories,
    policy: async () => (await getMemorySettings()).writes,
    write: (draft, tainted) => writeMemory(draft, { sessionId, runId, tainted }),
    remove: (name, tainted) => forgetMemory(name, { sessionId, runId, tainted }),
  };
}

const invalid = (message: string): NormalizedError => ({ code: "INVALID_REQUEST", message, retryable: false, phase: "setup" });

/** The options page's Memory requests: browse, edit, delete, forget everything, and the write policy. */
export function handleMemoryRequest(request: MemoryRequest): Promise<MemoryResponse> {
  return serialized(async (): Promise<MemoryResponse> => {
    const { id } = request;
    if (!isMemoryRequest(request)) return { v: 1, id, ok: false, error: invalid("Invalid memory request.") };
    try {
      if (request.type === "memory.save") {
        const problem = memoryDraftProblem(request.entry);
        if (problem) return { v: 1, id, ok: false, error: invalid(problem) };
        const existing = (await loadMemories()).find((slot) => slot.entry.name === request.entry.name);
        if (!existing) return { v: 1, id, ok: false, error: invalid("That memory no longer exists.") };
        const { description, body } = request.entry;
        await saveMemory({ slot: existing.slot, entry: { ...existing.entry, description, body, provenance: { by: "user", at: Date.now() } } });
      } else if (request.type === "memory.delete") {
        const existing = (await loadMemories()).find((slot) => slot.entry.name === request.name);
        if (existing) await removeMemory(existing.slot);
      } else if (request.type === "memory.forgetAll") {
        await removeAllMemories();
        journal = [];
      } else if (request.type === "memory.settings.save") {
        await saveMemorySettings(request.settings);
      }
      return { v: 1, id, ok: true, entries: sortMemories((await loadMemories()).map((slot) => slot.entry)), settings: await getMemorySettings() };
    } catch {
      return { v: 1, id, ok: false, error: { code: "PROTOCOL_ERROR", message: "Memory could not be read or saved. Try again.", retryable: true, phase: "persistence" } };
    }
  });
}
