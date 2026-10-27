/**
 * Preact hook connecting a UI surface to the background's
 * "agent-sidebar:v1" Port. The sidebar renders this state; it never owns an
 * inference request, tool loop, transcript authority, or credential read.
 * Between full `state.snapshot` syncs, run-lifecycle events are applied
 * incrementally so the composer/timeline update live without re-fetching.
 * The single active run may belong to another session than the open one: its
 * events always update `activeRun`, but change `conversation` only when their
 * `conversationId` is the open session's.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Browser } from "wxt/browser";
import { RUN_CANCELLED_SUFFIX, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { HelpOutcome, NormalizedError, RuntimeSnapshot, SidebarCommand, SidebarEvent } from "@/lib/protocol";
import type { Conversation, ConversationItem, ConversationSummary } from "@/lib/domain/conversation";
import type { AppSettingsV1 } from "@/lib/domain/provider";
import type { TabMention } from "@/lib/protocol";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import { EMPTY_USAGE } from "@/lib/domain/usage";
import type { SiteNote } from "@/lib/domain/instructions";

/** The sidebar's "Remember something about this site" editor, for one page's site. */
export interface SiteNoteEditorState {
  /** The page's origin; `null` when its site cannot have a note. */
  origin: string | null;
  /** The note covering the page: its own origin's, or a parent's that includes subdomains. */
  note: SiteNote | null;
  status: "loading" | "ready" | "saving" | "saved";
  /** Why the last save was refused. */
  error: string | null;
}

/** The trace's Undo for one turn's memory changes, keyed by `memoryUndoKey`. */
export interface MemoryUndoState {
  status: "undoing" | "undone" | "failed";
  /** Why some or all were not undone. */
  error: string | null;
}

export const memoryUndoKey = (changeIds: readonly string[]) => changeIds.join(" ");

export interface BackgroundState extends RuntimeSnapshot {
  focusVersion: number;
  tabs: TabMention[];
  /** The session index, pinned first, then most recent. Requested on connect and pushed by the background whenever it changes. */
  sessions: ConversationSummary[];
  lastError: NormalizedError | null;
  /** The open "Remember something about this site" editor, if any. */
  siteNote: SiteNoteEditorState | null;
  memoryUndo: Record<string, MemoryUndoState>;
}

export interface BackgroundActions {
  listTabs(): void;
  listSkills(): void;
  focusTab(tabId: number): void;
  /** Closes one session's hidden agent tabs. */
  closeAgentTabs(sessionId: string): void;
  /** Shows one of the open session's agent tabs and switches to it; switching away hides it again. */
  watchTab(tabId: number): void;
  /** Goes back to the tab the user watched from, hiding the watched tab again. */
  unwatchTab(): void;
  /** Removes the page shield from the watched agent tab until watching ends. */
  takeOverTab(tabId: number): void;
  saveSettings(settings: AppSettingsV1): void;
  /** Starts a run, or queues a follow-up while this chat's run is working. */
  sendPrompt(prompt: string, askId?: string): void;
  /** Guidance for the running turn, delivered at its next tool boundary. */
  steer(text: string, askId?: string): void;
  dismissAsk(askId: string): void;
  removeQueued(messageId: string): void;
  sendQueued(messageId: string): void;
  retryRun(): void;
  cancelRun(): void;
  approveAction(callId: string): void;
  denyAction(callId: string): void;
  /** Answers the run's pending help request; `note` is optional (empty for none). */
  resolveHelp(callId: string, outcome: HelpOutcome, note: string): void;
  newChat(): void;
  listSessions(): void;
  openSession(sessionId: string): void;
  renameSession(sessionId: string, title: string): void;
  pinSession(sessionId: string, pinned: boolean): void;
  /** Deletes a session; its agent tabs are closed, or with `closeAgentTabs` false shown and handed to the user. */
  deleteSession(sessionId: string, closeAgentTabs: boolean): void;
  /** Downloads one session's context export. */
  downloadContext(sessionId: string): void;
  /** Opens the site-note editor for a page, loading the note that covers it. */
  rememberSite(pageUrl: string): void;
  /** Saves the open editor's note; the background revalidates it. */
  saveSiteNote(note: SiteNote): void;
  closeSiteNote(): void;
  /** Undoes memory changes a turn made; the background reverts each only if nothing changed it since. */
  undoMemory(changeIds: string[]): void;
}

