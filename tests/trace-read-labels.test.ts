// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { describeActivity } from "@/lib/ui/TurnTrace";
import type { Activity } from "@/lib/ui/turns";

function activity(source: string, ok?: boolean): Activity {
  return {
    kind: "activity", id: "read", startedAt: 0, endedAt: ok === undefined ? null : 1,
    call: { id: "read", name: "browser_program", arguments: { source } },
    result: ok === undefined ? null : { ok, summary: ok ? "Read." : "File missing." },
  };
}

describe("trace read labels", () => {
  it.each([
    'fs.read("/skills/uw-morgridge-room-booking.md");',
    'fs.read("/workspace/notes.md");',
    'fs.read("/future-mount/notes.md");',
    'fs.read(path);',
    'fs . read (path);',
    'fs.read("/tabs/12/page.md");',
    'fs.read("/agent-tabs/12/page.md");',
    'fs.read("/skills/booking.md"); page.snapshot();',
  ])("uses truthful generic file labels for %s", (source) => {
    expect(describeActivity(activity(source), false)).toMatchObject({ title: "Reading file content", status: "running" });
    expect(describeActivity(activity(source, true), false).title).toBe("Read file content");
    expect(describeActivity(activity(source, false), false)).toMatchObject({ title: "Couldn't read file content", status: "error" });
  });

  it("labels YouTube site calls", () => {
    const source = 'const both = await Promise.all([youtube.getMetadata("x"), youtube.getTranscript("x")]);';
    expect(describeActivity(activity(source), false).title).toBe("Reading YouTube");
    expect(describeActivity(activity(source, true), false).title).toBe("Read YouTube");
    expect(describeActivity(activity(source, false), false)).toMatchObject({ title: "Couldn't read YouTube", status: "error" });
  });

  it("keeps page labels for page snapshots", () => {
    const source = 'const page = browser.tab("/tabs/12/page.md"); page.snapshot();';
    expect(describeActivity(activity(source), false).title).toBe("Reading page content");
    expect(describeActivity(activity(source, true), false).title).toBe("Read page content");
    expect(describeActivity(activity(source, false), false).title).toBe("Couldn't read page content");
  });
});
