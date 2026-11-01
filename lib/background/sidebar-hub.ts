/**
 * Owns the "agent-sidebar:v1" Port: attaches each Port as a view
 * (`view.attach`: the sidebar of one window, showing one session), answers
 * `state.subscribe` with that view's authoritative `state.snapshot` or a gap
 * replay, sends each view `page.attached` whenever its window's active tab's
 * attachability changes, and publishes sequenced run events on behalf of
 * `BackgroundRuntime` (the `delegate`). A Port that has not attached gets no
 * snapshot, and its other commands wait until it does. Run, queue,
 * session-list, agent-tab, and permission events go to every Port; the Ask
 * chip, composer focus, and page attachment only to their window's views.
 * Port disconnect is transport loss only — it never cancels anything.
 *
 * Every run has its own sequence numbers (1, 2, …) and replay buffer
 * (`MAX_REPLAY_EVENTS_PER_RUN` events), registered by `startRun` with the
 * run's session, which every event of the run carries and which may differ
 * from the session a sidebar has open. All buffers together keep at most
 * `MAX_REPLAY_EVENTS_TOTAL` events, dropping the oldest first. A run's buffer
 * outlives its terminal event by `ENDED_RUN_GRACE_MS` (at most
 * `MAX_ENDED_RUNS` such runs), so a reconnecting sidebar can still replay its
 * end. Every other event carries seq 0 and never touches run seqs.
 *
 * `state.subscribe` names the last seq the sidebar applied per run. It is
 * answered with each run's missed events when every run's buffer still covers
 * them, and otherwise (or with `lastSeq: null`) with a full `state.snapshot`.
 */

import type { Browser } from "wxt/browser";
import { isSidebarCommand, SIDEBAR_PORT_NAME, TERMINAL_RUN_EVENT_TYPES } from "@/lib/protocol";
import type { AgentTabsState, AttachedPage, RunEvent, RuntimeSnapshot, SidebarCommand, SidebarEvent, TabMention } from "@/lib/protocol";
import type { ConversationSummary, QueuedMessage } from "@/lib/domain/conversation";
import type { SkillSummary } from "@/lib/domain/skills";
import type { SiteNote } from "@/lib/domain/instructions";
import type { AskContextV1 } from "@/lib/domain/ask";
import type { PermissionMode } from "@/lib/domain/permissions";
import type { AttachmentPrepareResult } from "@/lib/domain/attachments";

export const MAX_REPLAY_EVENTS_PER_RUN = 512;
export const MAX_REPLAY_EVENTS_TOTAL = 2_048;
export const ENDED_RUN_GRACE_MS = 60_000;
export const MAX_ENDED_RUNS = 16;
const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];

/**
 * One attached sidebar: the window it belongs to, the session it shows, and
 * the tab it shows that session for. The runtime picks `sessionId` and
 * `tabId` when the view attaches, and changes them when its window's active
 * tab changes, through that view's own session commands, and when the
 * session is deleted; `sessionId` is `""` until the view has attached.
 */
export interface ChatView {
  readonly kind: "sidebar";
  readonly windowId: number;
  sessionId: string;
  /** The tab whose chat the view shows: its window's active tab as the view last followed it; null when the window reported none. */
  tabId: number | null;
}

export interface SidebarHubDelegate {
  /** One snapshot per view, in order, sharing one read of what views have in common (and one pending notice). */
  getSnapshots(views: readonly ChatView[]): Promise<RuntimeSnapshot[]>;
  /** A Port's `view.attach`: picks the session the new view shows and sets its `sessionId`. */
  attachView(view: ChatView): Promise<void>;
  /** An attached view's Port closed: its session may no longer be shown anywhere. */
  detachView?(view: ChatView): void;
  /** A sidebar Port closed: what it prepared and has not sent (MCP content, attached files) is dropped. */
  releaseOwner?(owner: object): void;
  handleCommand(command: SidebarCommand, owner?: object): Promise<{ markdown: string; filename: string } | { tabs: TabMention[] } | { skills: SkillSummary[] } | { sessions: ConversationSummary[] } |
    { origin: string | null; note: SiteNote | null } | { note: SiteNote | null; error: string | null } | { undone: string[]; error: string | null } | { contentReply: import("@/lib/protocol").McpContentReply } |
    { workspaceImage: import("@/lib/protocol").WorkspaceImageReply } | { attachmentReply: AttachmentPrepareResult } | void>;
}

