import Brain from "~icons/tabler/brain";
import type { MemoryChange } from "@/lib/domain/memory";
import type { MemoryUndoState } from "@/lib/ui/use-background";

const plural = (count: number) => `${count} ${count === 1 ? "memory" : "memories"}`;

/** "Saved 1 memory", "Saved 2 memories · removed 1 memory": each name counted once per kind of change. */
export function describeMemoryChanges(changes: readonly MemoryChange[]): string {
  const saved = new Set(changes.filter((change) => change.op === "write").map((change) => change.name)).size;
  const removed = new Set(changes.filter((change) => change.op === "remove").map((change) => change.name)).size;
  const parts = [...(saved ? [`saved ${plural(saved)}`] : []), ...(removed ? [`removed ${plural(removed)}`] : [])];
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The settings Memory page, opened at the one entry a turn saved when there is just one. */
export function memoryPageUrl(changes: readonly MemoryChange[]): string {
  const saved = [...new Set(changes.filter((change) => change.op === "write").map((change) => change.name))];
  return browser.runtime.getURL(`/options.html#/memory${saved.length === 1 ? `/${saved[0]}` : ""}`);
}

/**
 * Under a turn that changed memory: what it saved or removed, a badge when
 * bside had read web content first, View (the settings Memory page), and
 * Undo, which reverts the turn's changes unless something changed them since.
 */
export function MemoryNotice(props: { changes: readonly MemoryChange[]; undo: MemoryUndoState | undefined; onUndo: () => void }) {
  const { changes, undo } = props;
  const tainted = changes.some((change) => change.tainted);
  return (
    <div class="memory-notice" role="group" aria-label="Memory changes">
      <p class="memory-notice__line">
        <Brain class="memory-notice__icon" aria-hidden="true" />
        <span>{describeMemoryChanges(changes)}</span>
        {tainted && (
          <span class="memory-notice__badge" title="bside read web content before this change. Check it's something you want kept, not something a page told it to remember.">
            after web content
          </span>
        )}
        <span aria-hidden="true">·</span>
        <a class="memory-notice__action" href={memoryPageUrl(changes)} target="_blank" rel="noopener">View</a>
        {undo?.status !== "undone" && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" class="memory-notice__action" disabled={undo?.status === "undoing"} onClick={props.onUndo}>
              {undo?.status === "undoing" ? "Undoing…" : "Undo"}
            </button>
          </>
        )}
        {undo?.status === "undone" && <><span aria-hidden="true">·</span><span class="memory-notice__done">Undone</span></>}
      </p>
      {undo?.error && <p class="memory-notice__error" role="status">{undo.error}</p>}
    </div>
  );
}
