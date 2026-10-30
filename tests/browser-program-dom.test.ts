// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { TabController } from "@/lib/background/tab-controller";
import { createElementRefRegistry, executeDomAction, extractSnapshot, findInPage } from "@/lib/tools/page-executor";
import type { PageRequest } from "@/lib/protocol";

it("fills the real fixture by ref and role in one program and verifies a later submission from its diff", async () => {
  document.documentElement.innerHTML = readFileSync("tests/fixtures/agent-page.html", "utf8");
  // innerHTML does not run the fixture's script; install the equivalent submit handler.
  document.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    document.getElementById("output")!.textContent = `Submitted: ${value("email")} · ${value("priority")} · ${(document.getElementById("notify") as HTMLInputElement).checked ? "notify" : "silent"}`;
  });
  const registry = createElementRefRegistry("fixture-doc");
  const controller = new TabController({ tabs: {
    query: async () => [{ id: 1, url: "http://127.0.0.1:4173/agent-page.html" }],
    update: vi.fn(), goBack: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: async (_id, raw) => {
      const request = raw as PageRequest;
      if (request.type === "page.snapshot") return { ok: true, type: "page.snapshot", snapshot: extractSnapshot(document, 1, registry, request) };
      if (request.type === "page.find") return { ok: true, type: "page.find", result: findInPage(document, registry, request.query) };
      if (request.type !== "page.execute") throw new Error("Unexpected request");
      const result = await executeDomAction(document, registry, request.action, async () => {});
      return { ok: true, type: "page.execute", result, documentId: registry.documentId };
    },
  } });
  const program = new BrowserProgram(controller, { state: new WorkspaceState(), runId: "r1", sessionId: "s1", files: new ScratchFiles() }, () => {});
  const signal = new AbortController().signal;

  const read = await program.execute('const page = browser.tab("/tabs/1/page.md"); return await page.snapshot();', signal);
  expect(read.summary).toContain('[e1 textbox "Email" type=email]');
  expect(read.summary).toContain('[e2 combobox "Priority" selected="Low" options: Low (low) | High (high)]');
  expect(read.summary).toContain('[e3 checkbox "Notify me"]');

  const prepared = await program.execute(`
    await page.ref("e1").fill("fixture@example.com");
    await page.getByRole("combobox", {name: "Priority"}).selectOption("High");
    await page.getByRole("checkbox", {name: "Notify me"}).check();
  `, signal);
  expect(prepared.ok, prepared.summary).toBe(true);
  expect(prepared.summary).toContain('+ Email [e1 textbox "Email" type=email value="fixture@example.com"]');
  expect(prepared.summary).toContain('Selected "High" in [e2 combobox "Priority"].');
  expect(document.querySelector<HTMLInputElement>("#email")!.value).toBe("fixture@example.com");
  expect(document.querySelector<HTMLSelectElement>("#priority")!.value).toBe("high");
  expect(document.querySelector<HTMLInputElement>("#notify")!.checked).toBe(true);

  const submitted = await program.execute('return await page.getByRole("button", {name: "Submit"}).click();', signal);
  expect(submitted.ok, submitted.summary).toBe(true);
  expect(submitted.summary).toContain("+ Submitted: fixture@example.com · high · notify");

  document.body.insertAdjacentHTML("beforeend", "<button>Submit</button>");
  const ambiguous = await program.execute('await page.getByRole("button", {name: "Submit", exact: true}).click();', signal);
  expect(ambiguous.ok).toBe(false);
  expect(ambiguous.summary).toContain('[e4 button "Submit"]; [e');
});
