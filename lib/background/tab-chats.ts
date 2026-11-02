/**
 * Tab bindings: the chat each of the user's tabs shows in the sidebar. A tab
 * has at most one chat; a chat may have many tabs. Held in memory and
 * persisted on the tab itself as a versioned `sessions` tab value
 * (`CHAT_TAB_KEY`), which Firefox keeps across browser restarts, session
 * restore, and undo-close even though it reassigns tab ids. Agent tabs are
 * never bound here: they show their owning chat (see `WorkspaceState`).
 *
 * The runtime decides when a tab is bound (a send, a run's lease, an explicit
 * open) or unbound (New chat, its chat's deletion); this class keeps the map
 * and the tab values in step, one write at a time per tab. A failed write
 * leaves the value as it was: a stale one names a chat that no longer exists
 * and is dropped when the tab is next read, or one that the tab was rebound
 * from, which the next startup reads back as its binding.
 */

import type { ChatTabValueV1, TabController } from "@/lib/background/tab-controller";

/** The tab-value calls this needs; `TabController` provides them. */
export type ChatTabValues = Pick<TabController, "chatTabValue" | "setChatTabValue" | "removeChatTabValue">;

export class TabBindings {
  #values: () => ChatTabValues;
  #bound = new Map<number, string>();
  /** Each tab's last queued value write; the next one waits for it. */
  #writes = new Map<number, Promise<void>>();

  constructor(values: () => ChatTabValues) {
    this.#values = values;
  }

  /** The chat the tab is bound to, if any. */
  sessionOf(tabId: number): string | undefined {
    return this.#bound.get(tabId);
  }

  /** Binds `tabId` to `sessionId`, replacing any other binding; returns whether it changed. */
  bind(tabId: number, sessionId: string): boolean {
    if (this.#bound.get(tabId) === sessionId) return false;
    this.#bound.set(tabId, sessionId);
    const value: ChatTabValueV1 = { v: 1, sessionId };
    this.#write(tabId, (values) => values.setChatTabValue(tabId, value));
    return true;
  }

  /** Removes the tab's binding and its tab value; a tab with none is left alone. */
  unbind(tabId: number): void {
    if (!this.#bound.delete(tabId)) return;
    this.#write(tabId, (values) => values.removeChatTabValue(tabId));
  }

  /** The tab closed: its binding ends, and its value goes with it (Firefox brings it back with an undo-close). */
  forget(tabId: number): void {
    this.#bound.delete(tabId);
  }

  /** Every chat in `ids` was deleted: its tabs are unbound. */
  dropSessions(ids: Iterable<string>): void {
    const gone = new Set(ids);
    for (const [tabId, sessionId] of [...this.#bound]) if (gone.has(sessionId)) this.unbind(tabId);
  }

  /**
   * Reads a tab's value (at startup, or for a tab Firefox restored later)
   * and binds the tab to the chat it names, if that chat still exists. A
   * value naming a chat that no longer exists, or a malformed one, is
   * removed. Returns the chat the tab is now bound to.
   */
  async restore(tabId: number, exists: (sessionId: string) => Promise<boolean>): Promise<string | undefined> {
    const values = this.#values();
    const value = await values.chatTabValue(tabId).catch(() => undefined);
    if (value === undefined) return this.#bound.get(tabId);
    if (value !== null && await exists(value.sessionId)) {
      // A binding made while the value was being read is newer.
      if (!this.#bound.has(tabId)) this.#bound.set(tabId, value.sessionId);
      return this.#bound.get(tabId);
    }
    if (!this.#bound.has(tabId)) this.#write(tabId, (current) => current.removeChatTabValue(tabId));
    return this.#bound.get(tabId);
  }

  /** Removes a value a tab carries without being bound here (an agent tab's, say). */
  clearValue(tabId: number): void {
    this.#bound.delete(tabId);
    this.#write(tabId, (values) => values.removeChatTabValue(tabId));
  }

  /** Settles once every queued write has (for tests and orderly shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.#writes.values()]);
  }

  #write(tabId: number, write: (values: ChatTabValues) => Promise<void>): void {
    const previous = this.#writes.get(tabId) ?? Promise.resolve();
    // A tab that closed meanwhile, or a session API that is missing, fails quietly.
    const next = previous.then(() => write(this.#values())).catch(() => {});
    this.#writes.set(tabId, next);
    void next.then(() => { if (this.#writes.get(tabId) === next) this.#writes.delete(tabId); });
  }
}
