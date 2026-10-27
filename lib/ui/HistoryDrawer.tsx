/**
 * Sidebar history drawer: the background's session index (pinned first, then
 * most recent), filtered by title, with per-row open, rename, pin, export, and
 * delete. Deleting a chat that owns hidden agent tabs asks whether to close
 * them or keep them as ordinary tabs. Every action is a background command;
 * titles are untrusted text.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import Download from "~icons/tabler/download";
import Pencil from "~icons/tabler/pencil";
import Pin from "~icons/tabler/pin";
import PinnedOff from "~icons/tabler/pinned-off";
import Search from "~icons/tabler/search";
import Trash from "~icons/tabler/trash";
import type { ConversationSummary } from "@/lib/domain/conversation";
import { MAX_SESSION_TITLE_LEN, validateSessionTitle } from "@/lib/validation";
import { describeSessionUsage } from "@/lib/ui/usage";

export interface HistoryDrawerProps {
  /** In display order, as the background lists them. */
  sessions: readonly ConversationSummary[];
  openId: string;
  /** The single active run, if any, and what it is waiting on the user for. */
  run: { conversationId: string; waitingFor: "confirmation" | "help" | null } | null;
  /** Hidden agent tabs per session id. */
  agentTabs: Readonly<Record<string, number>>;
  now: number;
  onOpen(sessionId: string): void;
  onRename(sessionId: string, title: string): void;
  onPin(sessionId: string, pinned: boolean): void;
  onExport(sessionId: string): void;
  /** `closeAgentTabs` false keeps the chat's agent tabs, shown as ordinary tabs. */
  onDelete(sessionId: string, closeAgentTabs: boolean): void;
  onClose(): void;
}

const UNTITLED = "New chat";

/** Compact recency for narrow rows: "Just now", "5m ago", "3h ago", "2d ago", then a date. */
export function formatRelativeTime(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Case-insensitive title match; untitled sessions match by their displayed "New chat". */
export function filterSessions(sessions: readonly ConversationSummary[], query: string): ConversationSummary[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => !needle || (session.title || UNTITLED).toLowerCase().includes(needle));
}

export function HistoryDrawer(props: HistoryDrawerProps) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  const matches = filterSessions(props.sessions, query);
  const pinned = matches.filter((session) => session.pinned);
  const recent = matches.filter((session) => !session.pinned);
  const rowProps = { ...props, focusSearch: () => search.current?.focus() };

  return (
    <section
      id="history-drawer"
      class="history"
      aria-label="Chat history"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        props.onClose();
      }}
    >
      <label class="history__search">
        <Search aria-hidden="true" />
        <input
          ref={search}
          type="search"
          value={query}
          placeholder="Search chats"
          aria-label="Search chats by title"
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div class="history__list">
        {matches.length === 0 ? (
          <p class="history__empty">{query.trim() ? "No chats match." : "No chats yet."}</p>
        ) : (
          <>
            {pinned.length > 0 && <Group {...rowProps} label="Pinned" sessions={pinned} />}
            {recent.length > 0 && <Group {...rowProps} label={pinned.length > 0 ? "Recent" : null} sessions={recent} />}
          </>
        )}
      </div>
    </section>
  );
}

type RowProps = HistoryDrawerProps & { focusSearch(): void };

function Group({ label, sessions, ...props }: RowProps & { label: string | null }) {
  return (
    <>
      {label && <h2 class="history__group">{label}</h2>}
      <ul class="history__rows" aria-label={label ?? "Chats"}>
        {sessions.map((session) => <Row key={session.id} session={session} {...props} />)}
      </ul>
    </>
  );
}

type RowMode = "idle" | "renaming" | "confirming";

