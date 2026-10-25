/**
 * Owns the "agent-sidebar:v1" Port: answers `state.subscribe` with the
 * authoritative `state.snapshot` or a gap replay, broadcasts `page.attached`
 * whenever the active tab's attachability changes, and publishes run-local
 * sequenced events on behalf of `BackgroundRuntime` (the `delegate`). Port
 * disconnect is transport loss only — it never cancels anything.
 *
 * Sequence numbers and the 512-entry replay buffer are run-local: they reset
 * whenever a new run starts. Run events carry the run's session id, which may
 * differ from the session the sidebar has open. Reconnecting with no active run always gets a
 * full `state.snapshot`, since there is no run to gap-replay against.
 */

import type { Browser } from "wxt/browser";
import { isSidebarCommand, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { AgentTabsState, AttachedPage, RuntimeSnapshot, SidebarCommand, SidebarEvent, TabMention } from "@/lib/protocol";
import type { ConversationSummary, QueuedMessage } from "@/lib/domain/conversation";
import type { SkillSummary } from "@/lib/domain/skills";
import type { SiteNote } from "@/lib/domain/instructions";
import type { AskContextV1 } from "@/lib/domain/ask";

const MAX_REPLAY_EVENTS = 512;
const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];

export interface SidebarHubDelegate {
  getSnapshot(): Promise<RuntimeSnapshot>;
  releaseContentOwner?(owner: object): void;
  handleCommand(command: SidebarCommand, owner?: object): Promise<{ markdown: string; filename: string } | { tabs: TabMention[] } | { skills: SkillSummary[] } | { sessions: ConversationSummary[] } |
    { origin: string | null; note: SiteNote | null } | { note: SiteNote | null; error: string | null } | { undone: string[]; error: string | null } | { contentReply: import("@/lib/protocol").McpContentReply } | void>;
}

type RunEvent = Exclude<SidebarEvent, { type: "mcp.content.reply" | "mcp.content.accepted" | "state.snapshot" | "page.attached" | "agent-tabs.changed" | "queue.changed" | "ask.changed" | "composer.focus" | "context.exported" | "tabs.listed" | "skills.listed" | "session.listed" | "siteNote.loaded" | "siteNote.saved" | "memory.undone" }>;

export class SidebarHub {
  delegate: SidebarHubDelegate | null = null;

  #ports = new Set<Browser.runtime.Port>();
  #attachment: AttachedPage | null = null;
  #lastSeq = 0;
  #eventLog: RunEvent[] = [];
  #runConversationId: string | null = null;

  currentAttachment(): AttachedPage | null {
    return this.#attachment;
  }

  lastSeq(): number {
    return this.#lastSeq;
  }

