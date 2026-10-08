import { useState } from "preact/hooks";
import Settings from "~icons/tabler/settings";
import Download from "~icons/tabler/download";
import Refresh from "~icons/tabler/refresh";
import Globe from "~icons/tabler/world";
import ArrowDown from "~icons/tabler/arrow-down";
import Check from "~icons/tabler/check";
import X from "~icons/tabler/x";
import Loader from "~icons/tabler/loader-2";
import Shield from "~icons/tabler/shield-check";
import { Markdown } from "@/lib/ui/Markdown";
import { Composer } from "@/lib/ui/Composer";
import { useBottomScroll } from "@/lib/ui/use-bottom-scroll";
import type { ReasoningEffort } from "@/lib/domain/provider";
import { useBackground } from "@/lib/ui/use-background";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type {
  PageArtifactSummary,
  ToolCall,
  ToolResult,
} from "@/lib/domain/tools";
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
  if (call.name === "browser_program") {
    const args = call.arguments;
    const source =
      args &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      typeof args.source === "string"
        ? args.source
        : "";
    const actions: [RegExp, string][] = [
      [/\.setInputFiles\(/, "Attaching a file"],
      [/\.click\(|\.press\(/, "Clicking a page control"],
      [/\.fill\(/, "Filling page fields"],
      [/\.selectOption\(/, "Selecting an option"],
      [/\.setChecked\(|\.check\(|\.uncheck\(/, "Updating a checkbox"],
      [/web\.search\(/, "Searching the web"],
      [/\.navigate\(|\.goBack\(|browser\.open\(/, "Opening a page"],
      [/fs\.remove\(/, "Removing a file or tab"],
      [/fs\.move\(/, "Moving a file or tab"],
      [/fs\.write\(/, "Writing a scratch file"],
      [/\.scroll\(/, "Scrolling the page"],
      [/\.find\(|\.waitFor\(/, "Searching page content"],
      [/fs\.read\(|\.snapshot\(/, "Reading page content"],
      [/fs\.list\(/, "Listing tabs and files"],
    ];
    return (
      actions.find(([pattern]) => pattern.test(source))?.[1] ??
      "Running browser program"
    );
  }
  if (call.name === "request_action_confirmation") return "Action confirmation";
  return call.name;
}

type TimelineEntry =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string }
  | {
      kind: "activity";
      id: string;
      call: ToolCall;
      result: Omit<ToolResult, "data"> | null;
    };

function buildTimeline(items: ConversationItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const activityIndexByCallId = new Map<string, number>();

  for (const item of items) {
    if (item.kind === "message") {
      entries.push({
        kind: "message",
        id: item.id,
        role: item.role,
        text: item.text,
      });
    } else if (item.kind === "tool-call") {
      activityIndexByCallId.set(item.call.id, entries.length);
      entries.push({
        kind: "activity",
        id: item.id,
        call: item.call,
        result: null,
      });
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
  const status = isPending
    ? "Waiting for approval"
    : entry.result
      ? entry.result.ok
        ? "Done"
        : entry.result.summary
      : "Running…";
  const args = entry.call.arguments;
  const confirmation =
    entry.call.name === "request_action_confirmation" &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args)
      ? args
      : null;

  return (
    <li class="timeline__item timeline__item--tool">
      <details class="activity" open={isPending}>
        <summary class="activity__summary" aria-label={`${label}: ${status}`}>
          <span
            class={`activity__status activity__status--${isPending ? "pending" : entry.result?.ok ? "ok" : entry.result ? "error" : "running"}`}
          >
            {isPending ? (
              <Shield />
            ) : entry.result?.ok ? (
              <Check />
            ) : entry.result ? (
              <X />
            ) : (
              <Loader class="spin" />
            )}
          </span>
          <span class="activity__label">{label}</span>
        </summary>
        <div class="activity__detail">
          {confirmation ? (
            <>
              <p>
                {typeof confirmation.message === "string"
                  ? confirmation.message
                  : ""}
              </p>
              {typeof confirmation.artifact === "string" &&
                confirmation.artifact && (
                  <pre
                    class="tool-call"
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {confirmation.artifact}
                  </pre>
                )}
            </>
          ) : (
            <code class="tool-call">
              {JSON.stringify(entry.call.arguments)}
            </code>
          )}
          {entry.result && (
            <p class="activity__result">{entry.result.summary}</p>
          )}
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
  const {
    conversation,
    page,
    activeRun,
    notice,
    lastError,
    credential,
    settings,
    tabs,
    listTabs,
    saveSettings,
    sendPrompt,
    cancelRun,
    approveAction,
    denyAction,
    resetContext,
    downloadContext,
  } = useBackground();
  const [confirmReset, setConfirmReset] = useState(false);
  const scroll = useBottomScroll();

  const composerDisabled = activeRun !== null || !credential.configured;
  const model =
    OPENAI_PROVIDER.models.find((model) => model.id === settings.modelId) ??
    OPENAI_PROVIDER.models[1];
  const timeline = buildTimeline(conversation.items);
  const pendingApproval = activeRun?.pendingApproval ?? null;

  const handleRetry = () => {
    const prompt = lastUserPrompt(conversation.items);
    if (prompt) sendPrompt(prompt);
  };

  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <h1 class="sidebar__title">bside</h1>
        <div class="sidebar__header-actions">
          <button
            type="button"
            class="icon-button"
            onClick={downloadContext}
            aria-label="Download context"
            title="Download context (may contain private page content)"
          >
            <Download />
          </button>
          <button
            type="button"
            class="icon-button"
            disabled={activeRun !== null}
            onClick={() => setConfirmReset(!confirmReset)}
            aria-label="Reset context"
            title="Reset context"
          >
            <Refresh />
          </button>
          <button
            type="button"
            class="icon-button"
            onClick={() => browser.runtime.openOptionsPage()}
            aria-label="Settings"
            title="Settings"
          >
            <Settings />
          </button>
        </div>
      </header>
      {confirmReset && (
        <div
          class="reset-confirmation"
          role="group"
          aria-label="Confirm context reset"
        >
          <p>
            Clear this conversation and scratch files? Tabs and settings stay.
          </p>
          <button
            type="button"
            disabled={!!activeRun}
            onClick={() => {
              resetContext();
              setConfirmReset(false);
            }}
          >
            Clear context
          </button>
          <button type="button" onClick={() => setConfirmReset(false)}>
            Cancel
          </button>
        </div>
      )}
      <main class="sidebar__body" ref={scroll.viewport}>
        <div ref={scroll.content}>
          {timeline.length === 0 && !activeRun ? (
            <p class="sidebar__empty">
              {page
                ? `Ask about ${page.title || "this page"}, or start a conversation.`
                : "Open a page, then start a conversation."}
            </p>
          ) : (
            <ul class="timeline">
              {timeline.map((entry) =>
                entry.kind === "message" ? (
                  <li
                    key={entry.id}
                    class={`timeline__item timeline__item--${entry.role}`}
                  >
                    {entry.role === "user" ? (
                      <p class="timeline__text">{entry.text}</p>
                    ) : (
                      <Markdown text={entry.text} />
                    )}
                  </li>
                ) : (
                  <ActivityRow
                    key={entry.id}
                    entry={entry}
                    pendingDisplay={
                      pendingApproval?.call.id === entry.call.id
                        ? pendingApproval.display
                        : null
                    }
                    onApprove={() => approveAction(entry.call.id)}
                    onDeny={() => denyAction(entry.call.id)}
                  />
                ),
              )}
              {activeRun?.partialAssistantText && (
                <li class="timeline__item timeline__item--assistant timeline__item--streaming">
                  <Markdown text={activeRun.partialAssistantText} />
                </li>
              )}
            </ul>
          )}

          {lastError && (
            <p class="sidebar__error">
              {lastError.message}
              {lastError.retryable && (
                <button
                  type="button"
                  class="sidebar__retry"
                  onClick={handleRetry}
                >
                  Retry
                </button>
              )}
            </p>
          )}
          {notice && <p class="sidebar__notice">{notice}</p>}
        </div>
      </main>
      {!scroll.atBottom && (
        <div class="scroll-latest">
          <button
            type="button"
            class="icon-button"
            onClick={scroll.scrollToBottom}
            aria-label="Scroll to latest"
            title="Scroll to latest"
          >
            <ArrowDown />
          </button>
        </div>
      )}
      <footer class="sidebar__composer">
        <div class="composer">
          {page && (
            <div class="context-chip" title={describeAttachment(page)}>
              <Globe />
              <span>
                <strong>{page.title || "Current tab"}</strong>
                <small>{new URL(page.url).hostname}</small>
              </span>
            </div>
          )}
          <Composer
            disabled={composerDisabled}
            running={!!activeRun}
            configured={credential.configured}
            tabs={tabs}
            onListTabs={listTabs}
            onSend={(text) => {
              scroll.scrollToBottom();
              sendPrompt(text);
            }}
            onStop={cancelRun}
          />
        </div>
        <div class="composer__settings">
          <select
            aria-label="Model"
            title="Model"
            value={settings.modelId}
            disabled={!!activeRun}
            onChange={(event) => {
              const next = OPENAI_PROVIDER.models.find(
                (candidate) => candidate.id === event.currentTarget.value,
              )!;
              saveSettings({
                ...settings,
                modelId: next.id,
                reasoningEffort: next.reasoningEfforts.includes(
                  settings.reasoningEffort,
                )
                  ? settings.reasoningEffort
                  : next.defaultReasoningEffort,
              });
            }}
          >
            {OPENAI_PROVIDER.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Reasoning effort"
            title="Reasoning effort"
            value={settings.reasoningEffort}
            disabled={!!activeRun}
            onChange={(event) =>
              saveSettings({
                ...settings,
                reasoningEffort: event.currentTarget.value as ReasoningEffort,
              })
            }
          >
            {model.reasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort[0]!.toUpperCase() + effort.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </footer>
    </div>
  );
}
