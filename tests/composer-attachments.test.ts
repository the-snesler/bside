// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Editor, Transforms, type Descendant } from "slate";
import { Composer } from "@/lib/ui/Composer";
import type { PendingFile } from "@/lib/ui/attachments";

// Drive Slate's real document operations through a minimal view adapter (slate-react resolves React, not Preact, under Vitest).
const view = vi.hoisted(() => ({ editor: null as unknown as Editor, change: () => {} }));
vi.mock("slate-react", async () => {
  const { h } = await import("preact");
  return {
    withReact: (editor: Editor) => editor,
    ReactEditor: { focus: vi.fn() },
    Slate: ({ editor, initialValue, onChange, children }: { editor: Editor; initialValue: Descendant[]; onChange: () => void; children: unknown }) => {
      if (!editor.children.length) editor.children = initialValue;
      view.editor = editor; view.change = onChange;
      return children;
    },
    Editable: (props: Record<string, unknown>) => h("div", { role: "textbox", onKeyDown: props.onKeyDown, onPaste: props.onPaste, "aria-label": props["aria-label"], "data-placeholder": props.placeholder }),
  };
});

let root: HTMLDivElement;
afterEach(() => { if (root) render(null, root); document.body.innerHTML = ""; vi.restoreAllMocks(); });

const file = (overrides: Partial<PendingFile>): PendingFile => ({
  key: "k1", sessionId: "s1", file: new File(["x"], "a.txt"), name: "a.txt", mimeType: "text/plain", bytes: 1_234, status: "ready", id: "id-1", error: null, ...overrides,
});

async function mount(extra: Record<string, unknown> = {}) {
  const props = {
    sessionId: "s1", disabled: false, running: false, working: false, canSteer: false, configured: true, tabs: [],
    onListTabs: vi.fn(), onSend: vi.fn(), onSteer: vi.fn(), onStop: vi.fn(), onAttachFiles: vi.fn(), onRemoveFile: vi.fn(), onClearFileNotice: vi.fn(), ...extra,
  };
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(Composer, props), root));
  return props;
}
async function type(text: string) {
  await act(async () => { Transforms.select(view.editor, Editor.end(view.editor, [])); Transforms.insertText(view.editor, text); view.change(); });
}
const sendButton = () => root.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
const placeholder = () => root.querySelector('[role="textbox"]')!.getAttribute("data-placeholder");

describe("composer attachments", () => {
  it("opens a hidden multi-file input from the + button and hands picked files over", async () => {
    const props = await mount();
    const button = root.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    expect(input.hidden).toBe(true);
    expect(input.accept).toBe("");
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await act(async () => button.click());
    expect(click).toHaveBeenCalledTimes(1);
    const picked = [new File(["a"], "a.pdf"), new File(["b"], "b.png")];
    Object.defineProperty(input, "files", { value: picked, configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(props.onAttachFiles).toHaveBeenCalledWith(picked, "picker");
  });

  it("attaches pasted files and leaves text pastes to the editor", async () => {
    const props = await mount();
    const editor = root.querySelector('[role="textbox"]')!;
    const pastedFile = new File(["png"], "image.png", { type: "image/png" });
    const withFile = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(withFile, "clipboardData", { value: { files: [pastedFile], items: [], getData: () => "" } });
    await act(async () => { editor.dispatchEvent(withFile); });
    expect(withFile.defaultPrevented).toBe(true);
    expect(props.onAttachFiles).toHaveBeenCalledWith([pastedFile], "paste");

    const text = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(text, "clipboardData", { value: { files: [], items: [{ kind: "string", getAsFile: () => null }], getData: () => "hello" } });
    await act(async () => { editor.dispatchEvent(text); });
    expect(text.defaultPrevented).toBe(false);
    expect(props.onAttachFiles).toHaveBeenCalledTimes(1);
  });

  it("shows pending files as text chips and sends only once every file is prepared and there is text", async () => {
    const hostile = file({ key: "k2", name: "<img src=x onerror=alert(1)>.txt", status: "uploading", id: null });
    const props = await mount({ files: [file({}), hostile] });
    const names = [...root.querySelectorAll(".file-chip__name")].map((node) => node.textContent);
    expect(names).toEqual(["a.txt", hostile.name]);
    expect(root.querySelectorAll("img")).toHaveLength(0);
    expect(root.querySelector(".file-chip--busy .file-chip__meta")?.textContent).toBe("Attaching… · 1.2 KB");
    expect(root.textContent).toContain("Attaching files…");
    await type("Use them");
    expect(sendButton().disabled).toBe(true);

    await act(async () => render(h(Composer, { ...props, files: [file({}), { ...hostile, status: "failed", error: "Too many files are waiting to be sent." }] }), root));
    expect(root.querySelector('.file-chip--failed [role="alert"]')?.textContent).toBe("Too many files are waiting to be sent.");
    expect(root.textContent).toContain("Remove the files that could not be attached to send.");
    expect(sendButton().disabled).toBe(true);
    await act(async () => root.querySelectorAll<HTMLButtonElement>(".file-chip__remove")[1]!.click());
    expect(props.onRemoveFile).toHaveBeenCalledWith("k2");

    await act(async () => render(h(Composer, { ...props, files: [file({})] }), root));
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(props.onSend).toHaveBeenCalledWith("Use them");
  });

  it("asks for a message when only files are attached, and shows why files were refused", async () => {
    const props = await mount({ files: [file({})], fileNotice: "huge.iso is larger than 10 MB (12 MB)." });
    expect(sendButton().disabled).toBe(true);
    expect(placeholder()).toBe("Add a message to send with your files…");
    expect(root.querySelector(".composer__file-notice")?.textContent).toBe("huge.iso is larger than 10 MB (12 MB).");
    await act(async () => root.querySelector<HTMLButtonElement>('.composer__file-notice button[aria-label="Dismiss"]')!.click());
    expect(props.onClearFileNotice).toHaveBeenCalled();
  });
});
