/**
 * Preact hook connecting a UI surface to the background's
 * "agent-sidebar:v1" Port. The sidebar renders this state; it never owns an
 * inference request, tool loop, transcript authority, or credential read.
 * Between full `state.snapshot` syncs, run-lifecycle events are applied
 * incrementally so the composer/timeline update live without re-fetching.
 * Each run in `runs` may belong to another session than the open one: its
 * events always update that run, but change `conversation` only when their
 * `conversationId` is the open session's.
 *
 * Run events are sequenced per run. An event at or below its run's applied
 * seq is a duplicate and is skipped; one past the next seq means events were
 * missed, so it is skipped and `state.subscribe` names every run's applied
 * seq, getting back the missed events or a full snapshot. Run events before
 * the first snapshot are skipped (the snapshot or a later gap covers them).
 * Every other event has seq 0 and is applied as it comes.
 */

import type { McpContentChoice, McpContentSnapshot } from "@/lib/domain/mcp-content";
import type { McpContentReply, WorkspaceImageReply } from "@/lib/protocol";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Browser } from "wxt/browser";
import { isRunEvent, MAX_SUBSCRIBE_RUNS, RUN_CANCELLED_SUFFIX, SIDEBAR_PORT_NAME, TERMINAL_RUN_EVENT_TYPES } from "@/lib/protocol";
import type { HelpOutcome, NormalizedError, RunState, RuntimeSnapshot, SidebarCommand, SidebarEvent } from "@/lib/protocol";
import type { Conversation, ConversationItem, ConversationSummary } from "@/lib/domain/conversation";
import type { AppSettingsV1 } from "@/lib/domain/provider";
import type { PermissionMode } from "@/lib/domain/permissions";
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
  mcpAttachments: McpContentSnapshot[];
  tabs: TabMention[];
  /** The session index, pinned first, then most recent. Requested on connect and pushed by the background whenever it changes. */
  sessions: ConversationSummary[];
  lastError: NormalizedError | null;
  /** The open "Remember something about this site" editor, if any. */
  siteNote: SiteNoteEditorState | null;
  memoryUndo: Record<string, MemoryUndoState>;
}

export interface BackgroundActions {
  listMcpContent(kind: "prompt" | "resource"): Promise<{ choices: McpContentChoice[]; errors: import("@/lib/protocol").NormalizedError[] }>;
  prepareMcpContent(choiceId: string, args: Record<string, string>): Promise<void>;
  dismissMcpContent(id: string): void;
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
  /** Sets the permission mode; allowed mid-run, where it applies at the run's next gated call. */
  savePermissionMode(mode: PermissionMode): void;
  /** Starts a run, or queues a follow-up while this chat's run is working. */
  sendPrompt(prompt: string, askId?: string, contentIds?: string[]): void;
  /** Guidance for the running turn, delivered at its next tool boundary. */
  steer(text: string, askId?: string, contentIds?: string[]): void;
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
  /** One of the open session's `/workspace` images, for model Markdown that shows it. */
  loadWorkspaceImage(sessionId: string, path: string): Promise<WorkspaceImageLoad>;
}

/** A workspace image as the background answered, or `unavailable` when the sidebar got no answer. */
export type WorkspaceImageLoad = WorkspaceImageReply | { ok: false; reason: "unavailable" };

/** Ended runs remembered so a late duplicate of their events is not mistaken for a new run. */
const ENDED_RUNS_REMEMBERED = 32;

/**
 * The sidebar side of per-run sequencing: the seq applied for each run in
 * progress, and of recently ended runs.
 */
export class RunSeqTracker {
  #live = new Map<string, number>();
  #ended = new Map<string, number>();
  /** Each run's applied seq when a gap in it last asked for a replay. */
  #asked = new Map<string, number>();
  #synced = false;

  /** A snapshot: its runs' seqs replace what was applied. */
  reset(runs: readonly RunState[]): void {
    this.#live = new Map(runs.map((run) => [run.runId, run.lastSeq]));
    for (const run of runs) this.#ended.delete(run.runId);
    this.#asked.clear();
    this.#synced = true;
  }

