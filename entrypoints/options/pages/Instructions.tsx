import { useRef, useState } from "preact/hooks";
import { MAX_CUSTOM_INSTRUCTIONS } from "@/lib/domain/instructions";
import { Card, CharacterCount, Feedback, Note, SettingsSection } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendInstructionsRequest } from "@/lib/ui/settings/requests";
import { useRefreshOnFocus } from "../state";

export function InstructionsPage() {
  /** The saved text; `null` until loaded. */
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The refresh closure outlives renders, so it reads the saved text from here.
  const savedRef = useRef<string | null>(null);
  const adopt = (text: string) => { savedRef.current = text; setSaved(text); };

  useRefreshOnFocus(async () => {
    const response = await sendInstructionsRequest({ type: "instructions.get" });
    if (!response.ok) return;
    // Keep an unsaved edit when the tab regains focus.
    const previous = savedRef.current;
    setDraft((current) => previous === null || current === previous ? response.text : current);
    adopt(response.text);
  });

  const save = async (text: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await sendInstructionsRequest({ type: "instructions.save", text });
      if (!response.ok) { setError(response.error.message); return; }
      adopt(response.text);
      setDraft(response.text);
      setNotice(response.text ? "Instructions saved. They apply from the next message." : "Instructions cleared.");
    } catch { setError(BACKGROUND_FAILURE); }
    finally { setBusy(false); }
  };

  const tooLong = draft.length > MAX_CUSTOM_INSTRUCTIONS;
  return (
    <>
      {error && <Feedback error>{error}</Feedback>}
      {notice && <Feedback>{notice}</Feedback>}

      <SettingsSection label="Custom instructions">
        <Card>
          <form class="settings-form" onSubmit={(event) => { event.preventDefault(); if (!tooLong) void save(draft); }}>
            <div class="settings-field">
              <label class="settings-field__label" for="custom-instructions">About you and how bside should respond</label>
              <textarea
                id="custom-instructions"
                class="settings-input settings-input--text"
                rows={10}
                value={draft}
                disabled={saved === null || busy}
                placeholder={"I'm a nurse in Lyon; prices in euros, please.\nKeep answers short and lead with the answer."}
                aria-describedby="custom-instructions-hint custom-instructions-count"
                onInput={(event) => setDraft(event.currentTarget.value)}
              />
              <span class="settings-field__hint settings-field__hint--split">
                <span id="custom-instructions-hint">Sent with every message in every chat.</span>
                <CharacterCount id="custom-instructions-count" length={draft.length} max={MAX_CUSTOM_INSTRUCTIONS} />
              </span>
            </div>
            <div class="settings-form__actions">
              {saved && <button type="button" class="settings-button" disabled={busy} onClick={() => void save("")}>Clear</button>}
              <button type="submit" class="settings-button settings-button--primary" disabled={saved === null || busy || tooLong || draft === saved}>Save</button>
            </div>
          </form>
        </Card>
        <Note>bside treats these as your preferences. They cannot override its safety rules, skip asking before consequential actions, or give it new abilities. Stored only in this Firefox profile, not encrypted or synced; do not include secrets.</Note>
      </SettingsSection>
    </>
  );
}