const EMPTY_CONVERSATION: Conversation = {
  id: "", title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: 0, lastModelId: null, usage: EMPTY_USAGE, items: [],
};

const INITIAL_STATE: BackgroundState = {
  ask: null,
  focusVersion: 0,
  skills: [],
  tabs: [],
  sessions: [],
  conversation: EMPTY_CONVERSATION,
  credential: { configured: false, maskedSuffix: null, chatgpt: { connected: false, email: null, signInAgain: false } },
  provider: OPENAI_PROVIDER,
  settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
  page: null,
  agentTabs: { bySession: {}, watching: null, takenOver: false },
  queue: [],
  activeRun: null,
  lastSeq: 0,
  notice: null,
  lastError: null,
  siteNote: null,
  memoryUndo: {},
};

type Port = Browser.runtime.Port;

export function useBackground(): BackgroundState & BackgroundActions {
  const [state, setState] = useState<BackgroundState>(INITIAL_STATE);
  const portRef = useRef<Port | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const exportRequestRef = useRef<string | null>(null);
  /** The site-note request awaiting its reply; replies to an older or closed editor are dropped. */
  const siteNoteRequestRef = useRef<string | null>(null);
  /** Undo requests awaiting their reply, by request id. */
  const undoRequestsRef = useRef(new Map<string, string>());
  const conversationIdRef = useRef("");
  conversationIdRef.current = state.conversation.id;

  useEffect(() => {
    const port = browser.runtime.connect({ name: SIDEBAR_PORT_NAME });
    portRef.current = port;

    const onMessage = (message: unknown) => {
      const event = message as SidebarEvent;
      if (event.type === "context.exported") {
        if (event.payload.requestId !== exportRequestRef.current) return;
        exportRequestRef.current = null;
        const url = URL.createObjectURL(new Blob([event.payload.markdown], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = event.payload.filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      if (event.type === "siteNote.loaded" || event.type === "siteNote.saved") {
        if (event.payload.requestId !== siteNoteRequestRef.current) return;
        siteNoteRequestRef.current = null;
        const reply = event.payload;
        setState((prev) => !prev.siteNote ? prev : { ...prev, siteNote: "origin" in reply
          ? { origin: reply.origin, note: reply.note, status: "ready", error: null }
          : reply.note ? { ...prev.siteNote, note: reply.note, status: "saved", error: null } : { ...prev.siteNote, status: "ready", error: reply.error } });
        return;
      }
      if (event.type === "memory.undone") {
        const key = undoRequestsRef.current.get(event.payload.requestId);
        if (key === undefined) return;
        undoRequestsRef.current.delete(event.payload.requestId);
        const { undone, error } = event.payload;
        setState((prev) => ({ ...prev, memoryUndo: { ...prev.memoryUndo, [key]: { status: undone.length ? "undone" : "failed", error } } }));
        return;
      }
      applyEvent(message as SidebarEvent, setState, activeRunIdRef);
    };
    port.onMessage.addListener(onMessage);

    const subscribe: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "state.subscribe", lastSeq: null };
    port.postMessage(subscribe);
    port.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.list" } satisfies SidebarCommand);

    return () => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  const sendPrompt = useCallback((prompt: string, askId?: string) => {
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "run.start", prompt, ...(askId ? { askId } : {}) };
    portRef.current?.postMessage(command);
  }, []);

  const steer = useCallback((text: string, askId?: string) => {
    const runId = activeRunIdRef.current;
    // With no run to steer, the background treats the text as a normal prompt.
    portRef.current?.postMessage(runId
      ? { v: 1, id: crypto.randomUUID(), type: "run.steer", runId, text, ...(askId ? { askId } : {}) } satisfies SidebarCommand
      : { v: 1, id: crypto.randomUUID(), type: "run.start", prompt: text, ...(askId ? { askId } : {}) } satisfies SidebarCommand);
  }, []);
  const removeQueued = useCallback((messageId: string) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "queue.remove", sessionId: conversationIdRef.current, messageId } satisfies SidebarCommand);
  }, []);
  const sendQueued = useCallback((messageId: string) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "queue.send", sessionId: conversationIdRef.current, messageId } satisfies SidebarCommand);
  }, []);

  const retryRun = useCallback(() => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "run.retry" } satisfies SidebarCommand);
  }, []);

  const cancelRun = useCallback(() => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "run.cancel", runId };
    portRef.current?.postMessage(command);
  }, []);

  const approveAction = useCallback((callId: string) => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "action.approve", runId, callId };
    portRef.current?.postMessage(command);
  }, []);

  const denyAction = useCallback((callId: string) => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "action.deny", runId, callId };
    portRef.current?.postMessage(command);
  }, []);

  const resolveHelp = useCallback((callId: string, outcome: HelpOutcome, note: string) => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "help.resolve", runId, callId, outcome, note } satisfies SidebarCommand);
  }, []);

  const newChat = useCallback(() => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.create" } satisfies SidebarCommand);
  }, []);
  const listSessions = useCallback(() => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.list" } satisfies SidebarCommand);
  }, []);
  const openSession = useCallback((sessionId: string) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.open", sessionId } satisfies SidebarCommand);
  }, []);
  const renameSession = useCallback((sessionId: string, title: string) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.rename", sessionId, title } satisfies SidebarCommand);
  }, []);
  const pinSession = useCallback((sessionId: string, pinned: boolean) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.pin", sessionId, pinned } satisfies SidebarCommand);
  }, []);
  const deleteSession = useCallback((sessionId: string, closeAgentTabs: boolean) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.delete", sessionId, closeAgentTabs } satisfies SidebarCommand);
  }, []);

  const downloadContext = useCallback((sessionId: string) => {
    const id = crypto.randomUUID();
    exportRequestRef.current = id;
    portRef.current?.postMessage({ v: 1, id, type: "context.export", sessionId } satisfies SidebarCommand);
  }, []);

  const rememberSite = useCallback((url: string) => {
    const id = crypto.randomUUID();
    siteNoteRequestRef.current = id;
    setState((prev) => ({ ...prev, siteNote: { origin: null, note: null, status: "loading", error: null } }));
    portRef.current?.postMessage({ v: 1, id, type: "siteNote.get", url } satisfies SidebarCommand);
  }, []);
  const saveSiteNote = useCallback((note: SiteNote) => {
    const id = crypto.randomUUID();
    siteNoteRequestRef.current = id;
    setState((prev) => prev.siteNote ? { ...prev, siteNote: { ...prev.siteNote, status: "saving", error: null } } : prev);
    portRef.current?.postMessage({ v: 1, id, type: "siteNote.save", note } satisfies SidebarCommand);
  }, []);
  const closeSiteNote = useCallback(() => {
    siteNoteRequestRef.current = null;
    setState((prev) => ({ ...prev, siteNote: null }));
  }, []);

  const undoMemory = useCallback((changeIds: string[]) => {
    const id = crypto.randomUUID();
    const key = memoryUndoKey(changeIds);
    undoRequestsRef.current.set(id, key);
    setState((prev) => ({ ...prev, memoryUndo: { ...prev.memoryUndo, [key]: { status: "undoing", error: null } } }));
    portRef.current?.postMessage({ v: 1, id, type: "memory.undo", changeIds } satisfies SidebarCommand);
  }, []);

  const listTabs = useCallback(() => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "tabs.list" } satisfies SidebarCommand);
  }, []);
  const focusTab = useCallback((tabId: number) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "tabs.focus", tabId } satisfies SidebarCommand);
  }, []);
  const closeAgentTabs = useCallback((sessionId: string) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "tabs.closeAgentTabs", sessionId } satisfies SidebarCommand);
  }, []);
  const watchTab = useCallback((tabId: number) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "tabs.watch", tabId } satisfies SidebarCommand);
  }, []);
  const unwatchTab = useCallback(() => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "tabs.unwatch" } satisfies SidebarCommand);
  }, []);
  const takeOverTab = useCallback((tabId: number) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "tabs.takeOver", tabId } satisfies SidebarCommand);
  }, []);
  const saveSettings = useCallback((settings: AppSettingsV1) => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "settings.save", settings } satisfies SidebarCommand);
  }, []);

  return {
    ...state, sendPrompt, steer, removeQueued, sendQueued, retryRun, cancelRun, approveAction, denyAction, resolveHelp, newChat, listSessions, openSession, renameSession, pinSession,
    dismissAsk: (askId: string) => portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "ask.dismiss", askId } satisfies SidebarCommand),
    deleteSession, downloadContext, rememberSite, saveSiteNote, closeSiteNote, undoMemory, listTabs, listSkills: () => portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "skills.list" } satisfies SidebarCommand), focusTab, closeAgentTabs, watchTab, unwatchTab, takeOverTab, saveSettings,
  };
}

