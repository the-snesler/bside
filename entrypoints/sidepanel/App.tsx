import { McpContentChip } from "@/lib/ui/McpContentChip";
import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import History from "~icons/tabler/history";
import Settings from "~icons/tabler/settings";
import MessagePlus from "~icons/tabler/message-plus";
import Globe from "~icons/tabler/world";
import Eye from "~icons/tabler/eye";
import ArrowDown from "~icons/tabler/arrow-down";
import ArrowUp from "~icons/tabler/arrow-up";
import X from "~icons/tabler/x";
import NotePlus from "~icons/tabler/pencil-plus";
import ShieldCheck from "~icons/tabler/shield-check";
import Bolt from "~icons/tabler/bolt";
import { Markdown } from "@/lib/ui/Markdown";
import { Composer, parsePromptMentions } from "@/lib/ui/Composer";
import { useBottomScroll } from "@/lib/ui/use-bottom-scroll";
import type { ReasoningEffort } from "@/lib/domain/provider";
import type { PermissionMode } from "@/lib/domain/permissions";
import { useBackground } from "@/lib/ui/use-background";
import type { PageArtifactSummary } from "@/lib/domain/tools";
import { TurnTrace } from "@/lib/ui/TurnTrace";
import { buildTurns } from "@/lib/ui/turns";
import { describeTurnUsage } from "@/lib/ui/usage";
import { HistoryDrawer } from "@/lib/ui/HistoryDrawer";
import { Mascot } from "@/lib/ui/Mascot";
import { AgentTabsPanel, AgentTabsToggle } from "@/lib/ui/AgentTabsTray";
import { SiteNoteEditor } from "@/lib/ui/SiteNoteEditor";
import { MemoryNotice } from "@/lib/ui/MemoryNotice";
import { memoryUndoKey } from "@/lib/ui/use-background";
import { PROMPT_MENTION_PATTERN } from "@/lib/domain/conversation";
import { describeAsk } from "@/lib/domain/ask";
import { QUICK_ACTIONS } from "@/lib/domain/quick-actions";
import { AskChip } from "@/lib/ui/AskChip";
import { OtherRunsStrip, runAttention, type OtherRun } from "@/lib/ui/OtherRuns";

const PERMISSION_MODE_OPTIONS: { mode: PermissionMode; label: string; title: string; Icon: typeof ShieldCheck }[] = [
  { mode: "ask", label: "Ask first", title: "Asks before sending, submitting, buying, or deleting", Icon: ShieldCheck },
  { mode: "read-only", label: "Read-only", title: "Reads and answers only: clicks, typing, and account changes are refused", Icon: Eye },
  { mode: "auto", label: "Don't ask", title: "Acts without asking for confirmation, including sending, buying, and deleting", Icon: Bolt },
];

