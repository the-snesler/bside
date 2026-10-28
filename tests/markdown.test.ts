// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
// KaTeX disables rendering in quirks mode when it loads; extension pages have a
// doctype, but happy-dom has no `compatMode`.
vi.hoisted(() => { Object.defineProperty(document, "compatMode", { value: "CSS1Compat", configurable: true }); });
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Markdown, workspaceImagePath, type MarkdownImages } from "@/lib/ui/Markdown";
import { normalizeMathDelimiters } from "@/lib/ui/markdown-math";
import { isSidebarCommand } from "@/lib/protocol";

const MATHML = "http://www.w3.org/1998/Math/MathML";
let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; });

async function mount(text: string, images?: MarkdownImages) {
  root = document.createElement("div");
  document.body.append(root);
  await act(async () => { render(h(Markdown, { text, images }), root); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return root;
}

describe("math delimiters", () => {
  it("rewrites \\( \\) and \\[ \\] outside code only", () => {
    expect(normalizeMathDelimiters("CTR \\(12/22\\approx54.5\\%\\).")).toBe("CTR $$12/22\\approx54.5\\%$$.");
    expect(normalizeMathDelimiters("\\[\nx = 1\n\\]")).toBe("$$\nx = 1\n$$");
    expect(normalizeMathDelimiters("- \\[x^2\\]")).toBe("- $$x^2$$");
    expect(normalizeMathDelimiters("`\\(a\\)` and \\(b\\)")).toBe("`\\(a\\)` and $$b$$");
    expect(normalizeMathDelimiters("```\n\\(a\\)\n```\n\\(b\\)")).toBe("```\n\\(a\\)\n```\n$$b$$");
    expect(normalizeMathDelimiters("open \\( only")).toBe("open \\( only");
    expect(normalizeMathDelimiters("\\\\(not math\\\\)")).toBe("\\\\(not math\\\\)");
  });
});

describe("Markdown", () => {
  it("renders inline math in a table cell as MathML", async () => {
    const page = await mount("| Q | Note |\n|---|---|\n| 8 | Correct: \\(16/(16+4)=0.8=4/5\\). |");
    const math = page.querySelector("td math");
    expect(math?.namespaceURI).toBe(MATHML);
    expect(math?.querySelector("mfrac, mo")?.namespaceURI).toBe(MATHML);
    expect(math?.closest("td")?.textContent).toContain("Correct:");
  });

  it("renders display math as a scrollable block, not a code block", async () => {
    const page = await mount("\\[\n\\sum_{i=1}^n i\n\\]");
    expect(page.querySelector("pre")).toBeNull();
    expect(page.querySelector(".markdown__math math")?.getAttribute("display")).toBe("block");
  });

  it("leaves prices and code alone", async () => {
    const page = await mount("It costs $12 and $15.\n\n`\\(x\\)`\n\n```\n$$y$$\n```");
    expect(page.querySelector("math")).toBeNull();
    expect(page.querySelector("p")?.textContent).toBe("It costs $12 and $15.");
    expect(page.querySelector("p code")?.textContent).toBe("\\(x\\)");
    expect(page.querySelector("pre code")?.textContent).toBe("$$y$$\n");
  });

  it("does not turn TeX links or images into elements", async () => {
    const page = await mount("\\(\\href{https://evil.example}{x}\\) \\(\\includegraphics{https://evil.example/a.png}\\) \\(\\htmlClass{x}{y}\\)");
    expect(page.querySelector("a, img, [href]")).toBeNull();
  });

  it("shows the session's workspace images and nothing remote", async () => {
    const load = vi.fn(async (_sessionId: string, path: string) =>
      path === "/workspace/a.png" ? { ok: true as const, mimeType: "image/png", data: "iVBORw0KGgo=" } : { ok: false as const, reason: "missing" as const });
    const page = await mount("![Shot](sandbox:/workspace/a.png) ![Gone](/workspace/b.png) ![Remote](https://example.com/x.png) ![Doc](/workspace/doc.pdf)", { sessionId: "s1", load });
    expect(load.mock.calls).toEqual([["s1", "/workspace/a.png"], ["s1", "/workspace/b.png"]]);
    const images = page.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(images[0]!.getAttribute("alt")).toBe("Shot");
    expect(page.textContent).toContain("[Image: Gone — /workspace/b.png no longer exists]");
    expect(page.textContent).toContain("[Image: Remote]");
    expect(page.textContent).toContain("[Image: Doc]");
  });

  it("keeps placeholders without an image source", async () => {
    const page = await mount("![Shot](/workspace/a.png)");
    expect(page.querySelector("img")).toBeNull();
    expect(page.textContent).toBe("[Image: Shot]");
  });
});

describe("workspace image references", () => {
  it("normalizes the forms models write and refuses the rest", () => {
    expect(workspaceImagePath("/workspace/a.png")).toBe("/workspace/a.png");
    expect(workspaceImagePath("sandbox:/workspace/shots/a.JPG")).toBe("/workspace/shots/a.JPG");
    expect(workspaceImagePath("workspace:a.webp")).toBe("/workspace/a.webp");
    expect(workspaceImagePath("workspace:/workspace/a.gif")).toBe("/workspace/a.gif");
    for (const url of ["/workspace/a.pdf", "/workspace/a.md", "/workspace/../a.png", "https://x.example/a.png", "data:image/png;base64,AA", "/tmp/a.png"]) {
      expect(workspaceImagePath(url)).toBeNull();
    }
  });

  it("validates the sidebar's workspace.image command", () => {
    const command = (path: unknown, sessionId: unknown = "s1") => isSidebarCommand({ v: 1, id: "r", type: "workspace.image", sessionId, path });
    expect(command("/workspace/a.png")).toBe(true);
    expect(command("/workspace/a.pdf")).toBe(false);
    expect(command("/workspace/a.txt")).toBe(false);
    expect(command("/workspace/../a.png")).toBe(false);
    expect(command("/workspace/a.png", "")).toBe(false);
    expect(command(42)).toBe(false);
  });
});