  publishAsk(ask: AskContextV1 | null): void {
    const event: SidebarEvent = { v: 1, runId: null, conversationId: null, seq: this.#lastSeq, type: "ask.changed", at: Date.now(), payload: { ask } };
    for (const port of this.#ports) port.postMessage(event);
  }

  contentAccepted(owner: object, ids: string[]): void {
    for (const port of this.#ports) if (port === owner) port.postMessage({
      v: 1, type: "mcp.content.accepted", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: { ids },
    } satisfies SidebarEvent);
  }

  focusComposer(): void {
    const event: SidebarEvent = { v: 1, runId: null, conversationId: null, seq: this.#lastSeq, type: "composer.focus", at: Date.now(), payload: null };
    for (const port of this.#ports) port.postMessage(event);
  }

  handleConnect(port: Browser.runtime.Port): void {
    if (port.name !== SIDEBAR_PORT_NAME) return;
    // A page/content script cannot impersonate the native sidebar Port.
    if (port.sender && (port.sender.id !== browser.runtime.id || port.sender.url?.replace(/#.*$/s, "") !== browser.runtime.getURL("/sidepanel.html"))) return;
    this.#ports.add(port);
    port.onMessage.addListener((message: unknown) => this.#handleMessage(port, message));
    port.onDisconnect.addListener(() => {
      this.#ports.delete(port);
      this.delegate?.releaseContentOwner?.(port);
    });
    this.#sendAttachment(port, this.#attachment);
  }

  /** Re-evaluates the active tab's attachability and broadcasts if it changed. */
  async refreshAttachment(): Promise<void> {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    const next = tab && isSupportedUrl(tab.url) && tab.id !== undefined ? toAttachment(tab) : null;

    if (attachmentsEqual(this.#attachment, next)) return;
    this.#attachment = next;
    for (const port of this.#ports) {
      this.#sendAttachment(port, next);
    }
  }

  /** Broadcasts every session's agent tabs and the watched one. Not run-sequenced, so it is safe mid-run and never clears sidebar error state. */
  publishAgentTabs(state: AgentTabsState): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: null,
      seq: this.#lastSeq,
      type: "agent-tabs.changed",
      at: Date.now(),
      payload: state,
    };
    for (const port of this.#ports) port.postMessage(event);
  }

  /** Broadcasts the session index after it changes. Not run-sequenced, like `agent-tabs.changed`. */
  publishSessions(sessions: ConversationSummary[]): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: null,
      seq: this.#lastSeq,
      type: "session.listed",
      at: Date.now(),
      payload: { sessions },
    };
    for (const port of this.#ports) port.postMessage(event);
  }

  /** Broadcasts one session's message queue after it changes. Not run-sequenced, like `agent-tabs.changed`. */
  publishQueue(sessionId: string, messages: QueuedMessage[]): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: sessionId,
      seq: this.#lastSeq,
      type: "queue.changed",
      at: Date.now(),
      payload: { messages },
    };
    for (const port of this.#ports) port.postMessage(event);
  }

  /** Called by BackgroundRuntime when a new run begins in `conversationId`: resets the run-local seq/replay buffer. */
  startRun(conversationId: string): void {
    this.#lastSeq = 0;
    this.#eventLog = [];
    this.#runConversationId = conversationId;
  }

  /** Publishes a run-local sequenced event to every connected port. */
  publishRunEvent<T extends RunEvent["type"]>(
    runId: string,
    type: T,
    payload: Extract<SidebarEvent, { type: T }>["payload"],
  ): void {
    this.#lastSeq += 1;
    const event = {
      v: 1,
      runId,
      conversationId: this.#runConversationId,
      seq: this.#lastSeq,
      type,
      at: Date.now(),
      payload,
    } as Extract<SidebarEvent, { type: T }>;
    this.#eventLog.push(event as RunEvent);
    if (this.#eventLog.length > MAX_REPLAY_EVENTS) this.#eventLog.shift();
    for (const port of this.#ports) port.postMessage(event);
  }

  /** Broadcasts the current full snapshot to every connected port (e.g. after a dropped run.start). */
  async broadcastSnapshot(): Promise<void> {
    if (!this.delegate) return;
    const snapshot = await this.delegate.getSnapshot();
    for (const port of this.#ports) this.#postSnapshot(port, snapshot);
  }

  async #handleMessage(port: Browser.runtime.Port, message: unknown): Promise<void> {
    if (!isSidebarCommand(message) || !this.delegate) return;
    if (message.type === "state.subscribe") {
      await this.#handleSubscribe(port, message.lastSeq);
      return;
    }
    const result = await this.delegate.handleCommand(message, port);
    if (result && "contentReply" in result) port.postMessage({
      v: 1, type: "mcp.content.reply", runId: null, conversationId: "sessionId" in message ? message.sessionId ?? null : null, seq: this.#lastSeq, at: Date.now(), payload: { requestId: message.id, result: result.contentReply },
    } satisfies SidebarEvent);
    if (message.type === "skills.list" && result && "skills" in result) port.postMessage({
      v: 1, type: "skills.listed", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "tabs.list" && result && "tabs" in result) port.postMessage({
      v: 1, type: "tabs.listed", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "session.list" && result && "sessions" in result) port.postMessage({
      v: 1, type: "session.listed", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "siteNote.get" && result && "origin" in result) port.postMessage({
      v: 1, type: "siteNote.loaded", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
    if (message.type === "siteNote.save" && result && "note" in result && "error" in result) port.postMessage({
      v: 1, type: "siteNote.saved", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
    if (message.type === "memory.undo" && result && "undone" in result) port.postMessage({
      v: 1, type: "memory.undone", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(), payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
    if (message.type === "context.export" && result && "markdown" in result) port.postMessage({
      v: 1, type: "context.exported", runId: null, conversationId: null, seq: this.#lastSeq, at: Date.now(),
      payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
  }

  async #handleSubscribe(port: Browser.runtime.Port, lastSeq: number | null): Promise<void> {
    if (!this.delegate) return;
    if (lastSeq !== null && this.#canReplay(lastSeq)) {
      for (const event of this.#eventLog) {
        if (event.seq > lastSeq) port.postMessage(event);
      }
      return;
    }
    const snapshot = await this.delegate.getSnapshot();
    this.#postSnapshot(port, snapshot);
  }

  #canReplay(lastSeq: number): boolean {
    if (this.#eventLog.length === 0) return lastSeq === this.#lastSeq;
    return lastSeq >= (this.#eventLog[0]?.seq ?? Infinity) - 1 && lastSeq <= this.#lastSeq;
  }

  #postSnapshot(port: Browser.runtime.Port, snapshot: RuntimeSnapshot): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: snapshot.conversation.id,
      seq: this.#lastSeq,
      type: "state.snapshot",
      at: Date.now(),
      payload: snapshot,
    };
    port.postMessage(event);
  }

  #sendAttachment(port: Browser.runtime.Port, attachment: AttachedPage | null): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: null,
      seq: 0,
      type: "page.attached",
      at: Date.now(),
      payload: attachment,
    };
    port.postMessage(event);
  }
}

function toAttachment(tab: { id?: number; url?: string; title?: string }): AttachedPage {
  return {
    tabId: tab.id!,
    artifactId: `page:${tab.id}:${tab.url}`,
    kind: "page",
    title: tab.title ?? "",
    url: tab.url ?? "",
    capturedAt: Date.now(),
  };
}

function attachmentsEqual(a: AttachedPage | null, b: AttachedPage | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tabId === b.tabId && a.url === b.url && a.title === b.title;
}

function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !UNSUPPORTED_HOSTNAME_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
}
