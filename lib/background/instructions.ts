import { isCustomInstructionsText, isSiteNote, MAX_SITE_NOTES, type SiteNote } from "@/lib/domain/instructions";
import { isInstructionsRequest, isSiteNotesRequest } from "@/lib/protocol";
import type { InstructionsRequest, InstructionsResponse, NormalizedError, SiteNotesRequest, SiteNotesResponse } from "@/lib/protocol";
import { getCustomInstructions, getSiteNotes, saveCustomInstructions, saveSiteNotes } from "@/lib/storage";

/**
 * Background-owned custom instructions and site notes. Options requests are
 * the only writers, plus the sidebar's single-note `siteNote.save`; every
 * write is revalidated here and serialized with the others.
 */

let mutations: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const operation = mutations.then(task);
  mutations = operation.then(() => undefined, () => undefined);
  return operation;
}

const invalid = (message: string): NormalizedError => ({ code: "INVALID_REQUEST", message, retryable: false, phase: "setup" });
const storageFailure = (what: string): NormalizedError => ({ code: "PROTOCOL_ERROR", message: `${what} could not be read or saved. Try again.`, retryable: true, phase: "persistence" });

/** A safe, user-facing reason a site note was refused. */
class SiteNoteError extends Error {}

/** The run-start snapshot: instructions for the system prompt and every site note for matching. */
export function readInstructions(): Promise<{ instructions: string; siteNotes: SiteNote[] }> {
  return serialized(async () => ({ instructions: await getCustomInstructions(), siteNotes: await getSiteNotes() }));
}

export function handleInstructionsRequest(request: InstructionsRequest): Promise<InstructionsResponse> {
  return serialized(async (): Promise<InstructionsResponse> => {
    if (!isInstructionsRequest(request) || (request.type === "instructions.save" && !isCustomInstructionsText(request.text))) {
      return { v: 1, id: request.id, ok: false, error: invalid("Custom instructions must be 2,000 characters or fewer.") };
    }
    try {
      if (request.type === "instructions.save") await saveCustomInstructions(request.text);
      return { v: 1, id: request.id, ok: true, text: await getCustomInstructions() };
    } catch {
      return { v: 1, id: request.id, ok: false, error: storageFailure("Custom instructions") };
    }
  });
}

/** Adds `note`, or replaces the note with its origin in place. Throws a safe message when the note or the limit is invalid. */
async function upsertSiteNote(note: SiteNote): Promise<SiteNote[]> {
  if (!isSiteNote(note)) throw new SiteNoteError("Invalid site note. Use an http(s) site and 1–1,000 characters.");
  const notes = await getSiteNotes();
  const saved = { origin: note.origin, includeSubdomains: note.includeSubdomains, text: note.text };
  const index = notes.findIndex((other) => other.origin === note.origin);
  if (index >= 0) notes[index] = saved;
  else if (notes.length >= MAX_SITE_NOTES) throw new SiteNoteError(`Up to ${MAX_SITE_NOTES} site notes can be saved. Delete one in Settings → Site notes first.`);
  else notes.push(saved);
  await saveSiteNotes(notes);
  return notes;
}

export function handleSiteNotesRequest(request: SiteNotesRequest): Promise<SiteNotesResponse> {
  return serialized(async (): Promise<SiteNotesResponse> => {
    const { id } = request;
    if (!isSiteNotesRequest(request)) return { v: 1, id, ok: false, error: invalid("Invalid site note. Use an http(s) site and 1–1,000 characters.") };
    try {
      if (request.type === "siteNotes.save") return { v: 1, id: request.id, ok: true, notes: await upsertSiteNote(request.note) };
      const notes = await getSiteNotes();
      if (request.type === "siteNotes.delete") {
        const kept = notes.filter((note) => note.origin !== request.origin);
        await saveSiteNotes(kept);
        return { v: 1, id: request.id, ok: true, notes: kept };
      }
      return { v: 1, id: request.id, ok: true, notes };
    } catch (error) {
      return { v: 1, id: request.id, ok: false, error: error instanceof SiteNoteError ? invalid(error.message) : storageFailure("Site notes") };
    }
  });
}

/** The sidebar's "Remember something about this site". Returns the saved note, or a safe error message. */
export function saveSiteNoteFromSidebar(note: SiteNote): Promise<{ note: SiteNote; error: null } | { note: null; error: string }> {
  return serialized(async () => {
    try {
      const notes = await upsertSiteNote(note);
      return { note: notes.find((other) => other.origin === note.origin)!, error: null };
    } catch (error) {
      return { note: null, error: error instanceof SiteNoteError ? error.message : "The site note could not be saved. Try again." };
    }
  });
}