/** Appends a run item to the timeline only when the run belongs to the open session. */
function appendItem(prev: BackgroundState, conversationId: string | null, item: ConversationItem, updatedAt?: number): BackgroundState["conversation"] {
  if (conversationId !== prev.conversation.id) return prev.conversation;
  return { ...prev.conversation, items: [...prev.conversation.items, item], ...(updatedAt === undefined ? {} : { updatedAt }) };
}

/**
 * The ended run's usage as the `run-usage` item the background persisted
 * under the same id, after the run's last message. A no-op when no response
 * reported tokens.
 */
function endRun(prev: BackgroundState, conversationId: string | null, at: number): BackgroundState {
  const usage = prev.activeRun?.usage;
  const conversation = usage ? appendItem(prev, conversationId, { id: `usage-${usage.runId}`, kind: "run-usage", usage, at }) : prev.conversation;
  return { ...prev, activeRun: null, conversation };
}

function commitPendingText(prev: BackgroundState, conversationId: string | null): BackgroundState {
  if (!prev.activeRun || !prev.activeRun.partialAssistantText) return prev;
  const message: ConversationItem = {
    id: `${prev.activeRun.runId}-msg-${prev.conversation.items.length}`,
    kind: "message",
    role: "assistant",
    text: prev.activeRun.partialAssistantText,
    at: Date.now(),
  };
  return {
    ...prev,
    activeRun: { ...prev.activeRun, partialAssistantText: "" },
    conversation: appendItem(prev, conversationId, message),
  };
}

