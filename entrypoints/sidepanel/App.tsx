import { Fragment } from "preact";
import { useState } from "preact/hooks";
import Settings from "~icons/tabler/settings";
import Download from "~icons/tabler/download";
import Refresh from "~icons/tabler/refresh";
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
    resetContext,
    downloadContext,
  } = useBackground();
  const [confirmReset, setConfirmReset] = useState(false);
  const scroll = useBottomScroll();

  const composerDisabled = activeRun !== null || !credential.configured;
  const model =
    provider.models.find((model) => model.id === settings.modelId) ??
    provider.models[0];
  const turns = buildTurns(conversation.items, activeRun !== null);
  const pendingApproval = activeRun?.pendingApproval ?? null;

  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <h1 class="sidebar__title">bside</h1>
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
          {turns.length === 0 && !activeRun ? (
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
                    (activeRun && index === turns.length - 1)) && (
                    <li class="timeline__item timeline__item--work">
                      <TurnTrace
                        turn={turn}
                        active={!!activeRun && index === turns.length - 1}
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
