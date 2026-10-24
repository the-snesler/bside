// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { buildOutline, createElementRefRegistry, executeDomAction, extractTable, type ElementRefRegistry } from "@/lib/tools/page-executor";
import { TABLE_LIMITS, type ElementTarget } from "@/lib/domain/tools";

const instant = async () => {};

function outline(registry: ElementRefRegistry, refPrefix = ""): string {
  return buildOutline(document, registry, { refPrefix }).lines.join("\n");
}

function ref(name: string, documentId = "doc"): ElementTarget {
  return { kind: "ref", ref: name, documentId };
}

function read(registry: ElementRefRegistry, target: ElementTarget, offset = 0, limit: number = TABLE_LIMITS.defaultRows, refPrefix = "") {
  return extractTable(document, registry, target, { offset, limit }, { refPrefix });
}

const COHORTS = `
  <h2>Retention</h2>
  <table>
    <caption>Cohort retention</caption>
    <thead>
      <tr><th rowspan="2">Cohort</th><th colspan="2">Week 1</th><th colspan="2">Week 2</th></tr>
      <tr><th>Users</th><th>%</th><th>Users</th><th>%</th></tr>
    </thead>
    <tbody>
      <tr><th scope="row"><a href="/c/jan">Jan</a></th><td>100</td><td>50%</td><td>80</td><td>40%</td></tr>
      <tr><th scope="row">Feb</th><td rowspan="2">n/a</td><td>45%</td><td colspan="2">pending</td></tr>
      <tr><th scope="row">Mar</th><td>30%</td><td>10</td><td>5%</td></tr>
      <tr style="display:none"><th scope="row">Filtered</th><td>0</td><td>0%</td><td>0</td><td>0%</td></tr>
    </tbody>
  </table>`;

