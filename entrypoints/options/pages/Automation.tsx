import { useRef, useState } from "preact/hooks";
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, TASK_NAME_CHARS, taskDraft, type ScheduledTask, type TaskDraft } from "@/lib/domain/automation";
import type { AutomationRequest, AutomationResponse } from "@/lib/protocol";
import { Banner, Card, Feedback, Note, Row, Select, SettingsSection, Switch } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendAutomationRequest, type RequestBody } from "@/lib/ui/settings/requests";
import { useRefreshOnFocus } from "../state";

const emptyTask = (): TaskDraft => ({ name: "", prompt: "", url: "", enabled: false, schedule: { kind: "daily", time: "09:00" } });
const date = (at: number | null) => at === null ? "—" : new Date(at).toLocaleString();
const status = (task: ScheduledTask) => {
  if (task.lastTick?.status === "history-deleted") return "Results were deleted; task disabled. Enable it to start a fresh results chat.";
  const run = task.lastRun;
  const tick = task.lastTick;
  const skipped = tick && tick.status !== "started" ? ` Last tick: ${tick.status === "skipped-busy" ? "skipped while another run was active" : tick.status === "missed" ? "missed while Firefox was closed" : "could not start"} (${date(tick.at)}).` : "";
  return `Next: ${date(task.nextAt)}. Last run: ${run ? `${date(run.startedAt)} · ${run.status.replaceAll("-", " ")}` : "never"}.${skipped}`;
};

