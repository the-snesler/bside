import { useEffect, useState } from "preact/hooks";
import ArrowsMove from "~icons/tabler/arrows-move";
import ArrowsVertical from "~icons/tabler/arrows-vertical";
import BrandYoutube from "~icons/tabler/brand-youtube";
import Camera from "~icons/tabler/camera";
import Checkbox from "~icons/tabler/checkbox";
import Clock from "~icons/tabler/clock";
import ExternalLink from "~icons/tabler/external-link";
import FilePencil from "~icons/tabler/file-pencil";
import FileText from "~icons/tabler/file-text";
import Forms from "~icons/tabler/forms";
import HandClick from "~icons/tabler/hand-click";
import Keyboard from "~icons/tabler/keyboard";
import List from "~icons/tabler/list";
import LockAccess from "~icons/tabler/lock-access";
import Login from "~icons/tabler/login";
import Paperclip from "~icons/tabler/paperclip";
import Photo from "~icons/tabler/photo";
import Pointer from "~icons/tabler/pointer";
import Search from "~icons/tabler/search";
import Selector from "~icons/tabler/selector";
import Shield from "~icons/tabler/shield-check";
import ShieldQuestion from "~icons/tabler/shield-question";
import Terminal from "~icons/tabler/terminal-2";
import Trash from "~icons/tabler/trash";
import WorldSearch from "~icons/tabler/world-search";
import { PROMPT_MENTION_PATTERN } from "@/lib/domain/conversation";
import type { HelpKind } from "@/lib/domain/tools";
import { MAX_HELP_NOTE_CHARS } from "@/lib/domain/tools";
import type { AgentTabSummary, ApprovalRequest, HelpOutcome, HelpRequest } from "@/lib/protocol";
import { Markdown } from "@/lib/ui/Markdown";
import { Mascot, type MascotMood } from "@/lib/ui/Mascot";
import { Trace, TraceLine, type TraceStatus } from "@/lib/ui/Trace";
import { formatDuration, type Activity, type Turn, type TurnStep } from "@/lib/ui/turns";

type Icon = typeof Pointer;

