/**
 * Text operations on a page outline, shared by the content script (one
 * frame's outline) and the background (a tab's outline composed from its
 * frames): size bounds, paging slices, and find.
 */

import type { PageFindResult } from "./tools";

const MAX_FIND_MATCHES = 30;
const FIND_LINE_LIMIT = 400;

/** Whole lines while they fit in `maxChars` (joined with newlines), then `notice`; with each kept line's offset. */
export function boundOutline(lines: readonly string[], maxChars: number, notice: string): { lines: string[]; offsets: number[] } {
  const kept: string[] = [];
  const offsets: number[] = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length > maxChars) {
      kept.push(notice);
      offsets.push(total);
      break;
    }
    offsets.push(total);
    kept.push(line);
    total += line.length + 1;
  }
  return { lines: kept, offsets };
}

/** Character offset of each line within `lines.join("\n")`. */
export function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let total = 0;
  for (const line of lines) {
    offsets.push(total);
    total += line.length + 1;
  }
  return offsets;
}

/** A slice of at most `maxChars` that starts and, unless it reaches the end, ends on a line boundary. */
export function sliceOutline(text: string, offset: number, maxChars: number): { start: number; end: number } {
  let start = Math.min(Math.max(offset, 0), text.length);
  if (start > 0 && text[start - 1] !== "\n") start = text.lastIndexOf("\n", start - 1) + 1;
  let end = Math.min(text.length, start + maxChars);
  if (end < text.length) {
    const cut = text.lastIndexOf("\n", end);
    if (cut > start) end = cut;
  }
  return { start, end };
}

/** Lines containing `query` (case-insensitive), clipped around the match, each with a short preceding line for context. */
export function findInOutline(lines: readonly string[], offsets: readonly number[], query: string): Pick<PageFindResult, "count" | "matches"> {
  const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  const matches: PageFindResult["matches"] = [];
  let count = 0;
  lines.forEach((line, index) => {
    const position = line.toLowerCase().indexOf(needle);
    if (position < 0) return;
    count++;
    if (matches.length >= MAX_FIND_MATCHES) return;
    let text = line;
    if (line.length > FIND_LINE_LIMIT) {
      const from = Math.max(0, position - 180);
      text = `${from > 0 ? "…" : ""}${line.slice(from, from + FIND_LINE_LIMIT)}${from + FIND_LINE_LIMIT < line.length ? "…" : ""}`;
    }
    // A short preceding line (often a label or heading) gives the match context.
    const previous = lines[index - 1];
    if (previous && previous.length <= 120 && !previous.toLowerCase().includes(needle)) text = `${previous}\n${text}`;
    matches.push({ offset: offsets[index] ?? 0, text });
  });
  return { count, matches };
}
