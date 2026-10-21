import { Fragment } from "preact";
import Settings from "~icons/tabler/settings";
import Download from "~icons/tabler/download";
import MessagePlus from "~icons/tabler/message-plus";
import Globe from "~icons/tabler/world";
import ArrowDown from "~icons/tabler/arrow-down";
import BrowserX from "~icons/tabler/browser-x";
import { Markdown } from "@/lib/ui/Markdown";
import { Composer, parsePromptMentions } from "@/lib/ui/Composer";
import { useBottomScroll } from "@/lib/ui/use-bottom-scroll";
import type { ReasoningEffort } from "@/lib/domain/provider";
import { useBackground } from "@/lib/ui/use-background";
import type { PageArtifactSummary } from "@/lib/domain/tools";
import { TurnTrace } from "@/lib/ui/TurnTrace";
import { buildTurns } from "@/lib/ui/turns";

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
  const {
    conversation,
    page,
    activeRun,
    notice,
    lastError,
    credential,
    provider,
    settings,
    tabs,
    listTabs,
    focusTab,
    agentTabs,
    closeAgentTabs,
    saveSettings,
    sendPrompt,
    retryRun,
    cancelRun,
    approveAction,
    denyAction,
    newChat,
    openSession,
    downloadContext,
  } = useBackground();
  const scroll = useBottomScroll();

  // One run at a time across all chats; it may belong to a chat other than the one on screen.
  const composerDisabled = activeRun !== null || !credential.configured;
  const runHere = activeRun !== null && activeRun.conversationId === conversation.id;
  const model =
    provider.models.find((model) => model.id === settings.modelId) ??
    provider.models[0];
  const turns = buildTurns(conversation.items, runHere);
  const pendingApproval = runHere ? activeRun.pendingApproval : null;

  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <h1 class="sidebar__title" title={conversation.title || undefined}>bside</h1>
        <div class="sidebar__header-actions">
          {agentTabs > 0 && (
            <button
              type="button"
              class="icon-button agent-tabs-button"
              disabled={activeRun !== null}
              onClick={closeAgentTabs}
              aria-label={`Close ${agentTabs} agent ${agentTabs === 1 ? "tab" : "tabs"}`}
              title={`Close ${agentTabs} hidden agent ${agentTabs === 1 ? "tab" : "tabs"} (unused ones close after 30 minutes)`}
            >
              <BrowserX />
              <span>{agentTabs}</span>
            </button>
          )}
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
            onClick={newChat}
            aria-label="New chat"
            title="New chat"
          >
            <MessagePlus />
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
      {activeRun && !runHere && (
        <div class="run-elsewhere" role="status">
          <p>
            {activeRun.pendingApproval
              ? "Another chat is waiting for your confirmation."
              : "bside is working in another chat."}
          </p>
          <button type="button" onClick={() => openSession(activeRun.conversationId)}>
            Show
          </button>
        </div>
      )}
      <main class="sidebar__body" ref={scroll.viewport}>
        <div ref={scroll.content}>
          {turns.length === 0 && !runHere ? (
            <p class="sidebar__empty">
              {page
                ? `Ask about ${page.title || "this page"}, or start a conversation.`
                : "Open a page, then start a conversation."}
            </p>
          ) : (
            <ul class="timeline">
              {turns.map((turn, index) => (
                <Fragment key={turn.id}>
                  {turn.prompt && (
                    <li class="timeline__item timeline__item--user">
                      <p class="timeline__text">
                        {parsePromptMentions(turn.prompt.text).map((segment) =>
                          segment.kind === "text" ? (
                            segment.text
                          ) : segment.agentTab ? (
                            <span class="tab-mention" title={segment.url}>
                              @{segment.label}
                            </span>
                          ) : (
                            <button
                              type="button"
                              class="tab-mention tab-mention--link"
                              title={`Switch to ${segment.url}`}
                              onClick={() => focusTab(segment.tabId)}
                            >
                              @{segment.label}
                            </button>
                          ),
                        )}
                      </p>
                    </li>
                  )}
                  {(turn.steps.length > 0 ||
                    (runHere && index === turns.length - 1)) && (
                    <li class="timeline__item timeline__item--work">
                      <TurnTrace
                        turn={turn}
                        active={runHere && index === turns.length - 1}
                        pendingApproval={pendingApproval}
                        onApprove={approveAction}
                        onDeny={denyAction}
                      />
                    </li>
                  )}
                  {turn.answer && (
                    <li class="timeline__item timeline__item--assistant">
                      <Markdown text={turn.answer.text} />
                    </li>
                  )}
                </Fragment>
              ))}
              {runHere && activeRun.partialAssistantText && (
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
                  onClick={retryRun}
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
              const next = provider.models.find(
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
            {provider.models.map((model) => (
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
            {model?.reasoningEfforts.map((effort) => (
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
