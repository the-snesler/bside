import { useEffect, useRef, useState } from "preact/hooks";
import type { HistoryRetention, HistorySettingsV1 } from "@/lib/domain/conversation";
import type { HistoryRequest } from "@/lib/protocol";
import { Card, Feedback, Row, Select, SettingsSection } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendHistoryRequest, type RequestBody } from "@/lib/ui/settings/requests";
import { useRefreshOnFocus } from "../state";
import { ProblemReport } from "@/lib/ui/settings/ProblemReport";

const RETENTION_LABELS: Record<HistoryRetention, string> = { forever: "Forever", "30d": "30 days", "7d": "7 days" };

const chatCount = (count: number) => `${count} ${count === 1 ? "chat" : "chats"}`;

export function HistoryPage() {
  const [history, setHistory] = useState<{ settings: HistorySettingsV1; sessionCount: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const cancelDeleteAll = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (confirmDeleteAll) cancelDeleteAll.current?.focus(); }, [confirmDeleteAll]);

  useRefreshOnFocus(async () => {
    const response = await sendHistoryRequest({ type: "history.get" });
    if (response.ok) setHistory(response);
  });

  const performHistoryAction = async (request: RequestBody<HistoryRequest>) => {
    setNotice(null);
    setError(null);
    setConfirmDeleteAll(false);
    try {
      const response = await sendHistoryRequest(request);
      if (!response.ok) { setError(response.error.message); return; }
      setHistory(response);
      setNotice(response.notice);
    } catch { setError(BACKGROUND_FAILURE); }
  };

  return (
    <>
      {notice && <Feedback>{notice}</Feedback>}
      {error && <Feedback error>{error}</Feedback>}

      <SettingsSection label="Chat history">
        {history && (
          <Card>
            <Row
              title="Keep chats"
              controlId="settings-retention"
              description="Chats not updated within this period are deleted, starting immediately. Pinned chats, the open chat, and a chat with a running task are kept."
              control={
                <Select
                  id="settings-retention"
                  value={history.settings.retention}
                  onChange={(event) => void performHistoryAction({ type: "history.retention.save", retention: (event.target as HTMLSelectElement).value as HistoryRetention })}
                >
                  {(Object.keys(RETENTION_LABELS) as HistoryRetention[]).map((retention) => (
                    <option key={retention} value={retention}>{RETENTION_LABELS[retention]}</option>
                  ))}
                </Select>
              }
            />
            {confirmDeleteAll ? (
              <div role="group" aria-label="Confirm deleting all history">
                <Row
                  title="Delete all history?"
                  description={`Delete ${chatCount(history.sessionCount)}, including pinned ones? This cannot be undone.`}
                  control={<>
                    <button ref={cancelDeleteAll} type="button" class="settings-button" onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
                    <button type="button" class="settings-button settings-button--danger" onClick={() => void performHistoryAction({ type: "history.deleteAll" })}>Delete all</button>
                  </>}
                />
              </div>
            ) : (
              <Row
                title="Saved chats"
                live
                description={`${chatCount(history.sessionCount)} saved.`}
                control={<button type="button" class="settings-button settings-button--danger" onClick={() => setConfirmDeleteAll(true)}>Delete all history</button>}
              />
            )}
          </Card>
        )}
      </SettingsSection>

      <SettingsSection label="Privacy">
        <Card>
          <Row
            title="Stored only on this device"
            description="Chats are saved only in this Firefox profile and are never synced. They contain your prompts, bside's answers, and text from pages bside read for you, such as page titles, addresses, and excerpts."
          />
        </Card>
      </SettingsSection>
      <ProblemReport />
    </>
  );
}