function applyEvent(
  event: SidebarEvent,
  setState: (updater: (prev: BackgroundState) => BackgroundState) => void,
  activeRunIdRef: { current: string | null },
): void {
  if (event.type === "ask.changed") {
    setState((prev) => ({ ...prev, ask: event.payload.ask }));
    return;
  }
  if (event.type === "composer.focus") {
    setState((prev) => ({ ...prev, focusVersion: prev.focusVersion + 1 }));
    return;
  }
  if (event.type === "skills.listed") {
    setState((prev) => ({ ...prev, skills: event.payload.skills }));
    return;
  }
  if (event.type === "tabs.listed") {
    setState((prev) => ({ ...prev, tabs: event.payload.tabs }));
    return;
  }
  if (event.type === "session.listed") {
    setState((prev) => ({ ...prev, sessions: event.payload.sessions }));
    return;
  }
  if (event.type === "state.snapshot") {
    activeRunIdRef.current = event.payload.activeRun?.runId ?? null;
    setState((prev) => ({ ...prev, ...event.payload, lastError: null }));
    return;
  }
  if (event.type === "page.attached") {
    setState((prev) => ({ ...prev, page: event.payload }));
    return;
  }
  if (event.type === "agent-tabs.changed") {
    setState((prev) => ({ ...prev, agentTabs: event.payload }));
    return;
  }
  if (event.type === "queue.changed") {
    setState((prev) => event.conversationId === prev.conversation.id ? { ...prev, queue: event.payload.messages } : prev);
    return;
  }
  if (event.type === "steer.delivered") {
    setState((prev) => {
      const committed = commitPendingText(prev, event.conversationId);
      const delivered = event.payload.item;
      if (event.conversationId !== prev.conversation.id) return committed;
      return {
        ...committed,
        queue: committed.queue.filter((message) => message.id !== delivered.id),
        conversation: appendItem(committed, event.conversationId, delivered),
      };
    });
    return;
  }
  if (event.type === "run.usage") {
    setState((prev) => prev.activeRun?.runId === event.runId ? { ...prev, activeRun: { ...prev.activeRun, usage: event.payload.usage } } : prev);
    return;
  }
  if (event.type === "run.started") {
    activeRunIdRef.current = event.runId;
    setState((prev) => {
      const userItem: ConversationItem = {
        id: `${event.runId}-user`,
        kind: "message",
        role: "user",
        text: event.payload.prompt,
        context: event.payload.page,
        ...(event.payload.ask ? { ask: event.payload.ask } : {}),
        ...(event.payload.scheduled ? { scheduled: event.payload.scheduled } : {}),
        at: event.at,
      };
      const conversationId = event.conversationId!;
      return {
        ...prev,
        lastError: null,
        activeRun: { runId: event.runId as string, conversationId, status: "running", partialAssistantText: "", pendingApproval: null, pendingHelp: null, usage: null },
        // A retry re-runs the turn's existing user message rather than adding one.
        conversation: event.payload.retry ? prev.conversation : appendItem(prev, conversationId, userItem, event.at),
      };
    });
    return;
  }
  if (event.type === "assistant.delta") {
    setState((prev) =>
      prev.activeRun
        ? { ...prev, activeRun: { ...prev.activeRun, partialAssistantText: prev.activeRun.partialAssistantText + event.payload.delta } }
        : prev,
    );
    return;
  }
  if (event.type === "tool.requested") {
    setState((prev) => {
      const committed = commitPendingText(prev, event.conversationId);
      if (!committed.activeRun) return committed;
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return { ...committed, conversation: appendItem(committed, event.conversationId, callItem) };
    });
    return;
  }
  if (event.type === "action.approval-required") {
    setState((prev) => {
      const committed = commitPendingText(prev, event.conversationId);
      if (!committed.activeRun) return committed;
      // A memory change under the Ask policy pauses a browser program whose call is already shown.
      const shown = committed.conversation.items.some((item) => item.kind === "tool-call" && item.call.id === event.payload.call.id);
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return {
        ...committed,
        activeRun: { ...committed.activeRun, status: "awaiting-approval", pendingApproval: event.payload },
        conversation: shown ? committed.conversation : appendItem(committed, event.conversationId, callItem),
      };
    });
    return;
  }
  if (event.type === "help.requested") {
    setState((prev) => {
      const committed = commitPendingText(prev, event.conversationId);
      if (!committed.activeRun) return committed;
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return {
        ...committed,
        activeRun: { ...committed.activeRun, status: "awaiting-help", pendingHelp: event.payload },
        conversation: appendItem(committed, event.conversationId, callItem),
      };
    });
    return;
  }
  if (event.type === "tool.result") {
    setState((prev) => {
      if (!prev.activeRun) return prev;
      const resultItem: ConversationItem = {
        id: `${event.payload.callId}-result`,
        kind: "tool-result",
        callId: event.payload.callId,
        result: event.payload.result,
        ...(event.payload.memory ? { memory: event.payload.memory } : {}),
        at: event.at,
      };
      const stillPending = prev.activeRun.pendingApproval?.call.id === event.payload.callId ? null : prev.activeRun.pendingApproval;
      const helpPending = prev.activeRun.pendingHelp?.call.id === event.payload.callId ? null : prev.activeRun.pendingHelp;
      return {
        ...prev,
        activeRun: {
          ...prev.activeRun,
          status: stillPending ? "awaiting-approval" : helpPending ? "awaiting-help" : "running",
          pendingApproval: stillPending,
          pendingHelp: helpPending,
        },
        conversation: appendItem(prev, event.conversationId, resultItem),
      };
    });
    return;
  }
  if (event.type === "run.completed") {
    activeRunIdRef.current = null;
    setState((prev) => {
      if (!prev.activeRun) return prev;
      if (!prev.activeRun.partialAssistantText) return endRun(prev, event.conversationId, event.at);
      const assistantItem: ConversationItem = {
        id: event.payload.messageId,
        kind: "message",
        role: "assistant",
        text: prev.activeRun.partialAssistantText,
        at: event.at,
      };
      return endRun({ ...prev, conversation: appendItem(prev, event.conversationId, assistantItem, event.at) }, event.conversationId, event.at);
    });
    return;
  }
  if (event.type === "run.cancelled") {
    activeRunIdRef.current = null;
    setState((prev) => {
      if (!prev.activeRun) return prev;
      if (!event.payload.messageId) return endRun(prev, event.conversationId, event.at);
      const assistantItem: ConversationItem = {
        id: event.payload.messageId,
        kind: "message",
        role: "assistant",
        text: `${prev.activeRun.partialAssistantText}${RUN_CANCELLED_SUFFIX}`,
        at: event.at,
      };
      return endRun({ ...prev, conversation: appendItem(prev, event.conversationId, assistantItem, event.at) }, event.conversationId, event.at);
    });
    return;
  }
  if (event.type === "run.failed") {
    activeRunIdRef.current = null;
    // Retry targets the open session, so only a failure there offers it.
    setState((prev) => ({ ...endRun(prev, event.conversationId, event.at), lastError: event.conversationId === prev.conversation.id ? event.payload : prev.lastError }));
  }
}
