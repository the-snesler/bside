# Scheduled tasks and notifications

Phase 6.1–6.2 runs user-authored prompts on this Firefox profile's clock. The
persistent background owns scheduling, persistence, sessions, runs, and hints.
Settings → Automation is the only surface that creates or changes tasks. There
is no agent tool, page message, or sidebar command for changing schedules.

## Deliberate permissions

- `alarms` supplies a single one-shot `bside:scheduled-tasks` wakeup for the
  earliest enabled deadline. The record, rather than the alarm event, decides
  whether work is due. Firefox alarms are not guaranteed to be punctual or to
  survive a browser restart, so startup always rebuilds the wakeup.
- `notifications` supplies optional desktop hints. The preference is **off by
  default** and must be turned on in Automation settings. The permission itself
  does not enable notifications. No remote push service, telemetry, new host
  access, or CSP widening is involved.

Both additions are recorded in `scripts/manifest-snapshot.json`. The API
contracts follow Mozilla's [alarms documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms)
and [notifications documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications).
Opening the sidebar stays synchronous in a click handler, as required by
[`sidebarAction.open`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/open).

## Records and cadence

`local:scheduledTasks` is `ScheduledTasksV1`, containing at most 50 tasks. Each
has an opaque id, a one-line name (80 characters), a validated prompt (16,000
characters), an absolute HTTP(S) target URL (2,048 characters, no embedded
credentials), enabled state, creation/edit times, a results session id or null,
next deadline, last tick status, last run status/times/id, and an unread flag.
Reads revalidate every field, remove malformed/later duplicate records and
session references, discard entries beyond the cap, and strip unknown fields.
All read/modify/write operations share the scheduler's queue. Notifications use
`local:notificationSettings` (`NotificationSettingsV1`); invalid records reset
to off. These records are local, unencrypted, and never synced. Do not put
secrets in prompts or target URLs.

Tasks support a daily `HH:mm` device-local time or a whole-minute interval
between 5 minutes and 7 days. New tasks start disabled. Enabling or changing a
cadence chooses a strictly future deadline; editing other fields keeps the
current deadline. Daily deadlines use the local calendar, including DST: a
nonexistent wall time moves forward by the daylight-saving gap and a repeated
time runs once. Startup recomputes daily deadlines in the current local zone;
subsequent ticks compute their next deadline in the device's then-current zone.
Firefox must be running; this does not run a browser or wake a computer.

An alarm advances the deadline and writes through **before** trying to dispatch.
Repeated/early events cannot duplicate a tick. If a user run, a scheduled run,
a confirmation/help pause, or a session change holds the global slot, that tick
is explicitly `skipped-busy`; it is not queued and never interrupts the run.
When several tasks become due together, each is considered once in deadline
order. A delayed alarm coalesces missed intervals to one attempt per task and
advances from the current time, with no burst catch-up. On background/browser
restart **no missed work executes**: past deadlines become `missed` and move to
the next future tick. An unfinished saved run becomes `interrupted`; normal
checkpoint recovery records its interrupted result. Nothing resumes or
approves a paused run after restart.

## Ordinary agent runs, separate results

The runtime reserves the same single global run slot used by sidebar work.
It creates or reuses one dedicated results session per task, saves that
association and run id before starting work, then invokes the ordinary
AgentLoop. It opens the target in a non-active, hidden, session-tagged agent
tab and captures only that target, never the user's active page. Agent tabs
follow the existing ownership, watching, shield, and idle-close policies.
Automatic dispatch never writes the open-session pointer. History rows and
turns identify scheduled work; each user message snapshots task name, id,
target URL, and tick time. Editing/deleting a task cannot rewrite older turns.

Run-start custom instructions, available skills, explicit `/skill` invocations,
site notes, memory index, MCP tool catalog/trust, model selection, budgets,
tainting of untrusted data, cancellation, and retry use the existing paths.
The scheduling source is rendered on the user turn, never in the system
prefix. Site notes and memory still never enter the cacheable prefix. Schedule
metadata cannot grant capabilities or authorization. User retries retain the
original scheduled source/target; committed-effect retry restrictions remain.

Unattended work can read and navigate. Consequential actions must still call
`request_action_confirmation` and wait for the user. Nothing auto-approves.
Help requests, Ask-memory writes, and MCP confirm-writes use their existing
cards and budget exemptions. There is no new action classifier. An unattended
pause can hold the global slot until the user responds or cancels; subsequent
ticks are visibly skipped. The toolbar `!`, notification click, or task's
View results button takes the user to that run's session.

Disabling/deleting a task affects future ticks and does not cancel an active
run or delete its results. Deleting/pruning a results session (including Delete
all history) disables the task and clears its session, result, next-tick, and
unread references. Re-enabling explicitly starts a fresh results session.
Startup applies the same rule to references to missing sessions. Session
operations and scheduler operations avoid waiting on each other's locks.

## Private, optional hints

When enabled, notifications cover successful ordinary runs taking at least
60 seconds, every scheduled terminal result (success/failure/cancellation),
and pending confirmation/help. Visible text is fixed: `bside` and a generic
request to open it. Prompts, page URLs/content, task/chat names, arguments,
model answers, credentials, and provider errors never enter a notification.
Random opaque notification ids map to sessions in background memory only.

At most 64 runs are tracked, with at most one hint per run. Repeated hints are
deduplicated; resolving/cancelling/ending a pause clears it. Disabling or
disposing clears hints and invalidates in-flight creates. Startup removes only
this service's stale notifications, even when disabled; it cannot safely route
old in-memory mappings. A missing/throwing/rejecting browser API never fails a
run. Clicks open the sidebar immediately, then deliberately select the saved
session; an already-deleted session yields the normal missing-chat notice.

Scheduled results also set a persisted unread flag and a `•` toolbar badge,
including when notifications are off. Opening a results session clears its
unread flag. Confirmation/help `!` always has priority over that result badge;
resolving the pause restores the result badge when needed. Startup clears stale
approval state and restores only the persisted unread result signal.

## Verification

`tests/scheduler.test.ts` covers bounds, protocol exclusions, daily time,
storage repair, duplicate/early alarms, missed ticks/restart, disabled/deleted
references, and absent/failing alarm support. Runtime integration tests cover
busy ticks, simultaneous deadlines, task-session/tab isolation, confirmations,
Ask-memory, run-start personalization, history deletion/retention, badge
priority, and notification opt-in/clicks. `tests/notifications.test.ts` exercises
fixed private payloads, timing, dedupe, failures, restart cleanup, disposal,
and in-flight races. Adapter and options tests cover origin restrictions and
create/edit/enable/delete/results/notification controls.

Native Firefox verification is still required before release: use a temporary
profile to enable a short interval, start a manual run over its deadline,
exercise a scheduled confirmation/help pause, click a generic notification,
restart across a deadline, and inspect narrow options/sidebar surfaces.