  /**
   * Whether to apply a run event: `apply` when it is its run's next one
   * (recording it), `skip` for a duplicate or before the first snapshot,
   * `gap` when earlier events are missing and no replay has been asked for
   * at this point yet, and `wait` when one has.
   */
  accept(event: { runId: string; seq: number; type: SidebarEvent["type"] }): "apply" | "skip" | "gap" | "wait" {
    if (!this.#synced) return "skip";
    const ended = this.#ended.get(event.runId);
    if (ended !== undefined && event.seq <= ended) return "skip";
    const applied = this.#live.get(event.runId) ?? 0;
    if (event.seq <= applied) return "skip";
    if (event.seq > applied + 1) {
      if (this.#asked.get(event.runId) === applied) return "wait";
      this.#asked.set(event.runId, applied);
      return "gap";
    }
    this.#asked.delete(event.runId);
    if (TERMINAL_RUN_EVENT_TYPES.has(event.type)) {
      this.#live.delete(event.runId);
      this.#ended.set(event.runId, event.seq);
      while (this.#ended.size > ENDED_RUNS_REMEMBERED) this.#ended.delete(this.#ended.keys().next().value!);
    } else {
      this.#live.set(event.runId, event.seq);
    }
    return "apply";
  }

  /** The `state.subscribe` seq map for a replay: the runs in progress, newest last, at most `MAX_SUBSCRIBE_RUNS`. */
  known(): Record<string, number> {
    return Object.fromEntries([...this.#live].slice(-MAX_SUBSCRIBE_RUNS));
  }
}

/** Images kept for re-renders (an answer moving from streaming to its turn); runs may change files, so it is cleared when one starts. */
const WORKSPACE_IMAGE_CACHE = 8;

const EMPTY_CONVERSATION: Conversation = {
  id: "", title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: 0, lastModelId: null, usage: EMPTY_USAGE, items: [],
};

const INITIAL_STATE: BackgroundState = {
  ask: null,
  focusVersion: 0,
  mcpAttachments: [],
  skills: [],
  tabs: [],
  sessions: [],
  conversation: EMPTY_CONVERSATION,
  credential: { configured: false, maskedSuffix: null, chatgpt: { connected: false, email: null, signInAgain: false } },
  provider: OPENAI_PROVIDER,
  settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
  permissionMode: "ask",
  page: null,
  agentTabs: { bySession: {}, watching: null, takenOver: false },
  queue: [],
  runs: [],
  notice: null,
  lastError: null,
  siteNote: null,
  memoryUndo: {},
};

type Port = Browser.runtime.Port;

export function useBackground(): BackgroundState & BackgroundActions {
  const [state, setState] = useState<BackgroundState>(INITIAL_STATE);
  const portRef = useRef<Port | null>(null);
  const seqsRef = useRef(new RunSeqTracker());
  const exportRequestRef = useRef<string | null>(null);
  /** The site-note request awaiting its reply; replies to an older or closed editor are dropped. */
  const siteNoteRequestRef = useRef<string | null>(null);
  /** Undo requests awaiting their reply, by request id. */
  const undoRequestsRef = useRef(new Map<string, string>());
  const contentRequests = useRef(new Map<string, (reply: McpContentReply) => void>());
  const imageRequests = useRef(new Map<string, (reply: WorkspaceImageLoad) => void>());
  const imageCache = useRef(new Map<string, Promise<WorkspaceImageLoad>>());
  const conversationIdRef = useRef("");
  conversationIdRef.current = state.conversation.id;
  /** The open session's run, which run commands (cancel, approve, deny, help, steer) address. */
  const openRunIdRef = useRef<string | null>(null);
  openRunIdRef.current = state.runs.find((run) => run.conversationId === state.conversation.id)?.runId ?? null;

  useEffect(() => {
    const port = browser.runtime.connect({ name: SIDEBAR_PORT_NAME });
    portRef.current = port;

    const onMessage = (message: unknown) => {
      const event = message as SidebarEvent;
      if (event.type === "mcp.content.reply") {
        contentRequests.current.get(event.payload.requestId)?.(event.payload.result);
        contentRequests.current.delete(event.payload.requestId);
        return;
      }
      if (event.type === "workspace.image.loaded") {
        imageRequests.current.get(event.payload.requestId)?.(event.payload.result);
        imageRequests.current.delete(event.payload.requestId);
        return;
      }
      if (event.type === "run.started") imageCache.current.clear();
      if (event.type === "mcp.content.accepted") {
        setState(prev => ({ ...prev, mcpAttachments: prev.mcpAttachments.filter(item => !event.payload.ids.includes(item.id)) }));
        return;
      }
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
      if (event.type === "state.snapshot") seqsRef.current.reset(event.payload.runs);
      if (isRunEvent(event)) {
        const verdict = seqsRef.current.accept(event);
        if (verdict === "gap") port.postMessage({ v: 1, id: crypto.randomUUID(), type: "state.subscribe", lastSeq: seqsRef.current.known() } satisfies SidebarCommand);
        if (verdict !== "apply") return;
      }
      applyEvent(event, setState);
    };
    port.onMessage.addListener(onMessage);

    const subscribe: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "state.subscribe", lastSeq: null };
    port.postMessage(subscribe);
    port.postMessage({ v: 1, id: crypto.randomUUID(), type: "session.list" } satisfies SidebarCommand);

    return () => {
      port.onMessage.removeListener(onMessage);
      port.disconnect();
      portRef.current = null;
      for (const resolve of contentRequests.current.values()) resolve({ ok: false, error: { code: "PROTOCOL_ERROR", phase: "setup", retryable: false, message: "The sidebar disconnected. Choose the content again." } });
      contentRequests.current.clear();
      for (const resolve of imageRequests.current.values()) resolve({ ok: false, reason: "unavailable" });
      imageRequests.current.clear();
      imageCache.current.clear();
    };
  }, []);

  const requestContent = (request: Extract<SidebarCommand, { type: "mcp.content.list" | "mcp.content.prepare" }>): Promise<McpContentReply> => new Promise((resolve, reject) => {
    if (!portRef.current) { reject(new Error("The sidebar is disconnected.")); return; }
    const timer = setTimeout(() => { contentRequests.current.delete(request.id); reject(new Error("Preparing MCP content timed out. Open the picker again.")); }, 65_000);
    contentRequests.current.set(request.id, result => { clearTimeout(timer); resolve(result); });
    portRef.current.postMessage(request);
  });
  const loadWorkspaceImage = useCallback<BackgroundActions["loadWorkspaceImage"]>((sessionId, path) => {
    const key = `${sessionId}\n${path}`;
    const cached = imageCache.current.get(key);
    if (cached) return cached;
    const request = new Promise<WorkspaceImageLoad>((resolve) => {
      if (!portRef.current) { resolve({ ok: false, reason: "unavailable" }); return; }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { imageRequests.current.delete(id); resolve({ ok: false, reason: "unavailable" }); }, 15_000);
      imageRequests.current.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      portRef.current.postMessage({ v: 1, id, type: "workspace.image", sessionId, path } satisfies SidebarCommand);
    });
    imageCache.current.set(key, request);
    while (imageCache.current.size > WORKSPACE_IMAGE_CACHE) imageCache.current.delete(imageCache.current.keys().next().value!);
    // Only images are kept: a file that is missing now may be saved later.
    void request.then((reply) => { if (!reply.ok && imageCache.current.get(key) === request) imageCache.current.delete(key); });
    return request;
  }, []);
  const listMcpContent: BackgroundActions["listMcpContent"] = async kind => {
    const result = await requestContent({ v: 1, id: crypto.randomUUID(), type: "mcp.content.list", kind, sessionId: conversationIdRef.current });
    if (!result.ok) throw new Error(result.error.message);
    if (!("choices" in result)) throw new Error("Unexpected MCP catalog response.");
    return result;
  };
  const prepareMcpContent: BackgroundActions["prepareMcpContent"] = async (choiceId, args) => {
    const result = await requestContent({ v: 1, id: crypto.randomUUID(), type: "mcp.content.prepare", choiceId, arguments: args, sessionId: conversationIdRef.current });
    if (!result.ok) throw new Error(result.error.message);
    if (!("snapshot" in result)) throw new Error("Unexpected MCP preparation response.");
    setState(prev => ({ ...prev, mcpAttachments: [...prev.mcpAttachments, result.snapshot] }));
  };
  const dismissMcpContent: BackgroundActions["dismissMcpContent"] = id => {
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "mcp.content.dismiss", sessionId: conversationIdRef.current, contentIds: [id] } satisfies SidebarCommand);
    setState(prev => ({ ...prev, mcpAttachments: prev.mcpAttachments.filter(item => item.id !== id) }));
  };

  const sendPrompt = useCallback((prompt: string, askId?: string, contentIds?: string[]) => {
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "run.start", prompt, ...(askId ? { askId } : {}), ...(contentIds?.length ? { contentIds, sessionId: conversationIdRef.current } : {}) };
    portRef.current?.postMessage(command);
  }, []);

