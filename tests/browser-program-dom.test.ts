// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { BrowserProgram, WorkspaceState } from "@/lib/background/browser-program";
import { TabController } from "@/lib/background/tab-controller";
import { createElementRefRegistry, executeDomCall, extractSnapshot } from "@/lib/tools/page-executor";
import type { PageRequest } from "@/lib/protocol";

it("fills the real fixture in one program and submits it in a later program", async () => {
  document.documentElement.innerHTML = readFileSync("tests/fixtures/agent-page.html", "utf8");
  const registry = createElementRefRegistry();
  const controller = new TabController({ tabs: {
    query: async () => [{ id: 1, url: "http://127.0.0.1:4173/agent-page.html" }],
    update: vi.fn(), goBack: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: async (_id, raw) => {
      const request = raw as PageRequest;
      if (request.type === "page.snapshot") return { ok: true, type: "page.snapshot", snapshot: extractSnapshot(document, 1, registry, request.mode, undefined, request.locator) };
      if (request.type !== "page.execute") throw new Error("Unexpected request");
      const result = executeDomCall(document, registry, request.call);
      return { ok: true, type: "page.execute", result, snapshot: extractSnapshot(document, 1, registry, "interactive") };
    },
  } });
  const program = new BrowserProgram(controller, new WorkspaceState(), () => {});
  const signal = new AbortController().signal;
  const prepared = await program.execute(`
    const page = browser.tab("/tabs/1/page.md");
    await page.getByRole("textbox", {name: "Email", exact: true}).fill("fixture@example.com");
    await page.getByRole("combobox", {name: "Priority", exact: true}).selectOption(["high"]);
    await page.getByRole("checkbox", {name: "Notify me", exact: true}).setChecked(true);
    return await page.snapshot("interactive");
  `, signal);
  expect(prepared.ok, prepared.summary).toBe(true);
  expect(document.querySelector<HTMLInputElement>("#email")!.value).toBe("fixture@example.com");
  expect(document.querySelector<HTMLSelectElement>("#priority")!.value).toBe("high");
  expect(document.querySelector<HTMLInputElement>("#notify")!.checked).toBe(true);
  const submit = vi.fn((event: Event) => event.preventDefault());
  document.querySelector("form")!.addEventListener("submit", submit);
  expect((await program.execute('await page.getByRole("button", {name: "Submit", exact: true}).click();', signal)).ok).toBe(true);
  expect(submit).toHaveBeenCalledOnce();
  document.body.insertAdjacentHTML("beforeend", '<button>Noise</button>'.repeat(350));
  expect((await program.execute('await page.getByRole("button", {name: "Submit", exact: true}).click();', signal)).ok).toBe(true);
  expect(submit).toHaveBeenCalledTimes(2);
  document.body.insertAdjacentHTML("beforeend", '<button>Submit</button>');
  expect((await program.execute('await page.getByRole("button", {name: "Submit", exact: true}).click();', signal)).ok).toBe(false);
  expect(submit).toHaveBeenCalledTimes(2);
});
