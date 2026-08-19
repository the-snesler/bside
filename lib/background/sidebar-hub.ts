/**
 * Owns the "agent-sidebar:v1" Port: answers `state.subscribe` with the
 * authoritative `state.snapshot`, and broadcasts `page.attached` whenever the
 * active tab's attachability changes. Port disconnect is transport loss only
 * — it never cancels anything.
 *
 * Slice 3+ extend this same hub with run sequencing, deltas, and gap replay
 * rather than introducing a second channel.
 */

import type { Browser } from "wxt/browser";
import { isSidebarCommand, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { RuntimeSnapshot, SidebarEvent } from "@/lib/protocol";
import type { PageArtifactSummary } from "@/lib/domain/tools";

const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];

export class SidebarHub {
  #ports = new Set<Browser.runtime.Port>();
  #attachment: PageArtifactSummary | null = null;

  handleConnect(port: Browser.runtime.Port): void {
    if (port.name !== SIDEBAR_PORT_NAME) return;
    this.#ports.add(port);
    port.onMessage.addListener((message: unknown) => {
      if (isSidebarCommand(message) && message.type === "state.subscribe") {
        this.#sendSnapshot(port);
      }
    });
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

  #sendSnapshot(port: Browser.runtime.Port): void {
    const snapshot: RuntimeSnapshot = { page: this.#attachment, lastSeq: 0, notice: null };
    const event: SidebarEvent = {
      v: 1,
      runId: null,
      conversationId: "default",
      seq: 0,
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
