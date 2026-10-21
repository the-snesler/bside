import { useEffect, useState } from "preact/hooks";
import { isSkill, MAX_SKILLS, MAX_SKILL_BODY, MAX_SKILL_DESCRIPTION, type Skill } from "@/lib/domain/skills";
import type { SkillsRequest, SkillsResponse } from "@/lib/protocol";

const emptySkill = (): Skill => ({ name: "", description: "", body: "" });
type Request = SkillsRequest extends infer T ? T extends SkillsRequest ? Omit<T, "v" | "id"> : never : never;

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

  const request = async (action: Request) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await browser.runtime.sendMessage({ v: 1, id: crypto.randomUUID(), ...action }) as SkillsResponse;
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
    } catch { setError("The background could not complete this request. Try again."); }
    finally { setBusy(false); }
  };

  useEffect(() => { void request({ type: "skills.list" }); }, []);
  const readonly = builtins.includes(draft.name);
  const duplicate = !editing && skills.some((skill) => skill.name === draft.name);

  return <section class="options__section">
    <h2 class="options__heading">Skills</h2>
    <p class="options__disclosure">Save reusable Markdown instructions and invoke one with /name in chat. Skills cannot grant browser capabilities or bypass safety rules.</p>
    <p class="options__disclosure">Stored only in this Firefox profile, not encrypted or synced. Names and descriptions are shared with the model; bodies are sent when read. Invoked skills are also saved with chat history. Do not include secrets.</p>
    <ul class="skills__list">
      {skills.map((skill) => <li key={skill.name}>
        <div class="options__form options__form--wrap">
          <button type="button" disabled={busy} onClick={() => { setDraft({ ...skill }); setEditing(true); setDeleting(null); setNotice(null); }}>/{skill.name}{builtins.includes(skill.name) ? " (packaged)" : ""}</button>
          {!builtins.includes(skill.name) && <button class="options__secondary" type="button" disabled={busy} onClick={() => setDeleting(skill.name)}>Delete</button>}
        </div>
        <p class="options__disclosure">{skill.description}</p>
        {deleting === skill.name && <div class="options__form options__form--wrap">
          <p class="options__confirm">Delete /{skill.name}? This cannot be undone.</p>
          <button type="button" disabled={busy} class="options__secondary" onClick={() => setDeleting(null)}>Cancel</button>
          <button type="button" disabled={busy} class="options__danger" onClick={() => void request({ type: "skills.delete", name: skill.name })}>Confirm delete</button>
        </div>}
      </li>)}
    </ul>
    {loaded && !skills.length && <p class="options__status">No skills yet.</p>}
    <form onSubmit={(event) => { event.preventDefault(); if (isSkill(draft) && !duplicate && !readonly) void request({ type: "skills.save", skill: draft }); }}>
      <label class="options__field">Name
        <input value={draft.name} maxLength={48} pattern="[a-z][a-z0-9-]{0,47}" required disabled={busy || editing} placeholder="research-summary" onInput={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
      </label>
      <p class="options__disclosure">Lowercase letters, numbers, and hyphens; start with a letter. Up to {MAX_SKILLS} skills.</p>
      <label class="options__field">Description
        <input value={draft.description} maxLength={MAX_SKILL_DESCRIPTION} required disabled={busy || readonly} onInput={(event) => setDraft({ ...draft, description: event.currentTarget.value })} />
      </label>
      <label class="options__field">Instructions (Markdown)
        <textarea value={draft.body} maxLength={MAX_SKILL_BODY} rows={10} required disabled={busy || readonly} onInput={(event) => setDraft({ ...draft, body: event.currentTarget.value })} />
      </label>
      {duplicate && <p class="options__error">That name already exists. Select it above to edit.</p>}
      <div class="options__form options__form--wrap">
        <button type="submit" disabled={!loaded || busy || readonly || duplicate || !isSkill(draft) || (!editing && skills.length >= MAX_SKILLS)}>{editing ? "Save changes" : "Create skill"}</button>
        {editing && <button type="button" class="options__secondary" disabled={busy} onClick={() => { setDraft(emptySkill()); setEditing(false); }}>New skill</button>}
      </div>
    </form>
    {error && <p class="options__error" role="alert">{error}</p>}
    {notice && <p class="options__status" role="status">{notice}</p>}
  </section>;
}