  const steer = useCallback((text: string, askId?: string, contentIds?: string[]) => {
    const runId = openRunIdRef.current;
    // With no run to steer, the background treats the text as a normal prompt.
    portRef.current?.postMessage(runId
      ? { v: 1, id: crypto.randomUUID(), type: "run.steer", runId, text, ...(askId ? { askId } : {}), ...(contentIds?.length ? { contentIds, sessionId: conversationIdRef.current } : {}) } satisfies SidebarCommand
      : { v: 1, id: crypto.randomUUID(), type: "run.start", prompt: text, ...(askId ? { askId } : {}), ...(contentIds?.length ? { contentIds, sessionId: conversationIdRef.current } : {}) } satisfies SidebarCommand);
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
    const runId = openRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "run.cancel", runId };
    portRef.current?.postMessage(command);
  }, []);

  const approveAction = useCallback((callId: string) => {
    const runId = openRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "action.approve", runId, callId };
    portRef.current?.postMessage(command);
  }, []);

  const denyAction = useCallback((callId: string) => {
    const runId = openRunIdRef.current;
    if (!runId) return;
    const command: SidebarCommand = { v: 1, id: crypto.randomUUID(), type: "action.deny", runId, callId };
    portRef.current?.postMessage(command);
  }, []);

  const resolveHelp = useCallback((callId: string, outcome: HelpOutcome, note: string) => {
    const runId = openRunIdRef.current;
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
  const savePermissionMode = useCallback((mode: PermissionMode) => {
    setState((prev) => ({ ...prev, permissionMode: mode }));
    portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "permissions.save", mode } satisfies SidebarCommand);
  }, []);

  return {
    ...state, sendPrompt, steer, removeQueued, sendQueued, retryRun, cancelRun, approveAction, denyAction, resolveHelp, newChat, listSessions, openSession, renameSession, pinSession,
    listMcpContent, prepareMcpContent, dismissMcpContent,
    dismissAsk: (askId: string) => portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "ask.dismiss", askId } satisfies SidebarCommand),
    deleteSession, downloadContext, rememberSite, saveSiteNote, closeSiteNote, undoMemory, loadWorkspaceImage, listTabs, listSkills: () => portRef.current?.postMessage({ v: 1, id: crypto.randomUUID(), type: "skills.list" } satisfies SidebarCommand), focusTab, closeAgentTabs, watchTab, unwatchTab, takeOverTab, saveSettings, savePermissionMode,
  };
}

