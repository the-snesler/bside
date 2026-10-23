import { useEffect, useRef, useState } from "preact/hooks";
import { isSkill, MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, type Skill } from "@/lib/domain/skills";
import type { SkillsRequest } from "@/lib/protocol";
import { Card, Feedback, Note, Row, SettingsSection } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendSkillsRequest, type RequestBody } from "@/lib/ui/settings/requests";

const emptySkill = (): Skill => ({ name: "", description: "", body: "" });

export function SkillsEditor() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [builtins, setBuiltins] = useState<string[]>([]);
  const [draft, setDraft] = useState<Skill>(emptySkill);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);

  const request = async (action: RequestBody<SkillsRequest>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await sendSkillsRequest(action);
      if (!response.ok) { setError(response.error.message); return; }
      setSkills(response.skills);
      setBuiltins(response.builtinNames);
      setLoaded(true);
      if (action.type !== "skills.list") {
        setDraft(emptySkill());
        setEditing(false);
        setDeleting(null);
        setNotice(action.type === "skills.save" ? "Skill saved." : "Skill deleted.");
      }
    } catch { setError(BACKGROUND_FAILURE); }
    finally { setBusy(false); }
  };

  useEffect(() => { void request({ type: "skills.list" }); }, []);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);
  const readonly = builtins.includes(draft.name);
  const duplicate = !editing && skills.some((skill) => skill.name === draft.name);

  const open = (skill: Skill) => {
    setDraft({ ...skill });
    setEditing(true);
    setDeleting(null);
    setNotice(null);
    editor.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  return <>
    {error && <Feedback error>{error}</Feedback>}
    {notice && <Feedback>{notice}</Feedback>}

    <SettingsSection label="Your skills">
      <Card>
        {skills.map((skill) => {
          const packaged = builtins.includes(skill.name);
          return deleting === skill.name ? (
            <div key={skill.name} role="group" aria-label={`Confirm deleting /${skill.name}`}>
              <Row
                title={`Delete /${skill.name}?`}
                description="This cannot be undone."
                control={<>
                  <button ref={cancelDelete} type="button" class="settings-button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
                  <button type="button" class="settings-button settings-button--danger" disabled={busy} onClick={() => void request({ type: "skills.delete", name: skill.name })}>Confirm delete</button>
                </>}
              />
            </div>
          ) : (
            <Row
              key={skill.name}
              title={<><span class="settings-skill__name">/{skill.name}</span>{packaged && <span class="settings-badge">Packaged</span>}</>}
              description={skill.description}
              control={<>
                <button type="button" class="settings-button" disabled={busy} aria-label={`${packaged ? "View" : "Edit"} /${skill.name}`} onClick={() => open(skill)}>{packaged ? "View" : "Edit"}</button>
                {!packaged && <button type="button" class="settings-button" disabled={busy} aria-label={`Delete /${skill.name}`} onClick={() => setDeleting(skill.name)}>Delete</button>}
              </>}
            />
          );
        })}
        {loaded && !skills.length && <Row title="No skills yet." description="Create one below, then type /name in the sidebar to use it." />}
      </Card>
      <Note>Skills cannot grant browser capabilities or bypass safety rules.</Note>
    </SettingsSection>

    <div ref={editor} class="settings-anchor">
      <SettingsSection label={editing ? `${readonly ? "View" : "Edit"} /${draft.name}` : "New skill"}>
        <Card>
          <form
            class="settings-form"
            onSubmit={(event) => { event.preventDefault(); if (isSkill(draft) && !duplicate && !readonly) void request({ type: "skills.save", skill: draft }); }}
          >
            <div class="settings-field">
              <label class="settings-field__label" for="skill-name">Name</label>
              <input id="skill-name" class="settings-input" value={draft.name} maxLength={48} pattern="[a-z][a-z0-9-]{0,47}" required disabled={busy || editing} placeholder="research-summary" aria-describedby="skill-name-hint" onInput={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
              <span id="skill-name-hint" class="settings-field__hint">Lowercase letters, numbers, and hyphens; start with a letter. Every skill's name and description is sent with each request.</span>
            </div>
            <div class="settings-field">
              <label class="settings-field__label" for="skill-description">Description</label>
              <input id="skill-description" class="settings-input" value={draft.description} maxLength={MAX_SKILL_DESCRIPTION} required disabled={busy || readonly} onInput={(event) => setDraft({ ...draft, description: event.currentTarget.value })} />
            </div>
            <div class="settings-field">
              <label class="settings-field__label" for="skill-body">Instructions (Markdown)</label>
              <textarea id="skill-body" class="settings-input settings-input--code" value={draft.body} maxLength={MAX_SKILL_BODY} rows={12} required disabled={busy || readonly} onInput={(event) => setDraft({ ...draft, body: event.currentTarget.value })} />
            </div>
            {duplicate && <p class="settings-feedback settings-feedback--error">That name already exists. Select it above to edit.</p>}
            <div class="settings-form__actions">
              {editing && <button type="button" class="settings-button" disabled={busy} onClick={() => { setDraft(emptySkill()); setEditing(false); }}>New skill</button>}
              <button type="submit" class="settings-button settings-button--primary" disabled={!loaded || busy || readonly || duplicate || !isSkill(draft)}>{editing ? "Save changes" : "Create skill"}</button>
            </div>
          </form>
        </Card>
        <Note>Stored only in this Firefox profile, not encrypted or synced. Names and descriptions are shared with the model; bodies are sent when read. Invoked skills are also saved with chat history. Do not include secrets.</Note>
      </SettingsSection>
    </div>
  </>;
}
