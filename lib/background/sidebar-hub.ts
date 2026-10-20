/**
 * Owns the "agent-sidebar:v1" Port: answers `state.subscribe` with the
 * authoritative `state.snapshot` or a gap replay, broadcasts `page.attached`
 * whenever the active tab's attachability changes, and publishes run-local
 * sequenced events on behalf of `BackgroundRuntime` (the `delegate`). Port
 * disconnect is transport loss only — it never cancels anything.
 *
 * Sequence numbers and the 512-entry replay buffer are run-local: they reset
 * whenever a new run starts. Reconnecting with no active run always gets a
 * full `state.snapshot`, since there is no run to gap-replay against.
 */

import type { Browser } from "wxt/browser";
import { isSidebarCommand, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { RuntimeSnapshot, SidebarCommand, SidebarEvent, TabMention } from "@/lib/protocol";
import type { PageArtifactSummary } from "@/lib/domain/tools";

const MAX_REPLAY_EVENTS = 512;
const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];

export interface SidebarHubDelegate {
  getSnapshot(): Promise<RuntimeSnapshot>;
  handleCommand(command: SidebarCommand): Promise<{ markdown: string; filename: string } | { tabs: TabMention[] } | void>;
}

type RunEvent = Exclude<SidebarEvent, { type: "state.snapshot" | "page.attached" | "agent-tabs.changed" | "context.exported" | "tabs.listed" }>;

export class SidebarHub {
  delegate: SidebarHubDelegate | null = null;

  #ports = new Set<Browser.runtime.Port>();
  #attachment: PageArtifactSummary | null = null;
  #lastSeq = 0;
  #eventLog: RunEvent[] = [];

  currentAttachment(): PageArtifactSummary | null {
    return this.#attachment;
  }

  lastSeq(): number {
    return this.#lastSeq;
  }

  handleConnect(port: Browser.runtime.Port): void {
    if (port.name !== SIDEBAR_PORT_NAME) return;
    this.#ports.add(port);
    port.onMessage.addListener((message: unknown) => this.#handleMessage(port, message));
    port.onDisconnect.addListener(() => {
      this.#ports.delete(port);
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

  /** Broadcasts the hidden agent-tab count. Not run-sequenced, so it is safe mid-run and never clears sidebar error state. */
  publishAgentTabs(count: number): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: "default",
      seq: this.#lastSeq,
      type: "agent-tabs.changed",
      at: Date.now(),
      payload: { count },
    };
    for (const port of this.#ports) port.postMessage(event);
  }

  /** Called by BackgroundRuntime when a new run begins: resets the run-local seq/replay buffer. */
  startRun(): void {
    this.#lastSeq = 0;
    this.#eventLog = [];
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
      conversationId: "default",
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
    const result = await this.delegate.handleCommand(message);
    if (message.type === "tabs.list" && result && "tabs" in result) port.postMessage({
      v: 1, type: "tabs.listed", runId: null, conversationId: "default", seq: this.#lastSeq, at: Date.now(), payload: result,
    } satisfies SidebarEvent);
    if (message.type === "context.export" && result && "markdown" in result) port.postMessage({
      v: 1, type: "context.exported", runId: null, conversationId: "default", seq: this.#lastSeq, at: Date.now(),
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
      conversationId: "default",
      seq: this.#lastSeq,
      type: "state.snapshot",
      at: Date.now(),
      payload: snapshot,
    };
    port.postMessage(event);
  }

  #sendAttachment(port: Browser.runtime.Port, attachment: PageArtifactSummary | null): void {
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: "default",
      seq: 0,
      type: "page.attached",
      at: Date.now(),
      payload: attachment,
    };
    port.postMessage(event);
  }
}

function toAttachment(tab: { id?: number; url?: string; title?: string }): PageArtifactSummary {
  return {
    artifactId: `page:${tab.id}:${tab.url}`,
    kind: "page",
    title: tab.title ?? "",
    url: tab.url ?? "",
    capturedAt: Date.now(),
  };
}

function attachmentsEqual(a: PageArtifactSummary | null, b: PageArtifactSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.url === b.url && a.title === b.title;
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