function Row({ session, openId, run, agentTabs, now, onOpen, onRename, onPin, onExport, onDelete, focusSearch }: Omit<RowProps, "sessions" | "onClose"> & { session: ConversationSummary }) {
  const [mode, setMode] = useState<RowMode>("idle");
  const previousMode = useRef<RowMode>("idle");
  /** Set once a rename finished, so the blur that follows Enter or Escape does not finish it again. */
  const renameDone = useRef(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === "renaming") {
      renameInput.current?.focus();
      renameInput.current?.select();
    } else if (mode === "confirming") {
      cancelButton.current?.focus();
    } else if (previousMode.current !== "idle" && (!document.activeElement || document.activeElement === document.body)) {
      // Return focus to the control that started the step, unless the user already moved it.
      (previousMode.current === "renaming" ? renameButton : deleteButton).current?.focus();
    }
    previousMode.current = mode;
  }, [mode]);

  const label = session.title || UNTITLED;
  const isOpen = session.id === openId;
  const runHere = run?.conversationId === session.id;
  const updated = new Date(session.updatedAt);
  const tabs = agentTabs[session.id] ?? 0;
  const tabsLabel = `${tabs} hidden ${tabs === 1 ? "tab" : "tabs"}`;
  const usage = describeSessionUsage(session.usage);
  const confirmDelete = (closeAgentTabs: boolean) => {
    onDelete(session.id, closeAgentTabs);
    // The row goes away once the background confirms; keep focus inside the drawer.
    focusSearch();
    setMode("idle");
  };

  const finishRename = (value: string | null) => {
    if (renameDone.current) return;
    renameDone.current = true;
    const title = value === null ? null : validateSessionTitle(value);
    if (title && title !== session.title) onRename(session.id, title);
    setMode("idle");
  };

  return (
    <li class="history__row" data-open={isOpen || undefined} data-wrap={(mode === "confirming" && tabs > 0) || undefined} aria-current={isOpen ? "true" : undefined}>
      {mode === "renaming" ? (
        <input
          ref={renameInput}
          class="history__rename"
          aria-label="Chat title"
          maxLength={MAX_SESSION_TITLE_LEN}
          defaultValue={session.title}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finishRename(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finishRename(null);
            }
          }}
          onBlur={(event) => finishRename(event.currentTarget.value)}
        />
      ) : (
        <button type="button" class="history__open" title={label} onClick={() => onOpen(session.id)}>
          <span class="history__title">{label}</span>
          <span class="history__meta">
            <time dateTime={updated.toISOString()} title={updated.toLocaleString()}>{formatRelativeTime(session.updatedAt, now)}</time>
            {isOpen && " · Current"}
            {session.scheduled && " · Scheduled"}
            {tabs > 0 && ` · ${tabsLabel}`}
            {runHere && <span class="history__status">{run!.waitingFor === "confirmation" ? " · Needs confirmation" : run!.waitingFor === "help" ? " · Needs your help" : " · Working"}</span>}
            {/* Last, so a narrow row truncates it before the status. */}
            {usage && <span class="history__usage" title={usage.title}>{` · ${usage.text}`}</span>}
          </span>
        </button>
      )}
      {mode === "confirming" ? (
        <div
          key="confirm"
          class="history__confirm"
          data-tabs={tabs > 0 || undefined}
          role="group"
          aria-label={`Delete ${label}?`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setMode("idle");
          }}
        >
          <span>{tabs > 0 ? `Delete? It has ${tabsLabel}.` : "Delete?"}</span>
          <button type="button" ref={cancelButton} onClick={() => setMode("idle")}>Cancel</button>
          {/* Plain Delete passes closeAgentTabs: tabs the chat gained after this row rendered are closed, not suddenly shown. */}
          {tabs > 0 && <button type="button" onClick={() => confirmDelete(false)}>Delete, keep tabs</button>}
          <button type="button" class="history__danger" onClick={() => confirmDelete(true)}>
            {tabs > 0 ? "Delete and close tabs" : "Delete"}
          </button>
        </div>
      ) : mode === "idle" && (
        <div key="actions" class="history__actions">
          <button
            type="button"
            class="icon-button"
            aria-label={`${session.pinned ? "Unpin" : "Pin"} ${label}`}
            title={session.pinned ? "Unpin" : "Pin (pinned chats are never deleted automatically)"}
            onClick={() => onPin(session.id, !session.pinned)}
          >
            {session.pinned ? <PinnedOff /> : <Pin />}
          </button>
          <button
            type="button"
            class="icon-button"
            ref={renameButton}
            aria-label={`Rename ${label}`}
            title="Rename"
            onClick={() => {
              renameDone.current = false;
              setMode("renaming");
            }}
          >
            <Pencil />
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label={`Export ${label}`}
            title="Export (may contain private page content)"
            onClick={() => onExport(session.id)}
          >
            <Download />
          </button>
          <button
            type="button"
            class="icon-button"
            ref={deleteButton}
            aria-label={`Delete ${label}`}
            title={runHere ? "Stop the run before deleting this chat" : "Delete"}
            disabled={runHere}
            onClick={() => setMode("confirming")}
          >
            <Trash />
          </button>
        </div>
      )}
    </li>
  );
}