/** Appends a run item to the timeline only when the run belongs to the open session. */
function appendItem(prev: BackgroundState, conversationId: string | null, item: ConversationItem, updatedAt?: number): BackgroundState["conversation"] {
  if (conversationId !== prev.conversation.id) return prev.conversation;
  return { ...prev.conversation, items: [...prev.conversation.items, item], ...(updatedAt === undefined ? {} : { updatedAt }) };
}

function runOf(prev: BackgroundState, runId: string): RunState | undefined {
  return prev.runs.find((run) => run.runId === runId);
}

function patchRun(prev: BackgroundState, runId: string, patch: Partial<RunState>): BackgroundState {
  return { ...prev, runs: prev.runs.map((run) => run.runId === runId ? { ...run, ...patch } : run) };
}

/**
 * Drops an ended run, adding its usage as the `run-usage` item the background
 * persisted under the same id, after the run's last message. The usage item
 * is a no-op when no response reported tokens.
 */
function endRun(prev: BackgroundState, runId: string, conversationId: string | null, at: number): BackgroundState {
  const usage = runOf(prev, runId)?.usage;
  const conversation = usage ? appendItem(prev, conversationId, { id: `usage-${usage.runId}`, kind: "run-usage", usage, at }) : prev.conversation;
  return { ...prev, runs: prev.runs.filter((run) => run.runId !== runId), conversation };
}

