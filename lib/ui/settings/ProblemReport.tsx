import { useState } from "preact/hooks";
import { Card, Feedback, Note, Row, Select, SettingsSection } from "./primitives";
import { BACKGROUND_FAILURE, sendProblemReportRequest } from "./requests";

/** The user creates a file locally and decides where, or whether, to attach it. */
export function ProblemReport() {
  const [sessions, setSessions] = useState<{ id: string; title: string }[] | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await sendProblemReportRequest({ type: "problemReport.list" });
      if (!result.ok) { setError(result.error.message); return; }
      if (result.type === "problemReport.list") { setSessions(result.sessions); setSessionId(result.sessions[0]?.id ?? ""); }
    } catch { setError(BACKGROUND_FAILURE); }
    finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await sendProblemReportRequest({ type: "problemReport.export", sessionId });
      if (!result.ok) { setError(result.error.message); return; }
      if (result.type !== "problemReport.export") return;
      const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = result.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice("Report downloaded. Review the file, then attach it manually if you choose. Nothing was sent.");
    } catch { setError(BACKGROUND_FAILURE); }
    finally { setBusy(false); }
  };
  return <SettingsSection label="Report a problem">
    <Card>
      <Row title="Local diagnostic report" description="Download counts, timing, token usage, and error codes for one chat. Prompts, page text, model text, tool arguments and results, URLs, files, and credentials are excluded."
        control={<button type="button" class="settings-button" disabled={busy} onClick={() => void start()}>Prepare report</button>} />
      {sessions && <>
        <Row title="Chat to diagnose" controlId="problem-chat" description="Chat titles help you choose here; they are excluded from the file. Detailed timing is available only for the most recent run in this background session."
          control={<Select id="problem-chat" value={sessionId} disabled={busy || !sessions.length} onChange={(event) => setSessionId(event.currentTarget.value)}>
            {sessions.map((session) => <option key={session.id} value={session.id}>{session.title || "New chat"}</option>)}
          </Select>} />
        <Row title="Review and share yourself" description="No network request or automatic telemetry. The file contains no conversation content."
          control={<button type="button" class="settings-button" disabled={busy || !sessionId} onClick={() => void download()}>Download redacted report</button>} />
      </>}
    </Card>
    <Note>The chat history export is separate and can contain sensitive content. Use this report for diagnostics.</Note>
    {error && <Feedback error>{error}</Feedback>}
    {notice && <Feedback>{notice}</Feedback>}
  </SettingsSection>;
}
