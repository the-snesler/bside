import { useEffect, useRef, useState } from "preact/hooks";
import Search from "~icons/tabler/search";
import {
  isMemoryDescription, isMemoryDraft, isMemoryTainted, MAX_MEMORIES, MAX_MEMORY_BODY, MAX_MEMORY_DESCRIPTION, memoryDraftProblem, memoryPath,
  type MemoryEntry, type MemorySettingsV1, type MemoryWritePolicy,
} from "@/lib/domain/memory";
import type { MemoryRequest } from "@/lib/protocol";
import { Card, CharacterCount, Feedback, Note, Row, Select, SettingsSection } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendMemoryRequest, type RequestBody } from "@/lib/ui/settings/requests";
import { itemFromHash } from "../navigation";
import { useRefreshOnFocus } from "../state";

const POLICY_LABELS: Record<MemoryWritePolicy, string> = { auto: "Automatically", ask: "Ask me first", off: "Never" };
const POLICY_HINTS: Record<MemoryWritePolicy, string> = {
  auto: "bside saves what seems worth keeping. Each save shows in the chat with Undo.",
  ask: "bside asks you to approve each save or removal in the chat first.",
  off: "bside saves nothing new. It can still read the memories below.",
};

const memoryCount = (count: number) => `${count} ${count === 1 ? "memory" : "memories"}`;
const formatDate = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const shortId = (id: string) => id.slice(0, 8);

function provenanceText(entry: MemoryEntry): string {
  const { provenance } = entry;
  return provenance.by === "user" ? `Edited by you · ${formatDate(provenance.at)}` : `Saved by bside · ${formatDate(provenance.at)}`;
}

/** The entry's description and body, edited in place under its row. Saving records you as its source. */
function MemoryEditor(props: { entry: MemoryEntry; busy: boolean; onSave(description: string, body: string): void; onCancel(): void }) {
  const [description, setDescription] = useState(props.entry.description);
  const [body, setBody] = useState(props.entry.body);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const id = `memory-${props.entry.name}`;
  const draft = { name: props.entry.name, description, body };
  const problem = memoryDraftProblem(draft);
  return (
    <form class="settings-form settings-form--inline" onSubmit={(event) => { event.preventDefault(); if (!problem) props.onSave(description, body); }}>
      <div class="settings-field">
        <label class="settings-field__label" for={`${id}-description`}>Description</label>
        <input
          ref={input}
          id={`${id}-description`}
          class="settings-input"
          value={description}
          disabled={props.busy}
          aria-describedby={`${id}-description-count`}
          onInput={(event) => setDescription(event.currentTarget.value)}
        />
        <span class="settings-field__hint settings-field__hint--split">
          <span>{description && !isMemoryDescription(description) ? "One line, up to 160 characters." : ""}</span>
          <CharacterCount id={`${id}-description-count`} length={description.length} max={MAX_MEMORY_DESCRIPTION} />
        </span>
      </div>
      <div class="settings-field">
        <label class="settings-field__label" for={`${id}-body`}>Memory</label>
        <textarea
          id={`${id}-body`}
          class="settings-input settings-input--text"
          rows={5}
          value={body}
          disabled={props.busy}
          aria-describedby={`${id}-body-count`}
          onInput={(event) => setBody(event.currentTarget.value)}
        />
        <span class="settings-field__hint settings-field__hint--split">
          <span />
          <CharacterCount id={`${id}-body-count`} length={body.length} max={MAX_MEMORY_BODY} />
        </span>
      </div>
      {/* Length and line problems show in the hints; this is the secret check. */}
      {problem && isMemoryDraft(draft) && <p class="settings-feedback settings-feedback--error">{problem}</p>}
      <div class="settings-form__actions">
        <button type="button" class="settings-button" disabled={props.busy} onClick={props.onCancel}>Cancel</button>
        <button type="submit" class="settings-button settings-button--primary" disabled={props.busy || problem !== null}>Save</button>
      </div>
    </form>
  );
}