function commitPendingText(prev: BackgroundState, runId: string, conversationId: string | null): BackgroundState {
  const run = runOf(prev, runId);
  if (!run || !run.partialAssistantText) return prev;
  const message: ConversationItem = {
    id: `${run.runId}-msg-${prev.conversation.items.length}`,
    kind: "message",
    role: "assistant",
    text: run.partialAssistantText,
    at: Date.now(),
  };
  return { ...patchRun(prev, runId, { partialAssistantText: "" }), conversation: appendItem(prev, conversationId, message) };
}

/** Applies one event. Run events update their own run (and record its seq); they change `conversation` only for the open session's run. */
function applyEvent(event: SidebarEvent, setState: (updater: (prev: BackgroundState) => BackgroundState) => void): void {
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
  if (event.type === "permissions.changed") {
    setState((prev) => ({ ...prev, permissionMode: event.payload.mode }));
    return;
  }
  if (event.type === "queue.changed") {
    setState((prev) => event.conversationId === prev.conversation.id ? { ...prev, queue: event.payload.messages } : prev);
    return;
  }
  if (!isRunEvent(event)) return;
  const runId = event.runId;
  // Every state a run event leaves its run in reflects that event's seq.
  const set = (updater: (prev: BackgroundState) => BackgroundState) => setState((prev) => {
    const next = updater(prev);
    return runOf(next, runId) ? patchRun(next, runId, { lastSeq: event.seq }) : next;
  });
  if (event.type === "steer.delivered") {
    set((prev) => {
      const committed = commitPendingText(prev, runId, event.conversationId);
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
    set((prev) => runOf(prev, runId) ? patchRun(prev, runId, { usage: event.payload.usage }) : prev);
    return;
  }
  if (event.type === "run.started") {
    set((prev) => {
      const userItem: ConversationItem = {
        id: `${runId}-user`,
        kind: "message",
        role: "user",
        text: event.payload.prompt,
        context: event.payload.page,
        ...(event.payload.ask ? { ask: event.payload.ask } : {}),
        ...(event.payload.scheduled ? { scheduled: event.payload.scheduled } : {}),
        ...(event.payload.content?.length ? { content: event.payload.content } : {}),
        at: event.at,
      };
      const conversationId = event.conversationId!;
      const run: RunState = { runId, conversationId, status: "running", partialAssistantText: "", pendingApproval: null, pendingHelp: null, usage: null, lastSeq: event.seq };
      return {
        ...prev,
        // A run starting in another chat leaves this chat's failure (and its Retry) in place.
        lastError: conversationId === prev.conversation.id ? null : prev.lastError,
        runs: [...prev.runs.filter((other) => other.runId !== runId), run],
        // A retry re-runs the turn's existing user message rather than adding one.
        conversation: event.payload.retry ? prev.conversation : appendItem(prev, conversationId, userItem, event.at),
      };
    });
    return;
  }
  if (event.type === "assistant.delta") {
    set((prev) => {
      const run = runOf(prev, runId);
      return run ? patchRun(prev, runId, { partialAssistantText: run.partialAssistantText + event.payload.delta }) : prev;
    });
    return;
  }
  if (event.type === "tool.requested") {
    set((prev) => {
      const committed = commitPendingText(prev, runId, event.conversationId);
      if (!runOf(committed, runId)) return committed;
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return { ...committed, conversation: appendItem(committed, event.conversationId, callItem) };
    });
    return;
  }
  if (event.type === "action.approval-required") {
    set((prev) => {
      const committed = commitPendingText(prev, runId, event.conversationId);
      if (!runOf(committed, runId)) return committed;
      // A memory change under the Ask policy pauses a browser program whose call is already shown.
      const shown = committed.conversation.items.some((item) => item.kind === "tool-call" && item.call.id === event.payload.call.id);
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return {
        ...patchRun(committed, runId, { status: "awaiting-approval", pendingApproval: event.payload }),
        conversation: shown ? committed.conversation : appendItem(committed, event.conversationId, callItem),
      };
    });
    return;
  }
  if (event.type === "help.requested") {
    set((prev) => {
      const committed = commitPendingText(prev, runId, event.conversationId);
      if (!runOf(committed, runId)) return committed;
      const callItem: ConversationItem = { id: `${event.payload.call.id}-call`, kind: "tool-call", call: event.payload.call, at: event.at };
      return {
        ...patchRun(committed, runId, { status: "awaiting-help", pendingHelp: event.payload }),
        conversation: appendItem(committed, event.conversationId, callItem),
      };
    });
    return;
  }
  if (event.type === "tool.result") {
    set((prev) => {
      const run = runOf(prev, runId);
      if (!run) return prev;
      const resultItem: ConversationItem = {
        id: `${event.payload.callId}-result`,
        kind: "tool-result",
        callId: event.payload.callId,
        result: event.payload.result,
        ...(event.payload.memory ? { memory: event.payload.memory } : {}),
        at: event.at,
      };
      const stillPending = run.pendingApproval?.call.id === event.payload.callId ? null : run.pendingApproval;
      const helpPending = run.pendingHelp?.call.id === event.payload.callId ? null : run.pendingHelp;
      return {
        ...patchRun(prev, runId, {
          status: stillPending ? "awaiting-approval" : helpPending ? "awaiting-help" : "running",
          pendingApproval: stillPending,
          pendingHelp: helpPending,
        }),
        conversation: appendItem(prev, event.conversationId, resultItem),
      };
    });
    return;
  }
  if (event.type === "run.completed") {
    set((prev) => {
      const run = runOf(prev, runId);
      if (!run) return prev;
      if (!run.partialAssistantText) return endRun(prev, runId, event.conversationId, event.at);
      const assistantItem: ConversationItem = {
        id: event.payload.messageId,
        kind: "message",
        role: "assistant",
        text: run.partialAssistantText,
        at: event.at,
      };
      return endRun({ ...prev, conversation: appendItem(prev, event.conversationId, assistantItem, event.at) }, runId, event.conversationId, event.at);
    });
    return;
  }
  if (event.type === "run.cancelled") {
    set((prev) => {
      const run = runOf(prev, runId);
      if (!run) return prev;
      if (!event.payload.messageId) return endRun(prev, runId, event.conversationId, event.at);
      const assistantItem: ConversationItem = {
        id: event.payload.messageId,
        kind: "message",
        role: "assistant",
        text: `${run.partialAssistantText}${RUN_CANCELLED_SUFFIX}`,
        at: event.at,
      };
      return endRun({ ...prev, conversation: appendItem(prev, event.conversationId, assistantItem, event.at) }, runId, event.conversationId, event.at);
    });
    return;
  }
  if (event.type === "run.failed") {
    // Retry targets the open session, so only a failure there offers it.
    set((prev) => ({ ...endRun(prev, runId, event.conversationId, event.at), lastError: event.conversationId === prev.conversation.id ? event.payload : prev.lastError }));
  }
}
