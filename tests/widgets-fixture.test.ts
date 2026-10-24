// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { TabController } from "@/lib/background/tab-controller";
import { createElementRefRegistry, executeDomAction, extractSnapshot, extractTable, findInPage, settleDom } from "@/lib/tools/page-executor";
import type { PageRequest } from "@/lib/protocol";

/** Loads the fixture and runs its own script, as the page would. */
function loadFixture(): void {
  const html = readFileSync("tests/fixtures/widgets-page.html", "utf8");
  document.documentElement.innerHTML = html;
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  new Function(script)();
}

it("reads the fixture's table and grid and operates its hover menu, sortable list, combobox, date picker, and Ctrl+Enter note", async () => {
  loadFixture();
  const registry = createElementRefRegistry("widgets-doc");
  const controller = new TabController({ tabs: {
    query: async () => [{ id: 1, url: "http://127.0.0.1:4173/widgets-page.html" }],
    update: vi.fn(), goBack: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: async (_id, raw) => {
      const request = raw as PageRequest;
      if (request.type === "page.snapshot") return { ok: true, type: "page.snapshot", snapshot: extractSnapshot(document, 1, registry, request), frames: 0 };
      if (request.type === "page.find") return { ok: true, type: "page.find", result: findInPage(document, registry, request.query), frames: 0 };
      if (request.type === "page.table") {
        const read = extractTable(document, registry, request.target, request);
        return read.ok ? { ok: true, type: "page.table", table: read.table } : { ok: false, error: { code: "NOT_INTERACTABLE", message: read.result.summary, retryable: false, phase: "page" } };
      }
      if (request.type !== "page.execute") throw new Error(`Unexpected request ${request.type}`);
      const result = await executeDomAction(document, registry, request.action, settleDom);
      return { ok: true, type: "page.execute", result, documentId: registry.documentId };
    },
  } });
  const program = new BrowserProgram(controller, { state: new WorkspaceState(), sessionId: "s1", files: new ScratchFiles() }, () => {});
  const signal = new AbortController().signal;
  const run = async (source: string) => {
    const result = await program.execute(`const page = browser.tab("/tabs/1/page.md");\n${source}`, signal);
    expect(result.ok, result.summary).toBe(true);
    return result.summary;
  };

  const read = await run("return await page.snapshot();");
  expect(read).toMatch(/\[table e\d+ "Weekly retention, 2026 cohorts" 4 rows × 5 cols\]/);
  expect(read).toMatch(/\[grid e\d+ "Orders" 2 rows × 3 cols\]/);
  expect(read).toMatch(/\[e\d+ draggable "Write docs"\]/);
  expect(read).toMatch(/\[e\d+ combobox "Country" collapsed\]/);

  const cohorts = JSON.parse(await run('return await page.getByRole("table", {name: "Weekly retention"}).table();'));
  expect(cohorts).toMatchObject({
    caption: "Weekly retention, 2026 cohorts",
    headers: ["Cohort", "Week 1 / Users", "Week 1 / Retained", "Week 4 / Users", "Week 4 / Retained"],
    rows: [
      ["January", "1,200", "48%", "610", "24%"],
      ["February", "980", "51%", "not yet measured", "not yet measured"],
      ["March", "980", "45%", "402", "21%"],
      ["All", "3,160", "48%", "1,012", "23%"],
    ],
    totalRows: 4, nextOffset: null,
  });
  const orders = JSON.parse(await run('return await page.getByRole("grid", {name: "Orders"}).table();'));
  expect(orders.headers).toEqual(["Order", "Status", "Action"]);
  expect(orders.rows[1]).toEqual(["#1002", "Processing", expect.stringMatching(/^Cancel #1002 \[e\d+ button\]$/)]);

  const hovered = await run('return await page.getByRole("link", {name: "Products"}).hover();');
  expect(hovered).toMatch(/\+ - \[e\d+ link "Analytics" → \/#analytics\]/);
  await run('await page.getByRole("link", {name: "Analytics"}).hover();');
  expect(document.getElementById("products-menu")!.hidden).toBe(false);

  const dragged = await run('return await page.getByRole("draggable", {name: "Write docs"}).dragTo(page.getByRole("draggable", {name: "Ship tables"}));');
  expect(dragged).toContain("(HTML drag and drop)");
  expect(dragged).toContain("Page outline reordered");
  expect(Array.from(document.querySelectorAll("#priorities li"), (item) => item.textContent)).toEqual(["Write docs", "Ship tables", "Fix flaky test"]);

  const chose = await run('return await page.getByRole("combobox", {name: "Country"}).choose("Can");');
  expect(chose).toContain('Chose "Canada" in');
  expect(chose).toContain("Country: Canada");

  const dated = await run('return await page.getByRole("textbox", {name: "Ship date"}).fill("11/03/2026", {commit: true});');
  expect(dated).toContain('it shows "Nov 3, 2026" (the field reformatted it)');

  const saved = await run('const note = page.getByRole("textbox", {name: "Note"}); await note.fill("Ready"); return await note.press("Control+Enter");');
  expect(saved).toContain("Note saved: Ready");
}, 20_000);
