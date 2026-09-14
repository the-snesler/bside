// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Markdown } from "@/lib/ui/Markdown";
import { serializeDraft } from "@/lib/ui/Composer";
import { useBottomScroll } from "@/lib/ui/use-bottom-scroll";
import { isSidebarCommand } from "@/lib/protocol";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("sidebar UI contracts", () => {
  it("renders Markdown without executable HTML, unsafe links, or remote image requests", () => {
    const root = document.createElement("div");
    document.body.append(root);
    render(
      h(Markdown, {
        text: "**Bold**\n\n1. First\n\n[Good](https://example.com) [Bad](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)>\n\n![tracking](https://example.com/pixel.png)",
      }),
      root,
    );
    expect(root.querySelector("strong")?.textContent).toBe("Bold");
    expect(root.querySelector("ol li")?.textContent).toBe("First");
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("a")?.rel).toBe("noopener noreferrer");
    expect(root.querySelectorAll("img,script")).toHaveLength(0);
    render(null, root);
  });

  it("serializes mentions with actual tab identity and VFS path", () => {
    expect(
      serializeDraft([
        {
          type: "paragraph",
          children: [
            { text: "Read " },
            {
              type: "mention",
              tab: {
                id: 42,
                title: "Example",
                url: "https://example.com/",
                path: "/agent-tabs/42/page.md",
              },
              children: [{ text: "" }],
            },
          ],
        },
      ]),
    ).toBe(
      "Read @Example (tab 42, /agent-tabs/42/page.md, https://example.com/)",
    );
  });

  it("validates inline model settings and keeps credential commands off the sidebar", () => {
    const command = {
      v: 1,
      id: "s",
      type: "settings.save",
      settings: {
        version: 1,
        providerId: "openai",
        modelId: "gpt-5.6-terra",
        reasoningEffort: "medium",
      },
    };
    expect(isSidebarCommand(command)).toBe(true);
    expect(
      isSidebarCommand({
        ...command,
        settings: { ...command.settings, reasoningEffort: "bogus" },
      }),
    ).toBe(false);
    expect(
      isSidebarCommand({
        ...command,
        settings: { ...command.settings, apiKey: "secret" },
      }),
    ).toBe(false);
    expect(
      isSidebarCommand({ v: 1, id: "c", type: "credentials.openai.status" }),
    ).toBe(false);
  });

  it("follows content growth only while pinned, and resumes after jumping to latest", async () => {
    let resize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let follow: ReturnType<typeof useBottomScroll>;
    function Harness() {
      follow = useBottomScroll();
      return h(
        "main",
        { ref: follow.viewport },
        h("div", { ref: follow.content }, "content"),
      );
    }
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(Harness, {}), root));
    const viewport = root.querySelector("main")!;
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200 },
    });
    await act(() => resize());
    expect(viewport.scrollTop).toBe(1000);
    await act(() => {
      viewport.scrollTop = 100;
      viewport.dispatchEvent(new Event("scroll"));
    });
    Object.defineProperty(viewport, "scrollHeight", { value: 1500 });
    await act(() => resize());
    expect(viewport.scrollTop).toBe(100);
    expect(follow!.atBottom).toBe(false);
    await act(() => follow!.scrollToBottom());
    expect(viewport.scrollTop).toBe(1500);
    expect(follow!.atBottom).toBe(true);
    await act(() => render(null, root));
  });
});
