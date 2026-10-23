import { useEffect, useRef, useState } from "preact/hooks";
import WorldPin from "~icons/tabler/world-pin";
import X from "~icons/tabler/x";
import { isSiteNote, MAX_SITE_NOTE_CHARS, type SiteNote } from "@/lib/domain/instructions";
import type { SiteNoteEditorState } from "@/lib/ui/use-background";

/**
 * "Remember something about this site": a compact editor on the composer for
 * the note covering the attached page's site. It edits that note in place (a
 * parent site's, if it covers subdomains), or starts one for the page's origin.
 */
export function SiteNoteEditor(props: { state: SiteNoteEditorState; onSave(note: SiteNote): void; onClose(): void }) {
  const { state } = props;
  const [text, setText] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const origin = state.note?.origin ?? state.origin;

  // Prefill once the existing note arrives; a refused save keeps what the user typed.
  const loaded = state.status === "ready" && !state.error;
  useEffect(() => {
    if (!loaded) return;
    setText(state.note?.text ?? "");
    setIncludeSubdomains(state.note?.includeSubdomains ?? false);
    textarea.current?.focus();
  }, [loaded, state.note]);

  const close = (
    <button type="button" class="icon-button site-note__close" aria-label="Close" title="Close" onClick={props.onClose}>
      <X />
    </button>
  );
  if (state.status === "loading") return <div class="site-note" role="status">Loading…</div>;
  if (!origin) return <div class="site-note" role="status"><span class="site-note__title">bside can only remember http(s) sites.</span>{close}</div>;
  if (state.status === "saved") {
    return (
      <div class="site-note site-note--saved" role="status">
        <WorldPin aria-hidden="true" />
        <span class="site-note__title">Saved. bside will read this when it works on {origin}{state.note?.includeSubdomains ? " or its subdomains" : ""}.</span>
        {close}
      </div>
    );
  }

  const note = { origin, includeSubdomains, text };
  const busy = state.status === "saving";
  return (
    <form
      class="site-note"
      aria-label={`Remember something about ${origin}`}
      onSubmit={(event) => { event.preventDefault(); if (isSiteNote(note)) props.onSave(note); }}
      onKeyDown={(event) => { if (event.key === "Escape") props.onClose(); }}
    >
      <div class="site-note__header">
        <WorldPin aria-hidden="true" />
        <span class="site-note__title" title={origin}>Remember about <strong>{new URL(origin).host}</strong></span>
        {close}
      </div>
      <textarea
        ref={textarea}
        class="site-note__text"
        rows={3}
        value={text}
        disabled={busy}
        placeholder="e.g. Prefer the CLI-style search syntax here."
        aria-label={`Note for ${origin}`}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      {state.error && <p class="site-note__error" role="alert">{state.error}</p>}
      <div class="site-note__footer">
        <label class="site-note__check">
          <input type="checkbox" checked={includeSubdomains} disabled={busy} onChange={(event) => setIncludeSubdomains(event.currentTarget.checked)} />
          Include subdomains
        </label>
        <span class={text.length > MAX_SITE_NOTE_CHARS ? "site-note__count site-note__count--over" : "site-note__count"}>
          {text.length.toLocaleString("en-US")} / {MAX_SITE_NOTE_CHARS.toLocaleString("en-US")}
        </span>
        <button type="submit" class="site-note__save" disabled={busy || !isSiteNote(note)}>{busy ? "Saving…" : "Save"}</button>
      </div>
      <p class="site-note__hint">bside follows this as your preference on this site; it can't override safety rules or skip confirmations. Manage notes in Settings.</p>
    </form>
  );
}
