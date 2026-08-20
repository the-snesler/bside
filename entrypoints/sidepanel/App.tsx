import { useState } from "preact/hooks";
import { useBackground } from "@/lib/ui/use-background";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { PageArtifactSummary } from "@/lib/domain/tools";
import type { ConversationItem } from "@/lib/domain/conversation";

type MessageItem = Extract<ConversationItem, { kind: "message" }>;

function isMessageItem(item: ConversationItem): item is MessageItem {
  return item.kind === "message";
}

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

export function App() {
  const { conversation, page, activeRun, notice, lastError, credential, settings, sendPrompt, cancelRun } = useBackground();
  const [draft, setDraft] = useState("");

  const composerDisabled = activeRun !== null || !credential.configured;
  const modelName = OPENAI_PROVIDER.models.find((model) => model.id === settings.modelId)?.name ?? settings.modelId;
  const messages = conversation.items.filter(isMessageItem);

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
        {messages.length === 0 && !activeRun ? (
          <p class="sidebar__empty">
            {page ? `Ask about ${page.title || "this page"}, or start a conversation.` : "Open a page, then start a conversation."}
          </p>
        ) : (
          <ul class="timeline">
            {messages.map((item) => (
              <li key={item.id} class={`timeline__item timeline__item--${item.role}`}>
                <span class="timeline__role">{item.role === "user" ? "You" : "bside"}</span>
                <p class="timeline__text">{item.text}</p>
              </li>
            ))}
            {activeRun && (
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