/** First matching effect wins: [source pattern, icon, running, done, failed]. */
const PROGRAM_ACTIONS: [RegExp, Icon, string, string, string][] = [
  [/\.setInputFiles\(/, Paperclip, "Attaching a file", "Attached a file", "Couldn't attach a file"],
  [/\.click\(|\.press\(/, Pointer, "Clicking a page control", "Clicked a page control", "Couldn't click a page control"],
  [/\.fill\(/, Forms, "Filling page fields", "Filled page fields", "Couldn't fill page fields"],
  [/\.selectOption\(/, Selector, "Selecting an option", "Selected an option", "Couldn't select an option"],
  [/\.setChecked\(|\.check\(|\.uncheck\(/, Checkbox, "Updating a checkbox", "Updated a checkbox", "Couldn't update a checkbox"],
  [/web\.search\(/, WorldSearch, "Searching the web", "Searched the web", "Web search failed"],
  [/youtube\s*\.\s*\w+\s*\(/, BrandYoutube, "Reading YouTube", "Read YouTube", "Couldn't read YouTube"],
  [/\.navigate\(|\.goBack\(|browser\.open\(/, ExternalLink, "Opening a page", "Opened a page", "Couldn't open a page"],
  [/\.screenshot\s*\(/, Camera, "Taking a screenshot", "Took a screenshot", "Couldn't take a screenshot"],
  [/fs\s*\.\s*view\s*\(/, Photo, "Looking at an image", "Looked at an image", "Couldn't show an image"],
  [/fs\.remove\(/, Trash, "Removing a file or tab", "Removed a file or tab", "Couldn't remove a file or tab"],
  [/fs\.move\(/, ArrowsMove, "Moving a file or tab", "Moved a file or tab", "Couldn't move a file or tab"],
  [/fs\.write\(/, FilePencil, "Writing a scratch file", "Wrote a scratch file", "Couldn't write a scratch file"],
  [/\.scroll\(/, ArrowsVertical, "Scrolling the page", "Scrolled the page", "Couldn't scroll the page"],
  [/\.find\(|\.waitFor\(/, Search, "Searching page content", "Searched page content", "Page search failed"],
  [/fs\s*\.\s*read\s*\(/, FileText, "Reading file content", "Read file content", "Couldn't read file content"],
  [/\.snapshot\(/, FileText, "Reading page content", "Read page content", "Couldn't read page content"],
  [/fs\.list\(/, List, "Listing tabs and files", "Listed tabs and files", "Couldn't list tabs and files"],
];

function stringArg(activity: Activity, key: string): string {
  const args = activity.call.arguments;
  const value = args && typeof args === "object" && !Array.isArray(args) ? args[key] : undefined;
  return typeof value === "string" ? value : "";
}

/** What each kind of help request asks of the user, and its icon. */
export const HELP_KIND_LABELS: Record<HelpKind, { Icon: Icon; label: string }> = {
  login: { Icon: Login, label: "sign in" },
  verification: { Icon: ShieldQuestion, label: "verification" },
  information: { Icon: Keyboard, label: "enter information" },
  permission: { Icon: LockAccess, label: "permission prompt" },
  other: { Icon: HandClick, label: "a step only you can do" },
};

function helpKind(activity: Activity): { Icon: Icon; label: string } {
  return HELP_KIND_LABELS[stringArg(activity, "kind") as HelpKind] ?? HELP_KIND_LABELS.other;
}

/**
 * A denied confirmation or help the user could not give is the user's
 * decision, and a skipped call never ran: none is a failed step. A help
 * request fails only when it was refused (not one of the chat's agent tabs).
 */
function failed(activity: Activity): boolean {
  if (!activity.result || activity.result.ok || activity.result.code === "SKIPPED") return false;
  if (activity.call.name === "request_user_help") return activity.result.code === "INVALID_TOOL_ARGUMENTS";
  return !(activity.call.name === "request_action_confirmation" && activity.result.code === "ACTION_DENIED");
}

/** Icon, status, and a title that states that status in words. */
export function describeActivity(activity: Activity, pending: boolean): { Icon: Icon; title: string; status?: TraceStatus } {
  if (activity.call.name === "request_action_confirmation") {
    const title = stringArg(activity, "title") || "an action";
    if (pending) return { Icon: Shield, title: `Waiting for approval: ${title}`, status: "pending" };
    if (!activity.result) return { Icon: Shield, title: `Asking to confirm: ${title}`, status: "running" };
    if (activity.result.code === "SKIPPED") return { Icon: Shield, title: `Skipped asking to confirm: ${title}` };
    return { Icon: Shield, title: `${activity.result.ok ? "Approved" : "Denied"}: ${title}` };
  }
  if (activity.call.name === "request_user_help") {
    const { Icon, label } = helpKind(activity);
    if (pending) return { Icon, title: `Needs your help: ${label}`, status: "pending" };
    if (!activity.result) return { Icon, title: `Asked for your help: ${label}`, status: "running" };
    if (activity.result.code === "SKIPPED") return { Icon, title: `Skipped asking for your help: ${label}` };
    if (failed(activity)) return { Icon, title: `Couldn't ask for your help: ${label}`, status: "error" };
    if (activity.result.ok) return { Icon, title: `You helped: ${label}` };
    return { Icon, title: activity.result.code === "ACTION_DENIED" ? `You couldn't help: ${label}` : `Stopped waiting for your help: ${label}` };
  }
  const source = stringArg(activity, "source");
  const [, Icon, running, done, error] =
    activity.call.name === "current_time" ? [null, Clock, "Checking the time", "Checked the time", "Couldn't check the time"] :
    PROGRAM_ACTIONS.find(([pattern]) => pattern.test(source)) ??
    [null, Terminal, "Running a browser program", "Ran a browser program", "Browser program failed"];
  if (!activity.result) return { Icon, title: running, status: "running" };
  if (activity.result.code === "SKIPPED") return { Icon, title: `Skipped ${running.charAt(0).toLowerCase()}${running.slice(1)}` };
  return failed(activity) ? { Icon, title: error, status: "error" } : { Icon, title: done };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The pending help request's answers: show the tab (watching it without the
 * page shield, since bside asked for the user's hands), say it is done, or
 * say they can't, optionally with a short note.
 */
function HelpActions(props: { tab: AgentTabSummary | null; onShowTab: () => void; onResolve: (outcome: HelpOutcome, note: string) => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  if (declining) {
    const send = () => props.onResolve("unable", note.trim());
    return (
      <form class="help__decline" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <input
          type="text"
          class="help__note"
          aria-label="Why not? (optional)"
          placeholder="Why not? (optional)"
          maxLength={MAX_HELP_NOTE_CHARS}
          value={note}
          onInput={(event) => setNote(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setDeclining(false); }}
          autoFocus
        />
        <div class="trace__actions">
          <button type="submit" class="trace__approve">Send</button>
          <button type="button" onClick={() => setDeclining(false)}>Back</button>
        </div>
      </form>
    );
  }
  return (
    <div class="trace__actions">
      <button type="button" disabled={!props.tab} title={props.tab ? "Show bside's tab so you can do this there" : "This tab is closed"} onClick={props.onShowTab}>
        Show tab
      </button>
      <button type="button" class="trace__approve" onClick={() => props.onResolve("done", "")}>Done</button>
      <button type="button" onClick={() => setDeclining(true)}>Can't help</button>
    </div>
  );
}

function ActivityLine(props: {
  activity: Activity;
  pending: boolean;
  onApprove: () => void;
  onDeny: () => void;
  helpTab?: AgentTabSummary | null;
  onShowTab?: () => void;
  onResolveHelp?: (outcome: HelpOutcome, note: string) => void;
}) {
  const { activity, pending } = props;
  const { Icon, title, status } = describeActivity(activity, pending);
  const elapsed = activity.endedAt === null ? 0 : activity.endedAt - activity.startedAt;
  const isConfirmation = activity.call.name === "request_action_confirmation";
  const isHelp = activity.call.name === "request_user_help";
  const artifact = stringArg(activity, "artifact");
  const helpTab = props.helpTab ?? null;
  return (
    <TraceLine
      icon={<Icon />}
      title={title}
      description={elapsed >= 1000 ? formatDuration(elapsed) : undefined}
      status={status}
      open={pending}
    >
      {isConfirmation ? (
        <>
          <p>{stringArg(activity, "message")}</p>
          {artifact && <pre class="tool-call">{artifact}</pre>}
        </>
      ) : isHelp ? (
        <>
          <p class="help__reason">{stringArg(activity, "reason")}</p>
          {pending && (
            <p class="help__tab">
              {helpTab ? `In bside's tab: ${helpTab.title || hostname(helpTab.url)} · ${hostname(helpTab.url)}` : "bside's tab for this is closed."}
            </p>
          )}
        </>
      ) : activity.call.name === "browser_program" ? (
        <pre class="tool-call">
          {stringArg(activity, "source") || JSON.stringify(activity.call.arguments)}
        </pre>
      ) : null}
      {activity.result && <p class="trace__result">{activity.result.summary}</p>}
      {pending && isHelp && props.onShowTab && props.onResolveHelp && (
        <HelpActions tab={helpTab} onShowTab={props.onShowTab} onResolve={props.onResolveHelp} />
      )}
      {pending && !isHelp && (
        <div class="trace__actions">
          <button type="button" class="trace__approve" onClick={props.onApprove}>
            Approve
          </button>
          <button type="button" onClick={props.onDeny}>
            Deny
          </button>
        </div>
      )}
    </TraceLine>
  );
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** How a finished turn's header names its outcome. */
const ENDED: Record<NonNullable<Turn["outcome"]>, string> = {
  completed: "Worked for",
  failed: "Failed after",
  cancelled: "Stopped after",
  interrupted: "Interrupted after",
};

/**
 * The work for one turn behind a single "Worked for …" disclosure, led by
 * bside's face: tool rows grouped into Trace lists, with interim assistant
 * text and the user's steers between them. It stays open while the turn is
 * active and collapses when the turn completes. Steps that failed along the
 * way are counted quietly; the face and title change only when the run itself
 * failed or stopped.
 */
export function TurnTrace(props: {
  turn: Turn;
  active: boolean;
  pendingApproval: ApprovalRequest | null;
  onApprove: (callId: string) => void;
  onDeny: (callId: string) => void;
  /** The run's open help request, answered from its card. */
  pendingHelp?: HelpRequest | null;
  /** The chat's agent tabs, to name the tab a help request is about. */
  agentTabs?: readonly AgentTabSummary[];
  onShowTab?: (tabId: number) => void;
  onResolveHelp?: (callId: string, outcome: HelpOutcome, note: string) => void;
}) {
  const { turn, active, pendingApproval } = props;
  const pendingHelp = props.pendingHelp ?? null;
  const now = useNow(active);
  if (!active && turn.steps.length === 0) return null;

  const activities = turn.steps.filter((step) => step.kind === "activity");
  const failures = activities.filter(failed).length;
  const elapsed = formatDuration((active ? now : turn.endedAt) - turn.startedAt);
  const ended = turn.outcome ?? "completed";
  const header: { title: string; status?: TraceStatus; mood: MascotMood } = active
    ? pendingApproval
      ? { title: "Waiting for your approval", status: "pending", mood: "needs" }
      : pendingHelp
        ? { title: "Waiting for your help", status: "pending", mood: "needs" }
        : { title: `Working for ${elapsed}`, status: "running", mood: "working" }
    : { title: `${ENDED[ended]} ${elapsed}`, mood: ended === "completed" ? "idle" : "failed" };
  const description = activities.length ? (
    <>
      {`${activities.length} ${activities.length === 1 ? "step" : "steps"}`}
      {failures > 0 && <span class="trace__failed">{` · ${failures} failed`}</span>}
    </>
  ) : undefined;

  const groups: (Activity[] | Exclude<TurnStep, Activity>)[] = [];
  for (const step of turn.steps) {
    const last = groups.at(-1);
    if (step.kind !== "activity") groups.push(step);
    else if (Array.isArray(last)) last.push(step);
    else groups.push([step]);
  }

  return (
    <Trace label="Turn activity" class="trace--turn">
      <TraceLine
        icon={<Mascot mood={header.mood} size={18} />}
        title={header.title}
        description={description}
        status={header.status}
        open={active}
      >
        {groups.length > 0 &&
          groups.map((group) =>
            Array.isArray(group) ? (
              <Trace key={group[0]!.id}>
                {group.map((activity) => (
                  <ActivityLine
                    key={activity.id}
                    activity={activity}
                    pending={pendingApproval?.call.id === activity.call.id || pendingHelp?.call.id === activity.call.id}
                    onApprove={() => props.onApprove(activity.call.id)}
                    onDeny={() => props.onDeny(activity.call.id)}
                    helpTab={pendingHelp?.call.id === activity.call.id ? props.agentTabs?.find((tab) => tab.id === pendingHelp.tabId) ?? null : null}
                    onShowTab={pendingHelp && props.onShowTab ? () => props.onShowTab!(pendingHelp.tabId) : undefined}
                    onResolveHelp={props.onResolveHelp ? (outcome, note) => props.onResolveHelp!(activity.call.id, outcome, note) : undefined}
                  />
                ))}
              </Trace>
            ) : group.kind === "steer" ? (
              <p key={group.id} class="trace__steer">
                <span class="trace__steer-label">You</span>
                {group.text.replace(PROMPT_MENTION_PATTERN, "@$1")}
              </p>
            ) : (
              <div key={group.id} class="trace__message">
                <Markdown text={group.text} />
              </div>
            ),
          )}
      </TraceLine>
    </Trace>
  );
}