/** The permission mode beside the composer; changing it mid-run applies at the run's next gated call. */
function PermissionModeSelect(props: { mode: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const current = PERMISSION_MODE_OPTIONS.find((option) => option.mode === props.mode) ?? PERMISSION_MODE_OPTIONS[0]!;
  return (
    <label class={`composer__mode composer__mode--${current.mode}`} title={current.title}>
      <current.Icon aria-hidden="true" />
      <select
        aria-label="Permissions"
        value={current.mode}
        onChange={(event) => props.onChange(event.currentTarget.value as PermissionMode)}
      >
        {PERMISSION_MODE_OPTIONS.map((option) => (
          <option key={option.mode} value={option.mode} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
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
  const {
    conversation,
    page: activePage,
    runs,
    notice,
    lastError,
    credential,
    provider,
    settings,
    tabs,
    listTabs,
    skills = [],
    listSkills,
    focusTab,
    agentTabs,
    closeAgentTabs,
    watchTab,
    unwatchTab,
    takeOverTab,
    saveSettings,
    permissionMode,
    savePermissionMode,
    sendPrompt,
    listMcpContent, prepareMcpContent, dismissMcpContent, mcpAttachments,
    steer,
    queue,
    removeQueued,
    sendQueued,
    retryRun,
    cancelRun,
    approveAction,
    denyAction,
    resolveHelp,
    newChat,
    sessions,
    listSessions,
    openSession,
    renameSession,
    pinSession,
    deleteSession,
    downloadContext,
    siteNote,
    rememberSite,
    saveSiteNote,
    closeSiteNote,
    memoryUndo,
    undoMemory,
    loadWorkspaceImage,
    ask,
    dismissAsk,
    focusVersion,
  } = useBackground();
  const page = ask ? { tabId: ask.tabId, artifactId: `ask:${ask.id}`, kind: "page" as const, title: ask.pageTitle, url: ask.pageUrl, capturedAt: ask.at } : activePage;
  const scroll = useBottomScroll();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (ask) setDraft({ id: ask.id, text: `Tell me about this ${ask.kind}.` });
  }, [ask?.id]);
  useEffect(() => { setHistoryOpen(false); }, [focusVersion]);
  const historyButton = useRef<HTMLButtonElement>(null);
  const closeHistory = () => {
    setHistoryOpen(false);
    historyButton.current?.focus();
  };

  // At most one run per chat, and any number of chats may run at once. While
  // this chat's run works, the composer queues follow-ups and steers it;
  // runs in other chats never hold it back, and are listed in the strip.
  const hereRun = runs.find((run) => run.conversationId === conversation.id) ?? null;
  const runHere = hereRun !== null;
  const otherRuns: OtherRun[] = runs.filter((run) => run.conversationId !== conversation.id).map((run) => {
    const session = sessions.find((candidate) => candidate.id === run.conversationId);
    return { sessionId: run.conversationId, title: session ? session.title : "Another chat", attention: runAttention(run), stopping: run.status === "cancelling" };
  });
  const composerDisabled = !credential.configured;
  const model =
    provider.models.find((model) => model.id === settings.modelId) ??
    provider.models[0];
  const turns = buildTurns(conversation.items, runHere);
  const images = useMemo(() => ({ sessionId: conversation.id, load: loadWorkspaceImage }), [conversation.id, loadWorkspaceImage]);
  const pendingApproval = hereRun?.pendingApproval ?? null;
  const pendingHelp = hereRun?.pendingHelp ?? null;

  // This chat's agent tabs ride on the composer. The attached page is one of
  // them while the user watches it; another chat's agent tab is never shown as attached.
  const chatAgentTabs = agentTabs.bySession[conversation.id] ?? [];
  const watchedTab = chatAgentTabs.find((tab) => tab.id === agentTabs.watching) ?? null;
  const agentTabCounts = Object.fromEntries(Object.entries(agentTabs.bySession).map(([id, tabs]) => [id, tabs.length]));
  const pageOwner = page ? Object.keys(agentTabs.bySession).find((id) => agentTabs.bySession[id]!.some((tab) => tab.id === page.tabId)) : undefined;
  const inUseSince = runHere ? turns.at(-1)?.startedAt ?? null : null;
  const [trayOpen, setTrayOpen] = useState(false);
  const rememberButton = page && (
    <button
      type="button"
      class="context-chip__action"
      aria-label="Remember something about this site"
      title="Remember something about this site"
      aria-expanded={siteNote !== null}
      onClick={() => siteNote ? closeSiteNote() : rememberSite(page.url)}
    >
      <NotePlus />
    </button>
  );
  useEffect(() => {
    if (watchedTab) setTrayOpen(true);
  }, [watchedTab?.id]);
  const helpTabId = pendingHelp && chatAgentTabs.some((tab) => tab.id === pendingHelp.tabId) ? pendingHelp.tabId : null;

  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <button
          type="button"
          class="icon-button"
          ref={historyButton}
          onClick={() => {
            if (historyOpen) return closeHistory();
            listSessions();
            setHistoryOpen(true);
          }}
          aria-label="Chat history"
          aria-expanded={historyOpen}
          aria-controls="history-drawer"
          title="Chat history"
        >
          <History />
        </button>
        <h1 class={conversation.title ? "sidebar__title" : "sidebar__title sidebar__title--new"} title={conversation.title || undefined}>
          {conversation.title || "New chat"}
        </h1>
        <button
          type="button"
          class="icon-button"
          onClick={() => {
            setHistoryOpen(false);
            newChat();
          }}
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
      </header>
      <div class="sidebar__content">
        <div class="sidebar__chat" inert={historyOpen}>
          <OtherRunsStrip runs={otherRuns} onOpen={openSession} />
          <main class="sidebar__body" ref={scroll.viewport}>
            <div ref={scroll.content}>
              {turns.length === 0 && !runHere ? (
                <div class="sidebar__empty">
                  <Mascot mood="idle" size={64} blink />
                  <h2>Hi, I'm bside</h2>
                  <p>
                    {page ? "I can read this tab and open my own in the background to get things done." : "I can open tabs of my own in the background to get things done."}
                    {" Your chats stay in this browser."}
                  </p>
                  <div class="quick-actions" aria-label="Try a task">
                    {QUICK_ACTIONS.map((action) => <button type="button" key={action.name} disabled={composerDisabled || !page || (pageOwner !== undefined && pageOwner !== conversation.id)}
                      onClick={() => setDraft({ id: crypto.randomUUID(), text: action.prompt })}>{action.label}</button>)}
                  </div>
                  {skills.some((skill) => !skill.builtin) && <div class="skill-chips" aria-label="Saved skills">
                    {skills.filter((skill) => !skill.builtin).slice(0, 3).map((skill) => <button type="button" key={skill.name} title={skill.description} disabled={composerDisabled}
                      onClick={() => setDraft({ id: crypto.randomUUID(), text: `/${skill.name} ` })}>/{skill.name}</button>)}
                  </div>}
                </div>
              ) : (
                <ul class="timeline">
                  {turns.map((turn, index) => {
                    const active = runHere && index === turns.length - 1;
                    const usage = turn.usage && !active ? describeTurnUsage(turn.usage) : null;
                    return (
                      <Fragment key={turn.id}>
                        {turn.summary !== null && (
                          <li class="timeline__item timeline__item--summary">
                            <details class="summary-marker">
                              <summary class="summary-marker__line">Earlier conversation summarized</summary>
                              <p class="summary-marker__note">
                                bside now sees this summary instead of the turns above. They stay here and in exports.
                              </p>
                              <Markdown text={turn.summary} images={images} />
                            </details>
                          </li>
                        )}
                        {turn.prompt && (
                          <li class="timeline__item timeline__item--user">
                            {turn.prompt.scheduled && <p class="timeline__meta">Scheduled · {turn.prompt.scheduled.name} · {new Date(turn.prompt.scheduled.scheduledAt).toLocaleString()}</p>}
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
                            {turn.prompt.ask && <AskChip ask={turn.prompt.ask} />}
                            {turn.prompt.content?.map(item => <McpContentChip key={item.id} item={item} />)}
                          </li>
                        )}
                        {(turn.steps.length > 0 || active) && (
                          <li class="timeline__item timeline__item--work">
                            <TurnTrace
                              turn={turn}
                              active={active}
                              pendingApproval={pendingApproval}
                              onApprove={approveAction}
                              onDeny={denyAction}
                              pendingHelp={pendingHelp}
                              agentTabs={chatAgentTabs}
                              onShowTab={watchTab}
                              onResolveHelp={resolveHelp}
                              images={images}
                            />
                          </li>
                        )}
                        {turn.memory.length > 0 && (
                          <li class="timeline__item timeline__item--memory">
                            <MemoryNotice
                              changes={turn.memory}
                              undo={memoryUndo[memoryUndoKey(turn.memory.map((change) => change.id))]}
                              onUndo={() => undoMemory(turn.memory.map((change) => change.id))}
                            />
                          </li>
                        )}
                        {turn.answer && (
                          <li class="timeline__item timeline__item--assistant">
                            <Markdown text={turn.answer.text} images={images} />
                          </li>
                        )}
                        {usage && (
                          <li class="timeline__item timeline__item--usage">
                            <p class="turn-usage" title={usage.title}>{usage.text}</p>
                          </li>
                        )}
                      </Fragment>
                    );
                  })}
                  {hereRun?.partialAssistantText && (
                    <li class="timeline__item timeline__item--assistant timeline__item--streaming">
                      <Markdown text={hereRun.partialAssistantText} images={images} />
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
            {queue.length > 0 && (
              <ul class="queue" aria-label="Waiting messages">
                {queue.map((message) => {
                  const text = message.text.replace(PROMPT_MENTION_PATTERN, "@$1");
                  return (
                    <li key={message.id} class="queue__item">
                      <span
                        class="queue__label"
                        title={message.mode === "steer"
                          ? "Reaches bside at its next step"
                          : runHere ? "Sent when this task completes" : "Waiting: send it or remove it"}
                      >
                        {message.mode === "steer" ? "Steer" : "Queued"}
                      </span>
                      <span class="queue__text" title={text}>{text}</span>
                      {message.content?.map(item => <McpContentChip key={item.id} item={item} />)}
                      {message.ask && <span class="queue__label" title={describeAsk(message.ask).text}>{describeAsk(message.ask).label}</span>}
                      {message.mode === "follow-up" && !runHere && (
                        <button type="button" class="icon-button" aria-label="Send now" title="Send now" onClick={() => sendQueued(message.id)}>
                          <ArrowUp />
                        </button>
                      )}
                      {message.mode === "follow-up" && (
                        <button type="button" class="icon-button" aria-label="Remove from queue" title="Remove from queue" onClick={() => removeQueued(message.id)}>
                          <X />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {chatAgentTabs.length > 0 && (
              <AgentTabsToggle
                tabs={chatAgentTabs}
                watching={watchedTab}
                busy={inUseSince !== null && chatAgentTabs.some((tab) => tab.lastUsedAt >= inUseSince)}
                needsYou={helpTabId !== null}
                open={trayOpen}
                onToggle={() => setTrayOpen(!trayOpen)}
              />
            )}
            <div class={watchedTab ? "composer composer--watching" : "composer"}>
              {trayOpen && chatAgentTabs.length > 0 && (
                <AgentTabsPanel
                  tabs={chatAgentTabs}
                  watching={watchedTab}
                  inUseSince={inUseSince}
                  canClose={!runHere}
                  helpTabId={helpTabId}
                  takenOver={agentTabs.takenOver}
                  now={Date.now()}
                  onWatch={watchTab}
                  onUnwatch={unwatchTab}
                  onTakeOver={takeOverTab}
                  onCloseAll={() => closeAgentTabs(conversation.id)}
                />
              )}
              {siteNote && <SiteNoteEditor state={siteNote} onSave={saveSiteNote} onClose={closeSiteNote} />}
              {ask && <AskChip ask={ask} onRemove={() => dismissAsk(ask.id)} />}
              {page && pageOwner === conversation.id ? (
                <div class="context-chip context-chip--agent" title={describeAttachment(page)}>
                  <Eye />
                  <strong>{page.title || "bside's tab"}</strong>
                  <small>bside's tab</small>
                  {rememberButton}
                </div>
              ) : page && pageOwner === undefined && (
                <div class="context-chip" title={describeAttachment(page)}>
                  <Globe />
                  <strong>{page.title || "Current tab"}</strong>
                  <small>{new URL(page.url).hostname}</small>
                  {rememberButton}
                </div>
              )}
              <Composer
                sessionId={conversation.id}
                attachments={mcpAttachments.filter(item => item.sessionId === conversation.id)}
                onListMcpContent={listMcpContent}
                onPrepareMcpContent={prepareMcpContent}
                onDismissMcpContent={dismissMcpContent}
                disabled={composerDisabled}
                running={runHere}
                working={runHere}
                canSteer={hereRun !== null && hereRun.status !== "cancelling"}
                configured={credential.configured}
                draft={draft}
                focusVersion={focusVersion}
                askId={ask?.id}
                placeholder={ask ? describeAsk(ask).placeholder : undefined}
                tabs={tabs}
                skills={skills ?? []}
                onListSkills={listSkills}
                onListTabs={listTabs}
                onSend={(text) => {
                  scroll.scrollToBottom();
                  sendPrompt(text, ask?.id, mcpAttachments.filter(item => item.sessionId === conversation.id).map(item => item.id));
                }}
                onSteer={(text) => steer(text, ask?.id, mcpAttachments.filter(item => item.sessionId === conversation.id).map(item => item.id))}
                onStop={cancelRun}
              />
            </div>
            <div class="composer__settings">
              <PermissionModeSelect mode={permissionMode} onChange={savePermissionMode} />
              <select
                aria-label="Model"
                title={runHere ? "Model: applies from your next message; the running turn keeps its own" : "Model"}
                value={settings.modelId}
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
                title={runHere ? "Reasoning effort: applies from your next message; the running turn keeps its own" : "Reasoning effort"}
                value={settings.reasoningEffort}
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
        {historyOpen && (
          <HistoryDrawer
            sessions={sessions}
            openId={conversation.id}
            runs={runs.map((run) => ({ conversationId: run.conversationId, waitingFor: runAttention(run) }))}
            agentTabs={agentTabCounts}
            now={Date.now()}
            onOpen={(sessionId) => {
              closeHistory();
              if (sessionId !== conversation.id) openSession(sessionId);
            }}
            onRename={renameSession}
            onPin={pinSession}
            onExport={downloadContext}
            onDelete={deleteSession}
            onClose={closeHistory}
          />
        )}
      </div>
    </div>
  );
}