/** What bside remembers across chats: the write policy, the entries with their provenance, export, and "Forget everything". */
export function MemoryPage() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [settings, setSettings] = useState<MemorySettingsV1 | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(() => itemFromHash(location.hash));
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const cancelForget = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);
  useEffect(() => { if (forgetting) cancelForget.current?.focus(); }, [forgetting]);

  // A deep link (`#/memory/<name>`, the sidebar's View) opens that entry.
  useEffect(() => {
    const onHashChange = () => setOpen(itemFromHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    if (open && entries) document.getElementById(`memory-row-${open}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, entries !== null]);

  useRefreshOnFocus(async () => {
    const response = await sendMemoryRequest({ type: "memory.list" });
    if (!response.ok) return;
    setEntries(response.entries);
    setSettings(response.settings);
  });

  const request = async (action: RequestBody<MemoryRequest>, done: string | null): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await sendMemoryRequest(action);
      if (!response.ok) { setError(response.error.message); return false; }
      setEntries(response.entries);
      setSettings(response.settings);
      setEditing(null);
      setDeleting(null);
      setForgetting(false);
      setNotice(done);
      return true;
    } catch { setError(BACKGROUND_FAILURE); return false; }
    finally { setBusy(false); }
  };

  const toggle = (name: string) => {
    const next = open === name ? null : name;
    setOpen(next);
    // Keep the address in step without the shell's scroll-to-top on navigation.
    history.replaceState(null, "", next ? `#/memory/${next}` : "#/memory");
  };

  const exportJson = () => {
    if (!entries) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), memories: entries }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bside-memory-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const needle = query.trim().toLocaleLowerCase();
  const shown = (entries ?? []).filter((entry) => !needle || [entry.name, entry.description, entry.body].some((text) => text.toLocaleLowerCase().includes(needle)));

  return (
    <>
      {error && <Feedback error>{error}</Feedback>}
      {notice && <Feedback>{notice}</Feedback>}

      <SettingsSection label="Saving">
        {settings && (
          <Card>
            <Row
              title="Save memories"
              controlId="memory-policy"
              description={POLICY_HINTS[settings.writes]}
              live
              control={
                <Select
                  id="memory-policy"
                  value={settings.writes}
                  disabled={busy}
                  onChange={(event) => void request({ type: "memory.settings.save", settings: { version: 1, writes: (event.target as HTMLSelectElement).value as MemoryWritePolicy } }, null)}
                >
                  {(Object.keys(POLICY_LABELS) as MemoryWritePolicy[]).map((policy) => <option key={policy} value={policy}>{POLICY_LABELS[policy]}</option>)}
                </Select>
              }
            />
          </Card>
        )}
      </SettingsSection>

      <SettingsSection label="Your memories">
        {entries && entries.length > 0 && (
          <div class="settings-search settings-search--page">
            <Search class="settings-search__icon" aria-hidden="true" />
            <input
              type="search"
              class="settings-search__input"
              placeholder="Search memories"
              aria-label="Search memories"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
        )}
        <Card>
          {shown.map((entry) => deleting === entry.name ? (
            <div key={entry.name} role="group" aria-label={`Confirm deleting ${entry.name}`}>
              <Row
                title={`Delete “${entry.name}”?`}
                description="bside will no longer remember this. This cannot be undone."
                control={<>
                  <button ref={cancelDelete} type="button" class="settings-button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
                  <button type="button" class="settings-button settings-button--danger" disabled={busy}
                    onClick={() => void request({ type: "memory.delete", name: entry.name }, `Deleted “${entry.name}”.`)}>Confirm delete</button>
                </>}
              />
            </div>
          ) : (
            <div key={entry.name} id={`memory-row-${entry.name}`} class={open === entry.name ? "settings-memory settings-memory--open" : "settings-memory"}>
              <Row
                title={<>
                  <span class="settings-skill__name">{entry.name}</span>
                  {isMemoryTainted(entry) && (
                    <span class="settings-badge settings-badge--warning" title="bside had read web content before saving this. Check it's something you want kept, not something a page told it to remember.">After web content</span>
                  )}
                </>}
                description={<>
                  <span class="settings-memory__description">{entry.description}</span>
                  <span class="settings-memory__provenance">{provenanceText(entry)}</span>
                </>}
                control={editing === entry.name ? undefined : <>
                  <button type="button" class="settings-button" disabled={busy} aria-expanded={open === entry.name} aria-controls={`memory-body-${entry.name}`}
                    aria-label={`${open === entry.name ? "Hide" : "View"} ${entry.name}`} onClick={() => toggle(entry.name)}>{open === entry.name ? "Hide" : "View"}</button>
                  <button type="button" class="settings-button" disabled={busy} aria-label={`Edit ${entry.name}`}
                    onClick={() => { setEditing(entry.name); setOpen(entry.name); setDeleting(null); }}>Edit</button>
                  <button type="button" class="settings-button" disabled={busy} aria-label={`Delete ${entry.name}`}
                    onClick={() => { setDeleting(entry.name); setEditing(null); }}>Delete</button>
                </>}
              >
                {editing === entry.name ? (
                  <MemoryEditor entry={entry} busy={busy} onCancel={() => setEditing(null)}
                    onSave={(description, body) => void request({ type: "memory.save", entry: { name: entry.name, description, body } }, `Saved “${entry.name}”.`)} />
                ) : open === entry.name ? (
                  <div id={`memory-body-${entry.name}`} class="settings-memory__details">
                    <p class="settings-memory__body">{entry.body || "(no details beyond the description)"}</p>
                    <dl class="settings-memory__facts">
                      <dt>File</dt><dd>{memoryPath(entry.name)}</dd>
                      <dt>First saved</dt><dd>{formatDate(entry.createdAt)}</dd>
                      {entry.provenance.by === "agent" && <>
                        <dt>Saved in</dt><dd>chat {shortId(entry.provenance.sessionId)} · run {shortId(entry.provenance.runId)}</dd>
                        <dt>Web content</dt><dd>{entry.provenance.tainted ? "Read before saving: a page may have influenced this." : "None read before saving."}</dd>
                      </>}
                    </dl>
                  </div>
                ) : undefined}
              </Row>
            </div>
          ))}
          {entries && entries.length === 0 && <Row title="No memories yet." description="When bside learns something worth keeping across chats, it appears here." />}
          {entries && entries.length > 0 && shown.length === 0 && <Row title="No matching memories." />}
        </Card>
        {entries && entries.length > 0 && <Note>{memoryCount(entries.length)} of {MAX_MEMORIES}. Memories are bside's own notes, not instructions: they cannot override its safety rules, skip asking before consequential actions, or give it new abilities.</Note>}
      </SettingsSection>

      <SettingsSection label="Export and forget">
        <Card>
          <Row
            title="Export memories"
            description="Download every memory and where it came from as a JSON file."
            control={<button type="button" class="settings-button" disabled={!entries?.length} onClick={exportJson}>Export JSON</button>}
          />
          {forgetting ? (
            <div role="group" aria-label="Confirm forgetting every memory">
              <Row
                title="Forget everything?"
                description={`Delete ${memoryCount(entries?.length ?? 0)}. bside will not remember any of it. This cannot be undone.`}
                control={<>
                  <button ref={cancelForget} type="button" class="settings-button" disabled={busy} onClick={() => setForgetting(false)}>Cancel</button>
                  <button type="button" class="settings-button settings-button--danger" disabled={busy}
                    onClick={() => void request({ type: "memory.forgetAll" }, "Every memory was forgotten.")}>Forget everything</button>
                </>}
              />
            </div>
          ) : (
            <Row
              title="Forget everything"
              description="Delete every memory. Chats are kept."
              control={<button type="button" class="settings-button settings-button--danger" disabled={!entries?.length} onClick={() => setForgetting(true)}>Forget everything</button>}
            />
          )}
        </Card>
        <Note>Memories are stored only in this Firefox profile, not encrypted or synced. bside refuses to save text that looks like a password, key, token, or card number.</Note>
      </SettingsSection>
    </>
  );
}
