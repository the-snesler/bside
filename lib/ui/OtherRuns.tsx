/**
 * The chats other than the open one that have a run, as a compact strip over
 * the transcript: each names its chat and what its run is doing, and opens
 * that chat on click. Chats that need the user come first. Past
 * `OTHER_RUNS_LISTED` the strip collapses to a count that expands. Chat
 * titles are untrusted text.
 */

import { useState } from "preact/hooks";
import ChevronDown from "~icons/tabler/chevron-down";
import ChevronUp from "~icons/tabler/chevron-up";
import type { RunState } from "@/lib/protocol";

/** What a run is waiting on the user for, if anything. */
export type RunAttention = "confirmation" | "help" | null;

export function runAttention(run: Pick<RunState, "pendingApproval" | "pendingHelp">): RunAttention {
  return run.pendingApproval ? "confirmation" : run.pendingHelp ? "help" : null;
}

/** A run in another chat, as the strip shows it. */
export interface OtherRun {
  sessionId: string;
  /** The chat's title as the history lists it; empty for an untitled chat. */
  title: string;
  attention: RunAttention;
  stopping: boolean;
}

/** More than this many collapse to a count. */
export const OTHER_RUNS_LISTED = 3;
const LIST_ID = "other-runs-list";

export function describeOtherRun(run: OtherRun): string {
  if (run.attention === "confirmation") return "Needs confirmation";
  if (run.attention === "help") return "Needs your help";
  return run.stopping ? "Stopping" : "Working";
}

export function OtherRunsStrip(props: { runs: readonly OtherRun[]; onOpen(sessionId: string): void }) {
  const [expanded, setExpanded] = useState(false);
  if (props.runs.length === 0) return null;
  const needing = props.runs.filter((run) => run.attention);
  const runs = [...needing, ...props.runs.filter((run) => !run.attention)];
  const waiting = needing.length;
  const collapsible = runs.length > OTHER_RUNS_LISTED;
  const Chevron = expanded ? ChevronUp : ChevronDown;

  return (
    <section class="other-runs" aria-label="Other chats with runs">
      {collapsible && (
        <button
          type="button"
          class="other-runs__summary"
          aria-expanded={expanded}
          aria-controls={LIST_ID}
          onClick={() => setExpanded(!expanded)}
        >
          {waiting > 0 ? <span class="other-runs__mark other-runs__mark--needs" aria-hidden="true" /> : <span class="live-dot" aria-hidden="true" />}
          <span class="other-runs__count">{`${runs.length} other chats running`}</span>
          {waiting > 0 && <span class="needs-you">{`${waiting} ${waiting === 1 ? "needs" : "need"} you`}</span>}
          <Chevron class="other-runs__chevron" aria-hidden="true" />
        </button>
      )}
      {(!collapsible || expanded) && (
        <ul id={LIST_ID} class="other-runs__list">
          {runs.map((run) => {
            const title = run.title || "New chat";
            const state = describeOtherRun(run);
            return (
              <li key={run.sessionId}>
                <button
                  type="button"
                  class="other-runs__item"
                  data-needs={run.attention ? "" : undefined}
                  title={`Open ${title}`}
                  aria-label={`${title}: ${state}. Open this chat`}
                  onClick={() => props.onOpen(run.sessionId)}
                >
                  {run.attention ? <span class="other-runs__mark other-runs__mark--needs" aria-hidden="true" /> : <span class="live-dot" aria-hidden="true" />}
                  <span class="other-runs__title">{title}</span>
                  <span class="other-runs__state">{state}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
