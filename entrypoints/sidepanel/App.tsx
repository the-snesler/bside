import { useState } from "preact/hooks";
import { useBackground } from "@/lib/ui/use-background";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { PageArtifactSummary, ToolCall, ToolResult } from "@/lib/domain/tools";
import type { ConversationItem } from "@/lib/domain/conversation";

function lastUserPrompt(items: ConversationItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === "message" && item.role === "user") return item.text;
  }
  return null;
}

function describeAttachment(page: PageArtifactSummary): string {
  let origin = page.url;
  try {
    origin = new URL(page.url).origin;
  } catch {
    // Keep the raw URL if it does not parse.
  }
  return page.title ? `${page.title} · ${origin}` : origin;
}

/** Fallback label for a historical tool-call row; the richer live pseudo-code lives on the pending approval itself. */
function describeToolCall(call: ToolCall): string {
  if (call.name === "page_snapshot") return "Captured a page snapshot";
  if (call.name === "page_scroll") return "Scrolled the page";
  if (call.name === "page_click") return "Clicked an element";
  if (call.name === "page_fill") return "Filled a field";
  if (call.name === "page_select_option") return "Selected an option";
  if (call.name === "page_set_checked") return "Checked/unchecked a control";
  if (call.name === "page_navigate") return "Navigated to a new page";
  if (call.name === "page_go_back") return "Went back";
  return call.name;
}

type TimelineEntry =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string }
  | { kind: "activity"; id: string; call: ToolCall; result: Omit<ToolResult, "data"> | null };

function buildTimeline(items: ConversationItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const activityIndexByCallId = new Map<string, number>();

  for (const item of items) {
    if (item.kind === "message") {
      entries.push({ kind: "message", id: item.id, role: item.role, text: item.text });
    } else if (item.kind === "tool-call") {
      activityIndexByCallId.set(item.call.id, entries.length);
      entries.push({ kind: "activity", id: item.id, call: item.call, result: null });
    } else if (item.kind === "tool-result") {
      const index = activityIndexByCallId.get(item.callId);
      const entry = index !== undefined ? entries[index] : undefined;
      if (entry?.kind === "activity") entry.result = item.result;
    }
  }
  return entries;
}

function ActivityRow(props: {
  entry: Extract<TimelineEntry, { kind: "activity" }>;
  pendingDisplay: string | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { entry, pendingDisplay, onApprove, onDeny } = props;
  const isPending = pendingDisplay !== null;
  const label = pendingDisplay ?? describeToolCall(entry.call);
  const status = isPending ? "Waiting for approval" : entry.result ? (entry.result.ok ? "Done" : entry.result.summary) : "Running…";

  return (
    <li class="timeline__item timeline__item--tool">
      <details class="activity" open={isPending}>
        <summary class="activity__summary" aria-label={`${label}: ${status}`}>
          <span class={`activity__status activity__status--${isPending ? "pending" : entry.result?.ok ? "ok" : entry.result ? "error" : "running"}`}>
            {isPending ? "⏳" : entry.result?.ok ? "✓" : entry.result ? "✕" : "…"}
          </span>
          <span class="activity__label">{label}</span>
        </summary>
        <div class="activity__detail">
          <code class="tool-call">{JSON.stringify(entry.call.arguments)}</code>
          {entry.result && <p class="activity__result">{entry.result.summary}</p>}
        </div>
        {isPending && (
          <div class="activity__actions">
            <button type="button" class="activity__approve" onClick={onApprove}>
              Approve
            </button>
            <button type="button" class="activity__deny" onClick={onDeny}>
              Deny
            </button>
          </div>
        )}
      </details>
    </li>
  );
}

export function App() {
  const { conversation, page, activeRun, notice, lastError, credential, settings, sendPrompt, cancelRun, approveAction, denyAction } =
    useBackground();
  const [draft, setDraft] = useState("");

  const composerDisabled = activeRun !== null || !credential.configured;
  const modelName = OPENAI_PROVIDER.models.find((model) => model.id === settings.modelId)?.name ?? settings.modelId;
  const timeline = buildTimeline(conversation.items);
  const pendingApproval = activeRun?.pendingApproval ?? null;

  const submitDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed || composerDisabled) return;
    sendPrompt(trimmed);
    setDraft("");
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    }
  };

  const handleRetry = () => {
    const prompt = lastUserPrompt(conversation.items);
    if (prompt) sendPrompt(prompt);
  };

  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <h1 class="sidebar__title">bside</h1>
        <div class="sidebar__settings-link">
          <span class="sidebar__settings-summary">
            {modelName} · {settings.reasoningEffort}
          </span>
          <button type="button" class="sidebar__settings" onClick={() => browser.runtime.openOptionsPage()}>
            Settings
          </button>
        </div>
      </header>

      <div class="sidebar__chip" title={page?.url}>
        {page ? describeAttachment(page) : "Unsupported page"}
      </div>

      <main class="sidebar__body">
        {timeline.length === 0 && !activeRun ? (
          <p class="sidebar__empty">
            {page ? `Ask about ${page.title || "this page"}, or start a conversation.` : "Open a page, then start a conversation."}
          </p>
        ) : (
          <ul class="timeline">
            {timeline.map((entry) =>
              entry.kind === "message" ? (
                <li key={entry.id} class={`timeline__item timeline__item--${entry.role}`}>
                  <span class="timeline__role">{entry.role === "user" ? "You" : "bside"}</span>
                  <p class="timeline__text">{entry.text}</p>
                </li>
              ) : (
                <ActivityRow
                  key={entry.id}
                  entry={entry}
                  pendingDisplay={pendingApproval?.call.id === entry.call.id ? pendingApproval.display : null}
                  onApprove={() => approveAction(entry.call.id)}
                  onDeny={() => denyAction(entry.call.id)}
                />
              ),
            )}
            {activeRun?.partialAssistantText && (
              <li class="timeline__item timeline__item--assistant timeline__item--streaming">
                <span class="timeline__role">bside</span>
                <p class="timeline__text">
                  {activeRun.partialAssistantText}
                  <span class="timeline__cursor" aria-hidden="true"></span>
                </p>
              </li>
            )}
          </ul>
        )}

        {lastError && (
          <p class="sidebar__error">
            {lastError.message}
            {lastError.retryable && (
              <button type="button" class="sidebar__retry" onClick={handleRetry}>
                Retry
              </button>
            )}
          </p>
        )}
        {notice && <p class="sidebar__notice">{notice}</p>}
      </main>

      <footer class="sidebar__composer">
        <textarea
          class="sidebar__input"
          value={draft}
          disabled={composerDisabled}
          placeholder={credential.configured ? "Ask about this page…" : "Add an API key in settings to start."}
          onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
        />
        {activeRun ? (
          <button type="button" class="sidebar__stop" onClick={cancelRun}>
            Stop
          </button>
        ) : (
          <button type="button" class="sidebar__send" onClick={submitDraft} disabled={composerDisabled || draft.trim().length === 0}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}
