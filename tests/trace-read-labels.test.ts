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

  it("labels a user tab another chat holds as such, not as a failure", () => {
    const refused: Activity = { ...activity('fs.read("/tabs/12/page.md");'), endedAt: 1,
      result: { ok: false, code: "TAB_IN_USE", summary: "0 statements completed. /tabs/12/page.md: Another bside chat is using this tab." } };
    expect(describeActivity(refused, false)).toEqual({ Icon: expect.anything(), title: "Another bside chat is using that tab" });
  });

  it("labels YouTube site calls", () => {
    const source = 'const both = await Promise.all([youtube.getMetadata("x"), youtube.getTranscript("x")]);';
    expect(describeActivity(activity(source), false).title).toBe("Reading YouTube");
    expect(describeActivity(activity(source, true), false).title).toBe("Read YouTube");
    expect(describeActivity(activity(source, false), false)).toMatchObject({ title: "Couldn't read YouTube", status: "error" });
  });

  it("labels screenshots and viewed images by their call, without any image", () => {
    const shot = 'const page = browser.tab("/agent-tabs/3/page.md"); await page.snapshot(); await page.ref("e4").screenshot({save: "/workspace/chart.png"});';
    expect(describeActivity(activity(shot), false)).toMatchObject({ title: "Taking a screenshot", status: "running" });
    expect(describeActivity(activity(shot, true), false).title).toBe("Took a screenshot");
    expect(describeActivity(activity(shot, false), false)).toMatchObject({ title: "Couldn't take a screenshot", status: "error" });
    expect(describeActivity(activity('await fs.view("/workspace/chart.png");', true), false).title).toBe("Looked at an image");
    // An effect in the same program still names the step.
    expect(describeActivity(activity('await page.ref("e1").click(); await page.screenshot();', true), false).title).toBe("Clicked a page control");
  });

  it("keeps page labels for page snapshots", () => {
    const source = 'const page = browser.tab("/tabs/12/page.md"); page.snapshot();';
    expect(describeActivity(activity(source), false).title).toBe("Reading page content");
    expect(describeActivity(activity(source, true), false).title).toBe("Read page content");
    expect(describeActivity(activity(source, false), false).title).toBe("Couldn't read page content");
  });

  it("labels the time tool and calls skipped after an earlier failure", () => {
    const time: Activity = { kind: "activity", id: "time", startedAt: 0, endedAt: null, call: { id: "time", name: "current_time", arguments: {} }, result: null };
    expect(describeActivity(time, false)).toMatchObject({ title: "Checking the time", status: "running" });
    expect(describeActivity({ ...time, result: { ok: true, summary: "Local time: …" } }, false).title).toBe("Checked the time");
    const skipped = describeActivity({ ...activity("page.ref(\"e1\").click();"), result: { ok: false, code: "SKIPPED", summary: "Not run." } }, false);
    expect(skipped).toMatchObject({ title: "Skipped clicking a page control" });
    expect(skipped.status).toBeUndefined();
  });

  it("labels table reads", () => {
    const source = 'const page = browser.tab("/tabs/1/page.md"); await page.snapshot(); const t = await page.table("e4", {offset: 50});';
    expect(describeActivity(activity(source), false).title).toBe("Reading a table");
    expect(describeActivity(activity(source, true), false).title).toBe("Read a table");
    expect(describeActivity(activity(source, false), false)).toMatchObject({ title: "Couldn't read a table", status: "error" });
  });

  it("labels hovering, and a click after a hover as clicking", () => {
    expect(describeActivity(activity('await page.ref("e4").hover();', true), false).title).toBe("Hovered over a page control");
    expect(describeActivity(activity('await page.ref("e4").hover(); await page.ref("e9").click();', true), false).title).toBe("Clicked a page control");
  });

  it("labels drags", () => {
    expect(describeActivity(activity('await page.ref("e4").dragTo(page.ref("e9"));'), false).title).toBe("Dragging a page item");
    expect(describeActivity(activity('await page.ref("e4").dragTo("e9");', false), false)).toMatchObject({ title: "Couldn't drag a page item", status: "error" });
  });

  it("labels combobox choices like option selection", () => {
    expect(describeActivity(activity('await page.getByRole("combobox", {name: "Country"}).choose("Canada");', true), false).title).toBe("Selected an option");
  });
});
