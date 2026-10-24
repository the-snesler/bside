// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { ProblemReport } from "@/lib/ui/settings/ProblemReport";

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("problem report download", () => {
  it("requires deliberate preparation/download and exports the selected session locally", async () => {
    let exported: Blob | null = null;
    const create = vi.fn((blob: Blob) => { exported = blob; return "blob:local-report"; });
    vi.stubGlobal("URL", class extends URL { static override createObjectURL = create; static override revokeObjectURL = vi.fn(); });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("bside-problem-report.json");
      expect(this.href).toBe("blob:local-report");
    });
    const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
      const request = message as { id: string; type: string; sessionId?: string };
      if (request.type === "problemReport.list") return { v: 1, id: request.id, ok: true, type: request.type,
        sessions: [{ id: "alpha", title: "Private title A" }, { id: "beta", title: "Private title B" }] };
      expect(request).toMatchObject({ type: "problemReport.export", sessionId: "beta" });
      return { v: 1, id: request.id, ok: true, type: request.type, filename: "bside-problem-report.json", json: '{"contentIncluded":false}' };
    });
    root = document.createElement("div"); document.body.append(root);
    await act(async () => render(h(ProblemReport, {}), root));
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    const button = (label: string) => [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
    await act(async () => { button("Prepare report").click(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(root.querySelector("select")).not.toBeNull());
    const select = root.querySelector("select")!;
    expect(root.querySelector('label[for="problem-chat"]')?.textContent).toBe("Chat to diagnose");
    await act(async () => { select.value = "beta"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { button("Download redacted report").click(); });
    await vi.waitFor(() => expect(clicked).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledTimes(2);
    expect(clicked).toHaveBeenCalledOnce();
    expect(exported).not.toBeNull();
    expect(await exported!.text()).toBe('{"contentIncluded":false}');
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Nothing was sent");
  });
});
