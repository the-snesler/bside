import { useEffect, useRef, useState } from "preact/hooks";
import Search from "~icons/tabler/search";
import { isSiteNote, MAX_SITE_NOTE_CHARS, MAX_SITE_NOTES, siteOriginFromInput, type SiteNote } from "@/lib/domain/instructions";
import type { SiteNotesRequest } from "@/lib/protocol";
import { Card, CharacterCount, Feedback, Note, Row, SettingsSection, Switch } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendSiteNotesRequest, type RequestBody } from "@/lib/ui/settings/requests";
import { useRefreshOnFocus } from "../state";

const noteCount = (count: number) => `${count} ${count === 1 ? "note" : "notes"}`;

/** The note's text and subdomain flag, edited in place under its row. */
function NoteEditor(props: { note: SiteNote; busy: boolean; onSave(note: SiteNote): void; onCancel(): void }) {
  const [text, setText] = useState(props.note.text);
  const [includeSubdomains, setIncludeSubdomains] = useState(props.note.includeSubdomains);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => textarea.current?.focus(), []);
  const next = { origin: props.note.origin, includeSubdomains, text };
  const id = `site-note-${props.note.origin.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <form class="settings-form settings-form--inline" onSubmit={(event) => { event.preventDefault(); if (isSiteNote(next)) props.onSave(next); }}>
      <div class="settings-field">
        <textarea
          ref={textarea}
          id={`${id}-text`}
          class="settings-input settings-input--text"
          rows={3}
          value={text}
          disabled={props.busy}
          aria-label={`Note for ${props.note.origin}`}
          aria-describedby={`${id}-count`}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <span class="settings-field__hint settings-field__hint--split">
          <label class="settings-check">
            <Switch checked={includeSubdomains} disabled={props.busy} onChange={(event) => setIncludeSubdomains(event.currentTarget.checked)} />
            Include subdomains
          </label>
          <CharacterCount id={`${id}-count`} length={text.length} max={MAX_SITE_NOTE_CHARS} />
        </span>
      </div>
      <div class="settings-form__actions">
        <button type="button" class="settings-button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
        <button type="submit" class="settings-button settings-button--primary" disabled={props.busy || !isSiteNote(next)}>Save</button>
      </div>
    </form>
  );
}

export function SiteNotesPage() {
  const [notes, setNotes] = useState<SiteNote[] | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [site, setSite] = useState("");
  const [text, setText] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);

  useRefreshOnFocus(async () => {
    const response = await sendSiteNotesRequest({ type: "siteNotes.list" });
    if (response.ok) setNotes(response.notes);
  });

  const request = async (action: RequestBody<SiteNotesRequest>, done: string): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await sendSiteNotesRequest(action);
      if (!response.ok) { setError(response.error.message); return false; }
      setNotes(response.notes);
      setEditing(null);
      setDeleting(null);
      setNotice(done);
      return true;
    } catch { setError(BACKGROUND_FAILURE); return false; }
    finally { setBusy(false); }
  };

  const origin = siteOriginFromInput(site);
  const draft = origin ? { origin, includeSubdomains, text } : null;
  const duplicate = origin !== null && notes?.some((note) => note.origin === origin);
  const full = (notes?.length ?? 0) >= MAX_SITE_NOTES;
  const needle = query.trim().toLowerCase();
  const shown = (notes ?? []).filter((note) => !needle || note.origin.toLowerCase().includes(needle) || note.text.toLowerCase().includes(needle));

  const add = async () => {
    if (!draft || !isSiteNote(draft) || duplicate || full) return;
    if (await request({ type: "siteNotes.save", note: draft }, `Note for ${draft.origin} added.`)) {
      setSite("");
      setText("");
      setIncludeSubdomains(false);
    }
  };

  return (
    <>
      {error && <Feedback error>{error}</Feedback>}
      {notice && <Feedback>{notice}</Feedback>}

      <SettingsSection label="Your site notes">
        {notes && notes.length > 0 && (
          <div class="settings-search settings-search--page">
            <Search class="settings-search__icon" aria-hidden="true" />
            <input
              type="search"
              class="settings-search__input"
              placeholder="Search notes"
              aria-label="Search site notes"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
        )}
        <Card>
          {shown.map((note) => deleting === note.origin ? (
            <div key={note.origin} role="group" aria-label={`Confirm deleting the note for ${note.origin}`}>
              <Row
                title={`Delete the note for ${note.origin}?`}
                description="This cannot be undone."
                control={<>
                  <button ref={cancelDelete} type="button" class="settings-button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
                  <button type="button" class="settings-button settings-button--danger" disabled={busy}
                    onClick={() => void request({ type: "siteNotes.delete", origin: note.origin }, `Note for ${note.origin} deleted.`)}>Confirm delete</button>
                </>}
              />
            </div>
          ) : (
            <Row
              key={note.origin}
              title={<><span class="settings-skill__name">{note.origin}</span>{note.includeSubdomains && <span class="settings-badge">Subdomains</span>}</>}
              description={editing === note.origin ? undefined : <span class="settings-site-note__text">{note.text}</span>}
              control={editing === note.origin ? undefined : <>
                <button type="button" class="settings-button" disabled={busy} aria-label={`Edit the note for ${note.origin}`} onClick={() => { setEditing(note.origin); setDeleting(null); }}>Edit</button>
                <button type="button" class="settings-button" disabled={busy} aria-label={`Delete the note for ${note.origin}`} onClick={() => { setDeleting(note.origin); setEditing(null); }}>Delete</button>
              </>}
            >
              {editing === note.origin
                ? <NoteEditor note={note} busy={busy} onCancel={() => setEditing(null)} onSave={(next) => void request({ type: "siteNotes.save", note: next }, `Note for ${next.origin} saved.`)} />
                : undefined}
            </Row>
          ))}
          {notes && notes.length === 0 && <Row title="No site notes yet." description='Add one below, or choose "Remember something about this site" in the sidebar.' />}
          {notes && notes.length > 0 && shown.length === 0 && <Row title="No matching notes." />}
        </Card>
        {notes && notes.length > 0 && <Note>{noteCount(notes.length)} of {MAX_SITE_NOTES}.</Note>}
      </SettingsSection>

      <SettingsSection label="Add a note">
        <Card>
          <form class="settings-form" onSubmit={(event) => { event.preventDefault(); void add(); }}>
            <div class="settings-field">
              <label class="settings-field__label" for="site-note-site">Site</label>
              <input
                id="site-note-site"
                class="settings-input"
                value={site}
                placeholder="github.com"
                maxLength={300}
                disabled={notes === null || busy}
                aria-describedby="site-note-site-hint"
                onInput={(event) => setSite(event.currentTarget.value)}
              />
              <span id="site-note-site-hint" class="settings-field__hint">
                {site.trim() && !origin ? "Enter an http(s) site, like github.com." : origin ? `Applies to ${origin}${includeSubdomains ? " and its subdomains" : ""}.` : "A domain or any address on the site."}
              </span>
            </div>
            <label class="settings-check">
              <Switch checked={includeSubdomains} disabled={notes === null || busy} onChange={(event) => setIncludeSubdomains(event.currentTarget.checked)} />
              Include subdomains
            </label>
            <div class="settings-field">
              <label class="settings-field__label" for="site-note-text">Note</label>
              <textarea
                id="site-note-text"
                class="settings-input settings-input--text"
                rows={3}
                value={text}
                placeholder="Prefer the CLI-style search syntax."
                disabled={notes === null || busy}
                aria-describedby="site-note-text-count"
                onInput={(event) => setText(event.currentTarget.value)}
              />
              <span class="settings-field__hint settings-field__hint--split">
                <span />
                <CharacterCount id="site-note-text-count" length={text.length} max={MAX_SITE_NOTE_CHARS} />
              </span>
            </div>
            {duplicate && <p class="settings-feedback settings-feedback--error">{origin} already has a note. Edit it above.</p>}
            {full && <p class="settings-feedback settings-feedback--error">Up to {MAX_SITE_NOTES} site notes can be saved. Delete one first.</p>}
            <div class="settings-form__actions">
              <button type="submit" class="settings-button settings-button--primary" disabled={notes === null || busy || duplicate || full || !draft || !isSiteNote(draft)}>Add note</button>
            </div>
          </form>
        </Card>
        <Note>bside reads a site's note only when you attach or mention a page from it, or when it uses that site while working. Notes are your preferences: they cannot override bside's safety rules, skip asking before consequential actions, or give it new abilities. Stored only in this Firefox profile, not encrypted or synced; do not include secrets.</Note>
      </SettingsSection>
    </>
  );
}
