import { describe, expect, it } from "vitest";
import { ApprovalBadge } from "@/lib/background/approval-badge";

async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

function fakeBadge() {
  const texts: string[] = [];
  const badge = new ApprovalBadge({ setBadgeText: ({ text }) => { texts.push(text); }, setBadgeBackgroundColor: () => {} });
  return { badge, texts, shown: async () => { await flush(); return texts.at(-1); } };
}

describe("ApprovalBadge with several runs", () => {
  it("shows ! while any run waits, whatever order the runs start and stop waiting in", async () => {
    const { badge, shown } = fakeBadge();
    badge.setPending("a", true);
    badge.setPending("b", true);
    expect(await shown()).toBe("!");
    badge.setPending("a", false);
    expect(badge.pending).toBe(true);
    expect(await shown()).toBe("!");
    // a waits again; b's end leaves a waiting.
    badge.setPending("a", true);
    badge.clearRun("b");
    expect(await shown()).toBe("!");
    badge.clearRun("a");
    expect(badge.pending).toBe(false);
    expect(await shown()).toBe("");
    // Clearing a run that never waited changes nothing.
    badge.clearRun("c");
    expect(badge.pending).toBe(false);
  });

  it("orders waiting runs by when they began waiting, a run that is still waiting keeping its place", () => {
    const { badge } = fakeBadge();
    badge.setPending("a", true);
    badge.setPending("b", true);
    badge.setPending("a", true);
    expect(badge.waitingRuns()).toEqual(["a", "b"]);
    badge.setPending("a", false);
    badge.setPending("a", true);
    expect(badge.waitingRuns()).toEqual(["b", "a"]);
  });

  it("falls back to the scheduled-results dot, and clears every run at startup", async () => {
    const { badge, shown } = fakeBadge();
    badge.setResults(true);
    badge.setPending("a", true);
    expect(await shown()).toBe("!");
    badge.clearRun("a");
    expect(badge.attention).toBe(true);
    expect(await shown()).toBe("•");
    badge.setPending("b", true);
    badge.setPending("c", true);
    badge.clearAll();
    expect(badge.waitingRuns()).toEqual([]);
    expect(await shown()).toBe("•");
  });
});
