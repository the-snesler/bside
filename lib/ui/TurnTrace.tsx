import { useEffect, useState } from "preact/hooks";
import ArrowsMove from "~icons/tabler/arrows-move";
import ArrowsVertical from "~icons/tabler/arrows-vertical";
import Checkbox from "~icons/tabler/checkbox";
import Clock from "~icons/tabler/clock";
import ExternalLink from "~icons/tabler/external-link";
import FilePencil from "~icons/tabler/file-pencil";
import FileText from "~icons/tabler/file-text";
import Forms from "~icons/tabler/forms";
import List from "~icons/tabler/list";
import Paperclip from "~icons/tabler/paperclip";
import Pointer from "~icons/tabler/pointer";
import Search from "~icons/tabler/search";
import Selector from "~icons/tabler/selector";
import Shield from "~icons/tabler/shield-check";
import Terminal from "~icons/tabler/terminal-2";
import Trash from "~icons/tabler/trash";
import WorldSearch from "~icons/tabler/world-search";
import type { ApprovalRequest } from "@/lib/protocol";
import { Markdown } from "@/lib/ui/Markdown";
import { Trace, TraceLine, type TraceStatus } from "@/lib/ui/Trace";
import { formatDuration, type Activity, type Turn } from "@/lib/ui/turns";

type Icon = typeof Pointer;

/** First matching effect wins: [source pattern, icon, running, done, failed]. */
const PROGRAM_ACTIONS: [RegExp, Icon, string, string, string][] = [
  [/\.setInputFiles\(/, Paperclip, "Attaching a file", "Attached a file", "Couldn't attach a file"],
  [/\.click\(|\.press\(/, Pointer, "Clicking a page control", "Clicked a page control", "Couldn't click a page control"],
  [/\.fill\(/, Forms, "Filling page fields", "Filled page fields", "Couldn't fill page fields"],
  [/\.selectOption\(/, Selector, "Selecting an option", "Selected an option", "Couldn't select an option"],
  [/\.setChecked\(|\.check\(|\.uncheck\(/, Checkbox, "Updating a checkbox", "Updated a checkbox", "Couldn't update a checkbox"],
  [/web\.search\(/, WorldSearch, "Searching the web", "Searched the web", "Web search failed"],
  [/\.navigate\(|\.goBack\(|browser\.open\(/, ExternalLink, "Opening a page", "Opened a page", "Couldn't open a page"],
  [/fs\.remove\(/, Trash, "Removing a file or tab", "Removed a file or tab", "Couldn't remove a file or tab"],
  [/fs\.move\(/, ArrowsMove, "Moving a file or tab", "Moved a file or tab", "Couldn't move a file or tab"],
  [/fs\.write\(/, FilePencil, "Writing a scratch file", "Wrote a scratch file", "Couldn't write a scratch file"],
  [/\.scroll\(/, ArrowsVertical, "Scrolling the page", "Scrolled the page", "Couldn't scroll the page"],
  [/\.find\(|\.waitFor\(/, Search, "Searching page content", "Searched page content", "Page search failed"],
  [/fs\.read\(|\.snapshot\(/, FileText, "Reading page content", "Read page content", "Couldn't read page content"],
  [/fs\.list\(/, List, "Listing tabs and files", "Listed tabs and files", "Couldn't list tabs and files"],
];

function stringArg(activity: Activity, key: string): string {
  const args = activity.call.arguments;
  const value = args && typeof args === "object" && !Array.isArray(args) ? args[key] : undefined;
  return typeof value === "string" ? value : "";
}

/** A denied confirmation is the user's decision, not a failed step. */
function failed(activity: Activity): boolean {
  if (!activity.result || activity.result.ok) return false;
  return !(activity.call.name === "request_action_confirmation" && activity.result.code === "ACTION_DENIED");
}

/** Icon, status, and a title that states that status in words. */
export function describeActivity(activity: Activity, pending: boolean): { Icon: Icon; title: string; status?: TraceStatus } {
  if (activity.call.name === "request_action_confirmation") {
    const title = stringArg(activity, "title") || "an action";
    if (pending) return { Icon: Shield, title: `Waiting for approval: ${title}`, status: "pending" };
    if (!activity.result) return { Icon: Shield, title: `Asking to confirm: ${title}`, status: "running" };
    return { Icon: Shield, title: `${activity.result.ok ? "Approved" : "Denied"}: ${title}` };
  }
  const source = stringArg(activity, "source");
  const [, Icon, running, done, error] =
    PROGRAM_ACTIONS.find(([pattern]) => pattern.test(source)) ??
    [null, Terminal, "Running a browser program", "Ran a browser program", "Browser program failed"];
  if (!activity.result) return { Icon, title: running, status: "running" };
  return failed(activity) ? { Icon, title: error, status: "error" } : { Icon, title: done };
}

function ActivityLine(props: {
  activity: Activity;
  pending: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { activity, pending } = props;
  const { Icon, title, status } = describeActivity(activity, pending);
  const elapsed = activity.endedAt === null ? 0 : activity.endedAt - activity.startedAt;
  const isConfirmation = activity.call.name === "request_action_confirmation";
  const artifact = stringArg(activity, "artifact");
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
      ) : (
        <pre class="tool-call">
          {stringArg(activity, "source") || JSON.stringify(activity.call.arguments)}
        </pre>
      )}
      {activity.result && <p class="trace__result">{activity.result.summary}</p>}
      {pending && (
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

/**
 * The work for one turn behind a single "Worked for …" disclosure: tool rows
 * grouped into Trace lists, with interim assistant text between them. It stays
 * open while the turn is active and collapses when the turn completes.
 */
export function TurnTrace(props: {
  turn: Turn;
  active: boolean;
  pendingApproval: ApprovalRequest | null;
  onApprove: (callId: string) => void;
  onDeny: (callId: string) => void;
}) {
  const { turn, active, pendingApproval } = props;
  const now = useNow(active);
  if (!active && turn.steps.length === 0) return null;

  const activities = turn.steps.filter((step) => step.kind === "activity");
  const failures = activities.filter(failed).length;
  const elapsed = formatDuration((active ? now : turn.endedAt) - turn.startedAt);
  const header: { title: string; status?: TraceStatus } = active
    ? pendingApproval
      ? { title: "Waiting for your approval", status: "pending" }
      : { title: `Working for ${elapsed}`, status: "running" }
    : failures
      ? { title: `Worked for ${elapsed}, ${failures} failed`, status: "error" }
      : { title: `Worked for ${elapsed}` };
  const description = activities.length
    ? `${activities.length} ${activities.length === 1 ? "step" : "steps"}`
    : undefined;

  const groups: (Activity[] | { id: string; text: string })[] = [];
  for (const step of turn.steps) {
    const last = groups.at(-1);
    if (step.kind === "text") groups.push(step);
    else if (Array.isArray(last)) last.push(step);
    else groups.push([step]);
  }

  return (
    <Trace label="Turn activity">
      <TraceLine
        icon={<Clock />}
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
                    pending={pendingApproval?.call.id === activity.call.id}
                    onApprove={() => props.onApprove(activity.call.id)}
                    onDeny={() => props.onDeny(activity.call.id)}
                  />
                ))}
              </Trace>
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