/** A buffered event and its place among every run's events. */
interface Buffered {
  order: number;
  event: RunEvent;
}

interface RunLog {
  conversationId: string;
  /** The seq of the run's last published event. */
  seq: number;
  /** Its newest buffered events, oldest first. */
  events: Buffered[];
  /** When its terminal event was published. */
  endedAt: number | null;
}

/** A connected Port and, once it has sent `view.attach`, its view. */
interface Connection {
  view: ChatView | null;
  /** Set by the first `view.attach`; later ones are ignored, whether it succeeded or not. */
  attaching: boolean;
  /** Settles with the attached view, or `null` once the Port closes or attaching fails; every command but `view.attach` waits on it. */
  ready: Promise<ChatView | null>;
  settle(view: ChatView | null): void;
}

export class SidebarHub {
  delegate: SidebarHubDelegate | null = null;

  #ports = new Map<Browser.runtime.Port, Connection>();
  /** The attachable active tab of each window that has a view, as last sent to its views. */
  #pages = new Map<number, AttachedPage | null>();
  #runs = new Map<string, RunLog>();
  #buffered = 0;
  #order = 0;

  /** The attachable active tab of a window with a view, as its views were last told. */
  currentAttachment(windowId: number): AttachedPage | null {
    return this.#pages.get(windowId) ?? null;
  }

  /** Every attached view (one per connected sidebar that has finished `view.attach`). */
  views(): ChatView[] {
    return [...this.#ports.values()].flatMap((connection) => connection.view?.sessionId ? [connection.view] : []);
  }

  /** The attached view of a Port, or `null` for a Port that is not connected or has not attached. */
  viewOf(owner: object): ChatView | null {
    const view = this.#ports.get(owner as Browser.runtime.Port)?.view;
    return view?.sessionId ? view : null;
  }

  /** The seq of a run's last published event; 0 for a run that has published none or is not registered. */
  lastSeq(runId: string): number {
    return this.#runs.get(runId)?.seq ?? 0;
  }

  /** Sends a window's Ask chip to that window's views only; `null` (no window) reaches none. */
  publishAsk(windowId: number | null, ask: AskContextV1 | null): void {
    this.#toWindow(windowId, { v: 1, runId: null, conversationId: null, seq: 0, type: "ask.changed", at: Date.now(), payload: { ask } });
  }

  contentAccepted(owner: object, ids: string[]): void {
    for (const port of this.#ports.keys()) if (port === owner) port.postMessage({
      v: 1, type: "mcp.content.accepted", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: { ids },
    } satisfies SidebarEvent);
  }

