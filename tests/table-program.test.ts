// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { FrameAliases, TabController } from "@/lib/background/tab-controller";
import { createFramedTab } from "./helpers/framed-tab";

const TOP = "https://stats.example/cohorts";
const WIDGET = "https://widget.example/grid";

const RANKS = `<h1>Cohorts</h1>
  <table><caption>2025 cohort</caption>
    <thead><tr><th>Rank</th><th>School</th></tr></thead>
    <tbody>${Array.from({ length: 70 }, (_, index) => `<tr><td>${index + 1}</td><td>School ${index + 1}</td></tr>`).join("")}</tbody>
  </table>
  <iframe title="Widget" data-frame-id="5" data-src="${WIDGET}"></iframe>`;

function setup() {
  const tab = createFramedTab([
    { frameId: 0, url: TOP, title: "Cohorts", html: RANKS },
    { frameId: 5, url: WIDGET, html: '<div role="grid" aria-label="Prices"><div role="row"><span role="columnheader">Plan</span><span role="columnheader">Price</span></div><div role="row"><span role="gridcell"><a href="/basic">Basic</a></span><span role="gridcell">$5</span></div></div>' },
  ]);
  const controller = new TabController(tab.api, undefined, new FrameAliases());
  const state = new WorkspaceState();
  const onEffect = vi.fn();
  const program = new BrowserProgram(controller, { state, runId: "r1", sessionId: "s1", files: new ScratchFiles() }, onEffect);
  const signal = new AbortController().signal;
  const run = (source: string) => program.execute(`const page = browser.tab("/tabs/1/page.md");\n${source}`, signal);
  return { tab, state, program, onEffect, run };
}

describe("page.table in browser programs", () => {
  it("lists tables in the snapshot and returns a page of rows as plain JSON, without counting as a page effect", async () => {
    const { run, program, onEffect } = setup();
    const read = await run("return await page.snapshot();");
    expect(read.summary).toContain('[table e1 "2025 cohort" 70 rows × 2 cols]');
    expect(read.summary).toContain('[grid f1:e1 "Prices" 1 row × 2 cols]');

    const first = await run('const t = await page.table("e1"); return [t.caption, t.headers, t.rows.length, t.rows[0], t.totalRows, t.nextOffset];');
    expect(first.ok, first.summary).toBe(true);
    expect(JSON.parse(first.summary)).toEqual(["2025 cohort", ["Rank", "School"], 50, ["1", "School 1"], 70, 50]);
    const next = await run('const more = await page.ref("e1").table({offset: 50, limit: 100}); return [more.offset, more.rows.length, more.rows[19], more.nextOffset];');
    expect(JSON.parse(next.summary)).toEqual([50, 20, ["70", "School 70"], null]);
    const byRole = await run('const one = await page.getByRole("table", {name: "2025"}).table({limit: 1}); return one.rows;');
    expect(JSON.parse(byRole.summary)).toEqual([["1", "School 1"]]);
    expect(onEffect).not.toHaveBeenCalled();
    expect(program.tainted).toBe(true);
    expect(first.data).toMatchObject({ visited: [TOP] });
  });

  it("reads a frame's grid through that frame, with its refs carrying the frame's name", async () => {
    const { run, tab } = setup();
    await run("await page.snapshot();");
    const grid = await run('return await page.table("f1:e1");');
    expect(grid.ok, grid.summary).toBe(true);
    expect(JSON.parse(grid.summary)).toMatchObject({ ref: "f1:e1", role: "grid", caption: "Prices", headers: ["Plan", "Price"], rows: [["Basic [f1:e2 link]", "$5"]] });
    expect(tab.requestsTo(5).at(-1)).toMatchObject({ type: "page.table", frameId: 5, refPrefix: "f1:", target: { kind: "ref", ref: "e1", documentId: "doc-5" }, offset: 0, limit: 50 });
    // The cell's ref is usable right away.
    const clicked = await run('return await page.ref("f1:e2").click();');
    expect(clicked.ok, clicked.summary).toBe(true);
  });

  it("refuses refs not read from the current document, refs that are not tables, and bad options", async () => {
    const { run, tab } = setup();
    expect(await run('return await page.table("e1");')).toMatchObject({ ok: false, code: "STALE_SNAPSHOT", summary: expect.stringContaining("no outline of the current page has been read") });
    await run("await page.snapshot();");
    tab.navigateFrame({ frameId: 0, url: TOP, html: RANKS }, "doc-0b");
    expect(await run('return await page.table("e1");')).toMatchObject({ ok: false, code: "STALE_SNAPSHOT", summary: expect.stringContaining("came from an earlier page load") });
    await run("await page.snapshot();");
    tab.frames.get(0)!.document.body.insertAdjacentHTML("beforeend", "<button>Export</button>");
    await run("await page.snapshot();");
    expect(await run('return await page.table("e2");')).toMatchObject({ ok: false, code: "NOT_INTERACTABLE", summary: expect.stringContaining("is not a table") });
    expect(await run('return await page.ref("e1").click();')).toMatchObject({ ok: false, summary: expect.stringContaining('read it with page.table("e1")') });
    expect((await run('return await page.table("e1", {limit: 500});')).summary).toContain("limit must be 1–200");
    expect((await run('return await page.table("e1", {rows: 5});')).summary).toContain("Unsupported table option rows");
    expect((await run('return await page.table("table");')).summary).toContain("Invalid ref");
  });
});