describe("table extraction", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("hints data tables in the outline with a ref and their size", () => {
    document.body.innerHTML = COHORTS;
    const registry = createElementRefRegistry("doc");
    expect(outline(registry)).toContain('## Retention\n[table e1 "Cohort retention" 3 rows × 5 cols]\nCohort retention\n| Cohort | Week 1 | Week 2');
  });

  it("flattens multi-row headers and expands row and column spans, skipping hidden rows", () => {
    document.body.innerHTML = COHORTS;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    expect(read(registry, ref("e1"))).toEqual({
      ok: true,
      table: {
        documentId: "doc", url: expect.any(String), ref: "e1", role: "table", caption: "Cohort retention",
        headers: ["Cohort", "Week 1 / Users", "Week 1 / %", "Week 2 / Users", "Week 2 / %"],
        rows: [
          ["Jan [e2 link]", "100", "50%", "80", "40%"],
          ["Feb", "n/a", "45%", "pending", "pending"],
          ["Mar", "n/a", "30%", "10", "5%"],
        ],
        totalRows: 3, offset: 0, nextOffset: null,
      },
    });
  });

  it("takes leading all-header rows as headers when there is no thead, and a row header column stays data", () => {
    document.body.innerHTML = `<table>
      <tr><th></th><th>Price</th></tr>
      <tr><th>Basic</th><td>$5</td></tr>
      <tr><th>Pro</th><td>$9</td></tr></table>`;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    expect(read(registry, ref("e1"))).toMatchObject({ ok: true, table: { headers: ["", "Price"], rows: [["Basic", "$5"], ["Pro", "$9"]], totalRows: 2 } });
  });

  it("reads ARIA grids, their row headers and the controls in cells, and notes rows a virtualized grid has not rendered", () => {
    document.body.innerHTML = `
      <div role="grid" aria-label="Orders" aria-rowcount="100">
        <div role="row"><span role="columnheader">Order</span><span role="columnheader">Status</span></div>
        <div role="rowgroup">
          <div role="row"><span role="rowheader">#1</span><div><span role="gridcell">Shipped</span></div></div>
          <div role="row"><span role="rowheader">#2</span><span role="gridcell"><button>Track</button></span></div>
        </div>
      </div>`;
    const registry = createElementRefRegistry("doc");
    expect(outline(registry)).toContain('[grid e1 "Orders" 2 rows × 2 cols]');
    const result = read(registry, ref("e1"));
    expect(result).toMatchObject({
      ok: true,
      table: { role: "grid", caption: "Orders", headers: ["Order", "Status"], rows: [["#1", "Shipped"], ["#2", "Track [e2 button]"]], totalRows: 2 },
    });
    expect(result.ok && result.table.note).toContain("reports 100 rows, but only 3 are on the page");
  });

  it("finds a table by role and name, and refuses targets that are not tables", () => {
    document.body.innerHTML = `${COHORTS}<button>Export</button>`;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    expect(read(registry, { kind: "role", role: "table", name: "cohort", exact: false })).toMatchObject({ ok: true, table: { ref: "e1" } });
    expect(read(registry, ref("e3"))).toMatchObject({ ok: false, result: { code: "NOT_INTERACTABLE", summary: expect.stringContaining("is not a table") } });
    expect(read(registry, ref("e1", "old"))).toMatchObject({ ok: false, result: { code: "STALE_SNAPSHOT" } });
  });

  it("refuses to operate a table and points to page.table", async () => {
    document.body.innerHTML = COHORTS;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    expect(await executeDomAction(document, registry, { kind: "click", target: ref("e1") }, instant)).toMatchObject({
      ok: false, code: "NOT_INTERACTABLE", summary: expect.stringContaining('read it with page.table("e1")'),
    });
  });

  it("pages through long tables within the row and character bounds", () => {
    const rows = Array.from({ length: 260 }, (_, index) => `<tr><td>${index + 1}</td><td>${index === 0 ? "x".repeat(1_000) : `row ${index + 1}`}</td></tr>`).join("");
    document.body.innerHTML = `<table><thead><tr><th>#</th><th>Name</th></tr></thead><tbody>${rows}</tbody></table>`;
    const registry = createElementRefRegistry("doc");
    expect(outline(registry)).toContain("[table e1 260 rows × 2 cols]");
    const first = read(registry, ref("e1"));
    expect(first).toMatchObject({ ok: true, table: { totalRows: 260, offset: 0, nextOffset: 50 } });
    expect(first.ok && first.table.rows).toHaveLength(50);
    expect(first.ok && first.table.rows[0]![1]!.length).toBeLessThanOrEqual(TABLE_LIMITS.cellChars);
    const capped = read(registry, ref("e1"), 50, 500);
    expect(capped.ok && capped.table.rows).toHaveLength(TABLE_LIMITS.maxRows);
    expect(capped).toMatchObject({ ok: true, table: { offset: 50, nextOffset: 250 } });
    const last = read(registry, ref("e1"), 250, 50);
    expect(last).toMatchObject({ ok: true, table: { offset: 250, nextOffset: null, rows: expect.arrayContaining([["260", "row 260"]]) } });
    expect(last.ok && last.table.rows).toHaveLength(10);
  });

  it("stops a page at the character budget on a whole row", () => {
    const wide = Array.from({ length: 20 }, () => `<td>${"y".repeat(290)}</td>`).join("");
    document.body.innerHTML = `<table><tr><th>A</th></tr>${Array.from({ length: 30 }, () => `<tr>${wide}</tr>`).join("")}</table>`;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    const result = read(registry, ref("e1"), 0, 30);
    expect(result.ok && result.table.rows.length).toBeLessThan(30);
    expect(result.ok && result.table.nextOffset).toBe(result.ok ? result.table.rows.length : -1);
  });

  it("cuts columns past the limit and says so", () => {
    const cells = Array.from({ length: 60 }, (_, index) => `<td>${index}</td>`).join("");
    document.body.innerHTML = `<table><tr>${cells}</tr><tr>${cells}</tr></table>`;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    const result = read(registry, ref("e1"));
    expect(result.ok && result.table.rows[0]).toHaveLength(TABLE_LIMITS.maxColumns);
    expect(result.ok && result.table.note).toContain(`first ${TABLE_LIMITS.maxColumns} columns`);
  });

  it("leaves layout tables without a ref", () => {
    document.body.innerHTML = '<table><tr><td><table><tr><td>Inner</td></tr></table></td><td>Side</td></tr><tr><td>A</td><td>B</td></tr></table><table role="presentation"><tr><th>X</th></tr></table>';
    expect(outline(createElementRefRegistry("doc"))).not.toMatch(/\[table e/);
  });

  it("labels a frame's tables and cell refs with the frame's prefix", () => {
    document.body.innerHTML = COHORTS;
    const registry = createElementRefRegistry("frame-doc");
    expect(outline(registry, "f3:")).toContain('[table f3:e1 "Cohort retention" 3 rows × 5 cols]');
    expect(read(registry, ref("e1", "frame-doc"), 0, 1, "f3:")).toMatchObject({ ok: true, table: { ref: "f3:e1", rows: [["Jan [f3:e2 link]", "100", "50%", "80", "40%"]], nextOffset: 1 } });
  });
});
