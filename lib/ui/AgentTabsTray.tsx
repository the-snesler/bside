import ArrowBackUp from "~icons/tabler/arrow-back-up";
import Browser from "~icons/tabler/browser";
import ChevronDown from "~icons/tabler/chevron-down";
import ChevronUp from "~icons/tabler/chevron-up";
import Eye from "~icons/tabler/eye";
import type { AgentTabSummary } from "@/lib/protocol";
import { formatRelativeTime } from "@/lib/ui/HistoryDrawer";

export const AGENT_TABS_PANEL_ID = "agent-tabs-panel";

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The tab's own icon when Firefox holds it as a data URL, else its site's first letter. */
function TabIcon(props: { tab: AgentTabSummary }) {
  const { tab } = props;
  if (tab.favIconUrl) return <img class="agent-tab__icon" src={tab.favIconUrl} alt="" width={16} height={16} />;
  return <span class="agent-tab__icon agent-tab__icon--letter" aria-hidden="true">{(hostname(tab.url)[0] ?? "?").toUpperCase()}</span>;
}

/**
 * The tab on the composer's top edge that opens the list of the open chat's
 * agent tabs. While the user watches one, it names that tab's site instead.
 * `busy`: the chat's run has used one of them since its turn started.
 */
export function AgentTabsToggle(props: { tabs: readonly AgentTabSummary[]; watching: AgentTabSummary | null; busy: boolean; open: boolean; onToggle(): void }) {
  const { tabs, watching } = props;
  const count = `${tabs.length} background ${tabs.length === 1 ? "tab" : "tabs"}`;
  const Chevron = props.open ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      class={watching ? "agent-tabs-toggle agent-tabs-toggle--watching" : "agent-tabs-toggle"}
      aria-expanded={props.open}
      aria-controls={AGENT_TABS_PANEL_ID}
      title="bside's hidden tabs for this chat"
      onClick={props.onToggle}
    >
      {watching ? <Eye aria-hidden="true" /> : <Browser aria-hidden="true" />}
      <span>{watching ? `Watching ${hostname(watching.url)}` : count}</span>
      {props.busy && (
        <>
          <span class="live-dot" aria-hidden="true" />
          <span class="visually-hidden">, in use</span>
        </>
      )}
      <Chevron class="agent-tabs-toggle__chevron" aria-hidden="true" />
    </button>
  );
}

/**
 * The open chat's agent tabs, inside the composer above the attached page.
 * Each can be watched: Firefox shows it in the tab strip and switches to it,
 * while bside keeps it and its run keeps working there. Switching to any
 * other tab, or Back, hides it again. `inUseSince`: when the chat's running
 * turn started, so tabs it has used since read as in use; `null` when idle.
 */
export function AgentTabsPanel(props: {
  tabs: readonly AgentTabSummary[];
  watching: AgentTabSummary | null;
  inUseSince: number | null;
  /** Closing is refused while any run is active. */
  canClose: boolean;
  now: number;
  onWatch(tabId: number): void;
  onUnwatch(): void;
  onCloseAll(): void;
}) {
  const { watching, inUseSince } = props;
  const inUse = (tab: AgentTabSummary) => inUseSince !== null && tab.lastUsedAt >= inUseSince;
  return (
    <section class="agent-tabs" id={AGENT_TABS_PANEL_ID} aria-label="bside's background tabs">
      <ul class="agent-tabs__list">
        {props.tabs.map((tab) => {
          const watched = tab.id === watching?.id;
          const host = hostname(tab.url);
          const title = tab.title || host;
          const status = watched
            ? inUse(tab) ? "bside is working here" : "You're watching"
            : `${host} · ${inUse(tab) ? "in use now" : `used ${formatRelativeTime(tab.lastUsedAt, props.now).toLowerCase()}`}`;
          return (
            <li key={tab.id} class={watched ? "agent-tab agent-tab--watched" : "agent-tab"}>
              <TabIcon tab={tab} />
              <span class="agent-tab__meta">
                <strong title={tab.url}>{title}</strong>
                <small>
                  {inUse(tab) && <span class="live-dot" aria-hidden="true" />}
                  {status}
                </small>
              </span>
              {watched ? (
                <button type="button" class="agent-tab__action agent-tab__action--primary" onClick={props.onUnwatch} title="Hide this tab again and go back to yours">
                  <ArrowBackUp aria-hidden="true" />
                  Back
                </button>
              ) : (
                <button type="button" class="agent-tab__action" onClick={() => props.onWatch(tab.id)} aria-label={`Watch ${title}`} title="Show this tab until you switch away">
                  <Eye aria-hidden="true" />
                  Watch
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {watching ? (
        <p class="agent-tabs__note">Switch to any other tab to hide it again.</p>
      ) : (
        <p class="agent-tabs__note">
          <span>Unused tabs close after 30 min</span>
          <button
            type="button"
            class="agent-tabs__close"
            disabled={!props.canClose}
            title={props.canClose ? "Close this chat's background tabs" : "Wait for bside to finish before closing its tabs"}
            onClick={props.onCloseAll}
          >
            Close all
          </button>
        </p>
      )}
    </section>
  );
}