  /** Tells the sidebar that prepared these files that the message they went with is persisted. */
  attachmentsAccepted(owner: object, ids: string[]): void {
    for (const port of this.#ports.keys()) if (port === owner) port.postMessage({
      v: 1, type: "attachment.accepted", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: { ids },
    } satisfies SidebarEvent);
  }

  /** Focuses the composer of a window's views only; `null` (no window) reaches none. */
  focusComposer(windowId: number | null): void {
    this.#toWindow(windowId, { v: 1, runId: null, conversationId: null, seq: 0, type: "composer.focus", at: Date.now(), payload: null });
  }

  handleConnect(port: Browser.runtime.Port): void {
    if (port.name !== SIDEBAR_PORT_NAME) return;
    // A page/content script cannot impersonate the native sidebar Port.
    if (port.sender && (port.sender.id !== browser.runtime.id || port.sender.url?.replace(/#.*$/s, "") !== browser.runtime.getURL("/sidepanel.html"))) return;
    let settle!: (view: ChatView | null) => void;
    const ready = new Promise<ChatView | null>((resolve) => { settle = resolve; });
    const connection: Connection = { view: null, attaching: false, ready, settle };
    this.#ports.set(port, connection);
    port.onMessage.addListener((message: unknown) => this.#handleMessage(port, message));
    port.onDisconnect.addListener(() => {
      this.#ports.delete(port);
      connection.settle(null);
      this.delegate?.releaseOwner?.(port);
      const view = connection.view;
      connection.view = null;
      if (view?.sessionId) this.delegate?.detachView?.(view);
      for (const windowId of this.#pages.keys()) if (!this.views().some((other) => other.windowId === windowId)) this.#pages.delete(windowId);
    });
  }

  /**
   * Re-evaluates the active tab of every window with a view, and sends each
   * window's views its page when that changed. Windows without a view are
   * not tracked.
   */
  async refreshAttachment(): Promise<void> {
    const windows = new Set(this.views().map((view) => view.windowId));
    if (windows.size === 0) {
      this.#pages.clear();
      return;
    }
    const tabs = await browser.tabs.query({ active: true });
    for (const windowId of [...this.#pages.keys()]) if (!windows.has(windowId)) this.#pages.delete(windowId);
    for (const windowId of windows) {
      const tab = tabs.find((candidate) => candidate.windowId === windowId);
      const next = tab && isSupportedUrl(tab.url) && tab.id !== undefined ? toAttachment(tab) : null;
      if (this.#pages.has(windowId) && attachmentsEqual(this.#pages.get(windowId)!, next)) continue;
      this.#pages.set(windowId, next);
      for (const [port, connection] of this.#ports) {
        if (connection.view?.sessionId && connection.view.windowId === windowId) this.#sendAttachment(port, next);
      }
    }
  }

  /** Broadcasts every session's agent tabs and the watched one. Not run-sequenced, so it is safe mid-run and never clears sidebar error state. */
  publishAgentTabs(state: AgentTabsState): void {
    this.#broadcast({ v: 1, runId: null, conversationId: null, seq: 0, type: "agent-tabs.changed", at: Date.now(), payload: state });
  }

  /** Broadcasts the permission mode after a sidebar changes it. Not run-sequenced, like `agent-tabs.changed`. */
  publishPermissionMode(mode: PermissionMode): void {
    this.#broadcast({ v: 1, runId: null, conversationId: null, seq: 0, type: "permissions.changed", at: Date.now(), payload: { mode } });
  }

  /** Broadcasts the session index after it changes. Not run-sequenced, like `agent-tabs.changed`. */
  publishSessions(sessions: ConversationSummary[]): void {
    this.#broadcast({ v: 1, runId: null, conversationId: null, seq: 0, type: "session.listed", at: Date.now(), payload: { sessions } });
  }

  /** Broadcasts one session's message queue after it changes. Not run-sequenced, like `agent-tabs.changed`. */
  publishQueue(sessionId: string, messages: QueuedMessage[]): void {
    this.#broadcast({ v: 1, runId: null, conversationId: sessionId, seq: 0, type: "queue.changed", at: Date.now(), payload: { messages } });
  }

  /**
   * Registers a run of `conversationId` before its first event: its seqs start
   * at 1 and its events carry that session. A run already registered keeps its
   * seqs, so a late terminal event still follows its earlier ones.
   */
  startRun(runId: string, conversationId: string): void {
    this.#prune();
    if (this.#runs.has(runId)) return;
    this.#runs.set(runId, { conversationId, seq: 0, events: [], endedAt: null });
  }

  /**
   * Publishes a run's next sequenced event to every connected port. A run
   * that was never registered (or has ended and been forgotten) has nothing to
   * report to, so its events are dropped. After the terminal event the run
   * stays replayable for `ENDED_RUN_GRACE_MS`.
   */
  publishRunEvent<T extends RunEvent["type"]>(
    runId: string,
    type: T,
    payload: Extract<SidebarEvent, { type: T }>["payload"],
  ): void {
    const log = this.#runs.get(runId);
    if (!log || log.endedAt !== null) return;
    log.seq += 1;
    const event = {
      v: 1,
      runId,
      conversationId: log.conversationId,
      seq: log.seq,
      type,
      at: Date.now(),
      payload,
    } as Extract<SidebarEvent, { type: T }>;
    log.events.push({ order: ++this.#order, event: event as RunEvent });
    this.#buffered += 1;
    if (log.events.length > MAX_REPLAY_EVENTS_PER_RUN) { log.events.shift(); this.#buffered -= 1; }
    while (this.#buffered > MAX_REPLAY_EVENTS_TOTAL) this.#dropOldestEvent();
    if (TERMINAL_RUN_EVENT_TYPES.has(type)) log.endedAt = Date.now();
    this.#broadcast(event);
    this.#prune();
  }

  /**
   * Sends every attached view (or only the views in `only`) its own current
   * full snapshot (e.g. after a dropped run.start, or to views that switched chats).
   */
  async broadcastSnapshot(only?: readonly ChatView[]): Promise<void> {
    if (!this.delegate) return;
    const targets = [...this.#ports].filter(([, connection]) => connection.view?.sessionId && (!only || only.includes(connection.view)));
    if (targets.length === 0) return;
    const snapshots = await this.delegate.getSnapshots(targets.map(([, connection]) => connection.view!));
    targets.forEach(([port, connection], index) => {
      if (this.#ports.get(port) === connection) this.#postSnapshot(port, snapshots[index]!);
    });
  }

  async #handleMessage(port: Browser.runtime.Port, message: unknown): Promise<void> {
    if (!isSidebarCommand(message) || !this.delegate) return;
    const connection = this.#ports.get(port);
    if (!connection) return;
    if (message.type === "view.attach") {
      await this.#attach(port, connection, message.windowId);
      return;
    }
    // Commands sent before the Port attached wait for it; a Port that never attaches is never answered.
    if (!(await connection.ready) || this.#ports.get(port) !== connection) return;
    if (message.type === "state.subscribe") {
      await this.#handleSubscribe(port, connection, message.lastSeq);
      return;
    }
    const result = await this.delegate.handleCommand(message, port);
    if (result && "contentReply" in result) port.postMessage({
      v: 1, type: "mcp.content.reply", runId: null, conversationId: "sessionId" in message ? message.sessionId ?? null : null, seq: 0, at: Date.now(), payload: { requestId: message.id, result: result.contentReply },
    } satisfies SidebarEvent);
    if (message.type === "attachment.prepare" && result && "attachmentReply" in result) port.postMessage({
      v: 1, type: "attachment.prepared", runId: null, conversationId: message.sessionId, seq: 0, at: Date.now(), payload: { requestId: message.id, result: result.attachmentReply },
    } satisfies SidebarEvent);
    if (message.type === "skills.list" && result && "skills" in result) port.postMessage({
      v: 1, type: "skills.listed", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "tabs.list" && result && "tabs" in result) port.postMessage({
      v: 1, type: "tabs.listed", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "session.list" && result && "sessions" in result) port.postMessage({
      v: 1, type: "session.listed", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "siteNote.get" && result && "origin" in result) port.postMessage({
      v: 1, type: "siteNote.loaded", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
    if (message.type === "siteNote.save" && result && "note" in result && "error" in result) port.postMessage({
      v: 1, type: "siteNote.saved", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
    if (message.type === "memory.undo" && result && "undone" in result) port.postMessage({
      v: 1, type: "memory.undone", runId: null, conversationId: null, seq: 0, at: Date.now(), payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
    if (message.type === "workspace.image" && result && "workspaceImage" in result) port.postMessage({
      v: 1, type: "workspace.image.loaded", runId: null, conversationId: message.sessionId, seq: 0, at: Date.now(), payload: { requestId: message.id, result: result.workspaceImage },
    } satisfies SidebarEvent);
    if (message.type === "context.export" && result && "markdown" in result) port.postMessage({
      v: 1, type: "context.exported", runId: null, conversationId: null, seq: 0, at: Date.now(),
      payload: { requestId: message.id, ...result },
    } satisfies SidebarEvent);
  }

  /**
   * Attaches a Port once, as the sidebar view of `windowId`: the delegate
   * picks its session, then the view gets its window's page. Repeated
   * `view.attach` commands are ignored.
   */
  async #attach(port: Browser.runtime.Port, connection: Connection, windowId: number): Promise<void> {
    if (connection.attaching || !this.delegate) return;
    connection.attaching = true;
    const view: ChatView = { kind: "sidebar", windowId, sessionId: "", tabId: null };
    connection.view = view;
    try {
      await this.delegate.attachView(view);
    } catch {
      view.sessionId = "";
    }
    if (this.#ports.get(port) !== connection) return;
    if (!view.sessionId) {
      connection.view = null;
      connection.settle(null);
      return;
    }
    const known = this.#pages.has(windowId);
    // A window seen for the first time is sent its page by the refresh.
    await this.refreshAttachment().catch(() => {});
    if (known || !this.#pages.has(windowId)) this.#sendAttachment(port, this.#pages.get(windowId) ?? null);
    connection.settle(view);
  }

  async #handleSubscribe(port: Browser.runtime.Port, connection: Connection, known: Record<string, number> | null): Promise<void> {
    if (!this.delegate || !connection.view) return;
    const replay = known ? this.#missedEvents(known) : null;
    if (replay) {
      for (const event of replay) port.postMessage(event);
      return;
    }
    const [snapshot] = await this.delegate.getSnapshots([connection.view]);
    if (snapshot && this.#ports.get(port) === connection) this.#postSnapshot(port, snapshot);
  }

  /**
   * Every run's events after the seq the sidebar applied, in publication
   * order, or `null` when any of them is no longer buffered: a named run this
   * hub no longer knows, a seq ahead of the run's or before its buffer, or a
   * run that ended without the sidebar knowing it. A run the sidebar does not
   * name that is still in progress started after its state, so it replays
   * from seq 0.
   */
  #missedEvents(known: Record<string, number>): RunEvent[] | null {
    this.#prune();
    for (const runId of Object.keys(known)) if (!this.#runs.has(runId)) return null;
    const missed: Buffered[] = [];
    for (const [runId, log] of this.#runs) {
      const named = Object.prototype.hasOwnProperty.call(known, runId);
      if (!named && log.endedAt !== null) return null;
      const from = named ? known[runId]! : 0;
      if (from > log.seq) return null;
      if (from === log.seq) continue;
      const first = log.events[0];
      if (!first || first.event.seq > from + 1) return null;
      for (const buffered of log.events) if (buffered.event.seq > from) missed.push(buffered);
    }
    return missed.sort((a, b) => a.order - b.order).map((buffered) => buffered.event);
  }

  /** Drops the oldest buffered event of all runs. */
  #dropOldestEvent(): void {
    let oldest: RunLog | null = null;
    for (const log of this.#runs.values()) {
      const first = log.events[0];
      if (first && (!oldest || first.order < oldest.events[0]!.order)) oldest = log;
    }
    if (!oldest) { this.#buffered = 0; return; }
    oldest.events.shift();
    this.#buffered -= 1;
  }

  /** Forgets ended runs past their grace, and the oldest ended runs past `MAX_ENDED_RUNS`. */
  #prune(now = Date.now()): void {
    const ended = [...this.#runs].filter(([, log]) => log.endedAt !== null).sort(([, a], [, b]) => a.endedAt! - b.endedAt!);
    ended.forEach(([runId, log], index) => {
      if (now - log.endedAt! <= ENDED_RUN_GRACE_MS && ended.length - index <= MAX_ENDED_RUNS) return;
      this.#runs.delete(runId);
      this.#buffered -= log.events.length;
    });
  }

  #broadcast(event: SidebarEvent): void {
    for (const port of this.#ports.keys()) port.postMessage(event);
  }

  #toWindow(windowId: number | null, event: SidebarEvent): void {
    if (windowId === null) return;
    for (const [port, connection] of this.#ports) if (connection.view?.sessionId && connection.view.windowId === windowId) port.postMessage(event);
  }

  #postSnapshot(port: Browser.runtime.Port, snapshot: RuntimeSnapshot): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: snapshot.conversation.id,
      seq: 0,
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