export function AutomationPage() {
  const [state, setState] = useState<Extract<AutomationResponse, { ok: true }> | null>(null);
  const [draft, setDraft] = useState<{ id: string | null; task: TaskDraft } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);

  useRefreshOnFocus(async () => {
    if (busyRef.current) return;
    const response = await sendAutomationRequest({ type: "automation.get" });
    if (response.ok) setState(response);
  });

  const perform = async (request: RequestBody<AutomationRequest>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const response = await sendAutomationRequest(request);
      if (!response.ok) { setError(response.error.message); return false; }
      setState(response);
      if (request.type === "automation.save") setNotice("Task saved. Changes apply to future runs.");
      return true;
    } catch { setError(BACKGROUND_FAILURE); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const patch = (change: Partial<TaskDraft>) => { if (draft) setDraft({ ...draft, task: { ...draft.task, ...change } }); };
  const openResults = (taskId: string) => {
    // Keep Firefox's user gesture for opening the native sidebar.
    try { void Promise.resolve(Reflect.get(browser, "sidebarAction").open()).catch(() => {}); } catch { /* Optional browser support. */ }
    void perform({ type: "automation.results", taskId });
  };

  return <>
    {error && <Feedback error>{error}</Feedback>}
    {notice && <Feedback>{notice}</Feedback>}
    {state && !state.available && <Banner tone="warning">Firefox alarms are unavailable. Saved tasks will not run until alarm support is restored.</Banner>}
    <SettingsSection label="Scheduled tasks">
      <Card>
        <Row title="Run a prompt on a schedule" description="Results go to each task’s own chat. Busy ticks are skipped. Missed ticks are not replayed after restarting Firefox."
          control={<button class="settings-button" type="button" disabled={busy || !state} onClick={() => { setDraft({ id: null, task: emptyTask() }); setDeleting(null); }}>New task</button>} />
        {state?.tasks.map((task) => <Row key={task.id} title={<>{task.name}{task.unread ? " · New results" : ""}</>} description={status(task)} live
          controlId={`task-enabled-${task.id}`} control={<>
            <Switch id={`task-enabled-${task.id}`} checked={task.enabled} disabled={busy} onChange={(e) => void perform({ type: "automation.save", taskId: task.id, task: { ...taskDraft(task), enabled: e.currentTarget.checked } })} />
            <button class="settings-button" type="button" disabled={busy} onClick={() => { setDraft({ id: task.id, task: taskDraft(task) }); setDeleting(null); }}>Edit</button>
            {task.sessionId && <button class="settings-button" type="button" disabled={busy} onClick={() => openResults(task.id)}>View results</button>}
            <button class="settings-button settings-button--danger" type="button" disabled={busy} onClick={() => setDeleting(task.id)}>Delete</button>
          </>}>
          {deleting === task.id && <div class="settings-form__actions" role="group" aria-label={`Delete ${task.name}?`}>
            <span>Delete this task? Its chat and any active run are kept.</span>
            <button class="settings-button" type="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
            <button class="settings-button settings-button--danger" type="button" disabled={busy} onClick={() => void perform({ type: "automation.delete", taskId: task.id }).then((ok) => { if (ok) { setDeleting(null); if (draft?.id === task.id) setDraft(null); } })}>Delete task</button>
          </div>}
        </Row>)}
      </Card>
      <Note>Firefox must be running. Daily times use this device’s local time zone. Unattended runs can read and navigate; consequential actions still pause for your confirmation. Disabling or deleting a task stops future ticks; stop an active run in its chat. Prompts are stored in this profile without encryption or sync; do not include secrets.</Note>
    </SettingsSection>
    {draft && <SettingsSection label={draft.id ? "Edit task" : "New task"}><Card>
      <form class="settings-form" onSubmit={(e) => { e.preventDefault(); void perform({ type: "automation.save", taskId: draft.id,
        task: { ...draft.task, name: draft.task.name.trim(), prompt: draft.task.prompt.trim(), url: draft.task.url.trim() } }).then((ok) => { if (ok) setDraft(null); }); }}>
        <div class="settings-field"><label class="settings-field__label" for="task-name">Name</label>
          <input class="settings-input" id="task-name" required maxLength={TASK_NAME_CHARS} value={draft.task.name} disabled={busy} onInput={(e) => patch({ name: e.currentTarget.value })} /></div>
        <div class="settings-field"><label class="settings-field__label" for="task-url">Target URL</label>
          <input class="settings-input" id="task-url" type="url" required maxLength={2048} value={draft.task.url} disabled={busy} placeholder="https://example.com/" onInput={(e) => patch({ url: e.currentTarget.value })} /></div>
        <div class="settings-field"><label class="settings-field__label" for="task-prompt">Prompt</label>
          <textarea class="settings-input settings-input--text" id="task-prompt" rows={5} required maxLength={16_000} value={draft.task.prompt} disabled={busy} onInput={(e) => patch({ prompt: e.currentTarget.value })} /></div>
        <div class="settings-field"><label class="settings-field__label" for="task-frequency">Frequency</label>
          <Select id="task-frequency" value={draft.task.schedule.kind} disabled={busy} onChange={(e) => patch({ schedule: e.currentTarget.value === "daily" ? { kind: "daily", time: "09:00" } : { kind: "interval", minutes: 60 } })}>
            <option value="daily">Daily, local time</option><option value="interval">Every few minutes or hours</option>
          </Select></div>
        {draft.task.schedule.kind === "daily" ? <div class="settings-field"><label class="settings-field__label" for="task-time">Local time</label>
          <input class="settings-input" id="task-time" type="time" required value={draft.task.schedule.time} disabled={busy} onInput={(e) => patch({ schedule: { kind: "daily", time: e.currentTarget.value } })} /></div> :
          <div class="settings-field"><label class="settings-field__label" for="task-minutes">Interval in minutes (5 to 10,080)</label>
            <input class="settings-input" id="task-minutes" type="number" required min={MIN_INTERVAL_MINUTES} max={MAX_INTERVAL_MINUTES} step={1} value={draft.task.schedule.minutes} disabled={busy} onInput={(e) => patch({ schedule: { kind: "interval", minutes: Number(e.currentTarget.value) } })} /></div>}
        <label><input type="checkbox" checked={draft.task.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.currentTarget.checked })} /> Enable this task</label>
        <div class="settings-form__actions"><button class="settings-button" type="button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
          <button class="settings-button settings-button--primary" type="submit" disabled={busy}>Save task</button></div>
      </form>
    </Card></SettingsSection>}
    <SettingsSection label="Notifications"><Card>
      <Row title="Desktop notifications" controlId="automation-notifications" description="Off by default. Notify when a long run finishes, a run needs confirmation or help, or scheduled results are ready. Notifications contain only generic text; no prompts, page content, chat titles, or answers."
        control={<Switch id="automation-notifications" disabled={busy || !state} checked={state?.notifications.enabled ?? false} onChange={(e) => void perform({ type: "automation.notifications.save", enabled: e.currentTarget.checked })} />}/>
    </Card></SettingsSection>
  </>;
}
