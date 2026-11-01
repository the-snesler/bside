/**
 * Files the user attached in a sidebar and has not sent yet: held in
 * background memory only, each under an opaque random id bound to the
 * sidebar Port that prepared it and the chat it was prepared for, like
 * `PreparedMcpContent`. A send claims its ids atomically; the runtime writes
 * the files to the chat's `/workspace/uploads/` and commits the claim once
 * the message is persisted, or releases it (the files stay pending) when the
 * send fails. A closed Port's pending files are dropped, and a background
 * restart loses them all.
 */

import { ATTACHMENT_LIMITS, attachmentName, detectFileType, type PreparedAttachmentV1 } from "@/lib/domain/attachments";
import { base64ToBytes } from "@/lib/domain/pdf";
import { base64Bytes, WORKSPACE_MAX_UPLOAD_BYTES } from "@/lib/validation";
import type { UploadInput } from "./browser-program";

/** A refused preparation or claim; its message is safe to show the user. */
export class AttachmentError extends Error {}

/** The files a send claimed, as `ScratchFiles.attach` takes them, in the order the send named them. */
export interface AttachmentClaim {
  uploads: UploadInput[];
  /** Drops the claimed files from the pending set and tells their sidebar (once); call after the message is persisted. */
  commit(): void;
  /** Makes them pending again unless committed (dropped instead if their sidebar has closed). */
  release(): void;
}

interface Pending {
  id: string;
  sessionId: string;
  owner: object;
  upload: UploadInput;
  claimed: boolean;
}

const MAX_BASE64_CHARS = Math.ceil(WORKSPACE_MAX_UPLOAD_BYTES / 3) * 4;

export class PreparedAttachments {
  #items = new Map<string, Pending>();
  #releasedOwners = new WeakSet<object>();

  /**
   * Checks and holds one file: `data` canonical base64 of 1 to 10 MB, its
   * name cleaned (`attachmentName`), its type decided from its bytes
   * (`detectFileType`), within the pending limits. Throws `AttachmentError`.
   */
  prepare(input: { sessionId: string; name: string; mimeType: string; data: string }, owner: object): PreparedAttachmentV1 {
    if (this.#releasedOwners.has(owner)) throw new AttachmentError("The sidebar disconnected. Attach the file again.");
    if (input.data.length > MAX_BASE64_CHARS) throw new AttachmentError(`${attachmentName(input.name)} is larger than ${WORKSPACE_MAX_UPLOAD_BYTES / 1_000_000} MB.`);
    const bytes = base64Bytes(input.data);
    if (bytes === null) throw new AttachmentError("The file could not be read. Try attaching it again.");
    if (bytes === 0) throw new AttachmentError(`${attachmentName(input.name)} is empty.`);
    if (bytes > WORKSPACE_MAX_UPLOAD_BYTES) throw new AttachmentError(`${attachmentName(input.name)} is larger than ${WORKSPACE_MAX_UPLOAD_BYTES / 1_000_000} MB.`);
    const own = [...this.#items.values()].filter((item) => item.owner === owner && item.sessionId === input.sessionId);
    if (own.length >= ATTACHMENT_LIMITS.pendingPerOwner) throw new AttachmentError(`A message can carry up to ${ATTACHMENT_LIMITS.perMessage} files. Remove one before adding another.`);
    const pendingBytes = [...this.#items.values()].reduce((sum, item) => sum + item.upload.bytes, 0);
    if (this.#items.size >= ATTACHMENT_LIMITS.pendingTotal || pendingBytes + bytes > ATTACHMENT_LIMITS.pendingBytes) {
      throw new AttachmentError("Too many files are waiting to be sent. Send or remove some first.");
    }
    let decoded: Uint8Array;
    try { decoded = base64ToBytes(input.data); }
    catch { throw new AttachmentError("The file could not be read. Try attaching it again."); }
    const { mimeType, text } = detectFileType(decoded, input.mimeType);
    const id = crypto.randomUUID();
    const upload: UploadInput = { name: attachmentName(input.name), mimeType, data: input.data, bytes, text };
    this.#items.set(id, { id, sessionId: input.sessionId, owner, upload, claimed: false });
    return { id, name: upload.name, mimeType, bytes, text };
  }

  /** Removes the owner's unclaimed pending files among `ids`; others' and unknown ids are ignored. */
  dismiss(ids: readonly string[], sessionId: string, owner: object): void {
    for (const id of ids) {
      const item = this.#items.get(id);
      if (item?.owner === owner && item.sessionId === sessionId && !item.claimed) this.#items.delete(id);
    }
  }

  /** The owner's Port closed: its unclaimed files go now, claimed ones when their send ends. */
  releaseOwner(owner: object): void {
    this.#releasedOwners.add(owner);
    for (const [id, item] of this.#items) if (item.owner === owner && !item.claimed) this.#items.delete(id);
  }

  /**
   * Claims `ids` for one send in `sessionId` by `owner`: every id must be the
   * owner's, prepared for that chat, pending, and named once, at most
   * `ATTACHMENT_LIMITS.perMessage`. All or nothing; throws `AttachmentError`.
   */
  claim(ids: readonly string[], sessionId: string, owner: object, onCommit: () => void): AttachmentClaim {
    const items = ids.map((id) => this.#items.get(id));
    if (this.#releasedOwners.has(owner) || !ids.length || ids.length > ATTACHMENT_LIMITS.perMessage || new Set(ids).size !== ids.length ||
      items.some((item) => !item || item.owner !== owner || item.claimed || item.sessionId !== sessionId)) {
      throw new AttachmentError("An attached file is no longer available in this sidebar and chat. Attach it again.");
    }
    const claimed = items as Pending[];
    for (const item of claimed) item.claimed = true;
    let settled = false;
    return {
      uploads: claimed.map((item) => ({ ...item.upload })),
      commit: () => {
        if (settled) return;
        settled = true;
        for (const item of claimed) this.#items.delete(item.id);
        onCommit();
      },
      release: () => {
        if (settled) return;
        settled = true;
        for (const item of claimed) {
          item.claimed = false;
          if (this.#releasedOwners.has(owner)) this.#items.delete(item.id);
        }
      },
    };
  }
}
