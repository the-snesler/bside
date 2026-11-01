// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { App } from "@/entrypoints/sidepanel/App";
import { useBackground } from "@/lib/ui/use-background";
import { isSidebarCommand, type RuntimeSnapshot, type SidebarEvent } from "@/lib/protocol";
import { OPENAI_API_KEY_PROVIDER } from "@/lib/providers/openai";
import { EMPTY_USAGE } from "@/lib/domain/usage";
import type { AttachmentRefV1 } from "@/lib/domain/attachments";
import type { ConversationItem } from "@/lib/domain/conversation";
import { buildTurns } from "@/lib/ui/turns";
import { TurnTrace } from "@/lib/ui/TurnTrace";
import {
  attachedFileName, checkFiles, describeFileType, dragHasFiles, fileToBase64, filesFromTransfer, formatBytes, pastedFileName,
} from "@/lib/ui/attachments";

// Slate resolves real React under Vitest, so App-level tests render without the editor and read the props it would get.
const composer = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("@/lib/ui/Composer", async (original) => ({
  ...await original<typeof import("@/lib/ui/Composer")>(),
  Composer: (props: Record<string, unknown>) => {
    composer.props = props;
    return null;
  },
}));

afterEach(() => {
  document.body.innerHTML = "";
  composer.props = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachment helpers", () => {
  it("names unnamed pasted images by local date and time, and keeps real names", () => {
    const at = new Date(2026, 9, 5, 7, 8, 9);
    expect(pastedFileName("image/png", at)).toBe("pasted-2026-10-05-070809.png");
    expect(pastedFileName("image/jpeg", at)).toBe("pasted-2026-10-05-070809.jpg");
    expect(pastedFileName("application/x-weird+thing", at)).toBe("pasted-2026-10-05-070809.bin");
    expect(pastedFileName("", at)).toBe("pasted-2026-10-05-070809.bin");
    expect(attachedFileName({ name: "image.png", type: "image/png" }, "paste", at)).toBe("pasted-2026-10-05-070809.png");
    expect(attachedFileName({ name: "", type: "image/webp" }, "paste", at)).toBe("pasted-2026-10-05-070809.webp");
    expect(attachedFileName({ name: "Résumé.pdf", type: "application/pdf" }, "paste", at)).toBe("Résumé.pdf");
    expect(attachedFileName({ name: "image.png", type: "image/png" }, "drop", at)).toBe("image.png");
    expect(attachedFileName({ name: "  notes.md ", type: "" }, "picker", at)).toBe("notes.md");
  });

  it("encodes a file as canonical base64 in chunks, past the call-stack size", async () => {
    const bytes = new Uint8Array(0x8000 * 3 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    const encoded = await fileToBase64(new Blob([bytes]));
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(await fileToBase64(new Blob([new Uint8Array([0xff])]))).toBe("/w==");
  });

  it("finds files only in drags and clipboards that carry them", () => {
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    expect(dragHasFiles({ types: ["Files", "application/x-moz-file"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/uri-list", "text/plain"] })).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
    expect(filesFromTransfer({ files: [file] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toEqual([file]);
    const items = [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => file },
    ];
    expect(filesFromTransfer({ files: [] as unknown as FileList, items: items as unknown as DataTransferItemList })).toEqual([file]);
    expect(filesFromTransfer({ files: [] as unknown as FileList, items: [items[0]] as unknown as DataTransferItemList })).toEqual([]);
    expect(filesFromTransfer(null)).toEqual([]);
  });

  it("refuses empty files, files over 10 MB, and any past 8 per message before reading them", () => {
    expect(checkFiles([{ name: "a", size: 1 }, { name: "b", size: 10_000_000 }], 0)).toEqual({ accepted: [0, 1], errors: [] });
    const result = checkFiles([{ name: "big.zip", size: 10_000_001 }, { name: "empty.txt", size: 0 }, { name: "ok", size: 5 }, { name: "x", size: 5 }, { name: "y", size: 5 }], 6);
    expect(result.accepted).toEqual([2, 3]);
    expect(result.errors).toEqual([
      "big.zip is larger than 10 MB (10 MB).",
      "empty.txt is empty.",
      "A message can carry up to 8 files; 1 file was not attached.",
    ]);
    expect(checkFiles([{ name: "a", size: 1 }, { name: "b", size: 1 }], 8).errors).toEqual(["A message can carry up to 8 files; 2 files were not attached."]);
  });

  it("labels sizes and types for chips", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_234)).toBe("1.2 KB");
    expect(formatBytes(123_456)).toBe("123 KB");
    expect(formatBytes(3_400_000)).toBe("3.4 MB");
    expect(formatBytes(10_000_000)).toBe("10 MB");
    expect(describeFileType("image/png", "a.png")).toBe("PNG image");
    expect(describeFileType("image/jpeg", "a")).toBe("JPG image");
    expect(describeFileType("application/pdf", "cv")).toBe("PDF");
    expect(describeFileType("text/markdown", "notes.md", true)).toBe("MD");
    expect(describeFileType("text/plain", "README", true)).toBe("Text");
    expect(describeFileType("application/octet-stream", "blob")).toBe("File");
  });
});

function snapshotFor(id: string, items: ConversationItem[] = []): RuntimeSnapshot {
  return {
    conversation: { id, title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: items.length, lastModelId: null, usage: EMPTY_USAGE, items },
    credential: { configured: true, maskedSuffix: null, chatgpt: { connected: false, email: null, signInAgain: false } },
    provider: OPENAI_API_KEY_PROVIDER,
    settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
    permissionMode: "ask",
    page: null, ask: null, agentTabs: { bySession: {}, watching: null, takenOver: false }, queue: [], runs: [], notice: null,
  };
}

function fakePort() {
  const posted: Record<string, unknown>[] = [];
  const listeners: Array<(message: unknown) => void> = [];
  vi.spyOn(browser.runtime, "connect").mockReturnValue({
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    onMessage: { addListener: (listener: (message: unknown) => void) => listeners.push(listener), removeListener: () => {} },
    disconnect: () => {},
  } as never);
  let seq = 0;
  const emit = (event: Omit<SidebarEvent, "v" | "seq" | "at">) =>
    act(() => listeners.forEach((listener) => listener({ v: 1, at: 1, ...event, seq: event.runId ? ++seq : 0 })));
  const of = (type: string) => posted.filter((message) => message.type === type);
  return { posted, emit, of };
}

/** Lets file reads and the follow-up pump run. */
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

async function mountHook() {
  const port = fakePort();
  const view: { current?: ReturnType<typeof useBackground> } = {};
  function Harness() {
    view.current = useBackground();
    return null;
  }
  const root = document.createElement("div");
  document.body.append(root);
  await act(() => render(h(Harness, {}), root));
  await port.emit({ runId: null, conversationId: "s1", type: "state.snapshot", payload: snapshotFor("s1") });
  return { ...port, view, unmount: () => act(() => render(null, root)) };
}

const prepared = (requestId: string, id: string, name: string, mimeType = "text/plain", bytes = 5) =>
  ({ runId: null, conversationId: "s1", type: "attachment.prepared", payload: { requestId, result: { attachment: { id, name, mimeType, bytes, text: true } } } }) as const;

describe("pending files in the sidebar", () => {
  it("prepares files one at a time, sends their ids with the message, and drops them once accepted", async () => {
    const f = await mountHook();
    await act(() => f.view.current!.attachFiles([new File(["hello"], "a.txt", { type: "text/plain" }), new File([new Uint8Array([1, 2, 3])], "b.bin")], "picker"));
    await settle();
    expect(f.of("attachment.prepare")).toHaveLength(1);
    const first = f.of("attachment.prepare")[0]!;
    expect(first).toMatchObject({ sessionId: "s1", name: "a.txt", mimeType: "text/plain", data: btoa("hello") });
    expect(isSidebarCommand(first)).toBe(true);
    expect(f.view.current!.pendingFiles.map((file) => file.status)).toEqual(["uploading", "waiting"]);

    await f.emit(prepared(first.id as string, "id-a", "a.txt"));
    await settle();
    const second = f.of("attachment.prepare")[1]!;
    expect(second).toMatchObject({ name: "b.bin", mimeType: "", data: "AQID" });
    await f.emit({ ...prepared(second.id as string, "id-b", "b.bin", "application/octet-stream", 3) });
    await settle();
    expect(f.view.current!.pendingFiles.map((file) => [file.status, file.id, file.mimeType])).toEqual([["ready", "id-a", "text/plain"], ["ready", "id-b", "application/octet-stream"]]);

    await act(() => f.view.current!.sendPrompt("Use these", undefined, [], ["id-a", "id-b"]));
    const start = f.of("run.start").at(-1)!;
    expect(start).toMatchObject({ prompt: "Use these", attachmentIds: ["id-a", "id-b"], sessionId: "s1" });
    expect(start).not.toHaveProperty("contentIds");
    expect(isSidebarCommand(start)).toBe(true);

    await f.emit({ runId: null, conversationId: null, type: "attachment.accepted", payload: { ids: ["id-a", "id-b"] } });
    expect(f.view.current!.pendingFiles).toEqual([]);
    await f.unmount();
  });

  it("shows a refusal on its file, dismisses removed files, and refuses oversized ones before reading", async () => {
    const f = await mountHook();
    await act(() => f.view.current!.attachFiles([new File(["x"], "one.txt")], "picker"));
    await settle();
    await f.emit({ runId: null, conversationId: "s1", type: "attachment.prepared", payload: { requestId: f.of("attachment.prepare")[0]!.id as string, result: { error: "Too many files are waiting to be sent." } } });
    await settle();
    expect(f.view.current!.pendingFiles[0]).toMatchObject({ status: "failed", error: "Too many files are waiting to be sent." });
    await act(() => f.view.current!.removeFile(f.view.current!.pendingFiles[0]!.key));
    expect(f.view.current!.pendingFiles).toEqual([]);
    expect(f.of("attachment.dismiss")).toHaveLength(0);

    // Removed while it was being prepared: the id the background answers with is dismissed.
    await act(() => f.view.current!.attachFiles([new File(["y"], "two.txt")], "picker"));
    await settle();
    await act(() => f.view.current!.removeFile(f.view.current!.pendingFiles[0]!.key));
    await f.emit(prepared(f.of("attachment.prepare")[1]!.id as string, "id-2", "two.txt"));
    await settle();
    expect(f.of("attachment.dismiss")).toEqual([expect.objectContaining({ sessionId: "s1", attachmentIds: ["id-2"] })]);
    expect(isSidebarCommand(f.of("attachment.dismiss")[0])).toBe(true);

    // A prepared file that is removed is dismissed at once.
    await act(() => f.view.current!.attachFiles([new File(["z"], "three.txt")], "picker"));
    await settle();
    await f.emit(prepared(f.of("attachment.prepare")[2]!.id as string, "id-3", "three.txt"));
    await settle();
    await act(() => f.view.current!.removeFile(f.view.current!.pendingFiles[0]!.key));
    expect(f.of("attachment.dismiss").at(-1)).toMatchObject({ attachmentIds: ["id-3"] });

    const big = new File(["x"], "huge.iso");
    Object.defineProperty(big, "size", { value: 10_000_001 });
    await act(() => f.view.current!.attachFiles([big], "drop"));
    await settle();
    expect(f.of("attachment.prepare")).toHaveLength(3);
    expect(f.view.current!.pendingFiles).toEqual([]);
    expect(f.view.current!.fileNotice).toEqual({ sessionId: "s1", text: "huge.iso is larger than 10 MB (10 MB)." });
    await act(() => f.view.current!.clearFileNotice());
    expect(f.view.current!.fileNotice).toBeNull();
    await f.unmount();
  });

  it("names pasted images and prepares a chat's files only while that chat is open", async () => {
    const f = await mountHook();
    await act(() => f.view.current!.attachFiles([new File(["png"], "image.png", { type: "image/png" })], "paste"));
    await settle();
    expect(f.of("attachment.prepare")[0]!.name).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
    await f.emit(prepared(f.of("attachment.prepare")[0]!.id as string, "id-p", "pasted.png", "image/png", 3));

    await f.emit({ runId: null, conversationId: "s2", type: "state.snapshot", payload: snapshotFor("s2") });
    await act(() => f.view.current!.attachFiles([new File(["b"], "b.txt")], "picker"));
    // The user goes back to the first chat while the file is read: the background refuses it there, and it waits for its own chat.
    await f.emit({ runId: null, conversationId: "s1", type: "state.snapshot", payload: snapshotFor("s1") });
    await settle();
    const refused = f.of("attachment.prepare").filter((message) => message.sessionId === "s2");
    expect(refused).toHaveLength(1);
    await f.emit({ runId: null, conversationId: "s2", type: "attachment.prepared", payload: { requestId: refused[0]!.id as string, result: { error: "This chat changed. Attach the file again." } } });
    await settle();
    expect(f.view.current!.pendingFiles.find((file) => file.sessionId === "s2")).toMatchObject({ status: "waiting", error: null });
    expect(f.of("attachment.prepare")).toHaveLength(2);
    await f.emit({ runId: null, conversationId: "s2", type: "state.snapshot", payload: snapshotFor("s2") });
    await settle();
    expect(f.of("attachment.prepare").filter((message) => message.sessionId === "s2")).toHaveLength(2);
    expect(f.view.current!.pendingFiles.map((file) => file.sessionId)).toEqual(["s1", "s2"]);

    // A chat that no longer exists loses its files.
    await f.emit({ runId: null, conversationId: null, type: "session.listed", payload: { sessions: [{ id: "s2", title: "", titleSource: "prompt", createdAt: 0, updatedAt: 0, pinned: false, itemCount: 0, lastModelId: null, usage: EMPTY_USAGE }] } });
    expect(f.view.current!.pendingFiles.map((file) => file.sessionId)).toEqual(["s2"]);
    expect(f.of("attachment.dismiss").at(-1)).toMatchObject({ sessionId: "s1", attachmentIds: ["id-p"] });
    await f.unmount();
  });

  it("keeps the files of the open chat, which history does not list while it is untouched, and drops those of a chat that went", async () => {
    const f = await mountHook();
    const summary = (id: string) => ({ id, title: "", titleSource: "prompt" as const, createdAt: 0, updatedAt: 0, pinned: false, itemCount: 1, lastModelId: null, usage: EMPTY_USAGE });
    await act(() => f.view.current!.attachFiles([new File(["a"], "a.txt")], "picker"));
    await settle();
    // The list leaves out the untouched open chat: its file stays.
    await f.emit({ runId: null, conversationId: null, type: "session.listed", payload: { sessions: [summary("s9")] } });
    expect(f.view.current!.pendingFiles.map((file) => file.sessionId)).toEqual(["s1"]);
    // The sidebar moves to another untouched chat, and the one it left is deleted: its file goes, though the open chat is not listed either.
    await f.emit({ runId: null, conversationId: "s2", type: "state.snapshot", payload: snapshotFor("s2") });
    expect(f.view.current!.pendingFiles).toEqual([]);
    await f.unmount();
  });

  it("keeps the attachments of a started run on its optimistic user message", async () => {
    const f = await mountHook();
    const ref: AttachmentRefV1 = { v: 1, path: "/workspace/uploads/cv.pdf", name: "CV.pdf", mimeType: "application/pdf", bytes: 2_000, text: false };
    await f.emit({ runId: "r1", conversationId: "s1", type: "run.started", payload: { prompt: "Apply", page: null, ask: null, retry: false, attachments: [ref] } });
    expect(f.view.current!.conversation.items[0]).toMatchObject({ role: "user", text: "Apply", attachments: [ref] });
    await f.unmount();
  });
});

function dragEvent(type: string, types: string[], files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types, files, items: [], dropEffect: "none" } });
  return event;
}

describe("sidebar attachments UI", () => {
  async function mountApp(items: ConversationItem[] = [], queue: RuntimeSnapshot["queue"] = []) {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const port = fakePort();
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(App, {}), root));
    await port.emit({ runId: null, conversationId: "s1", type: "state.snapshot", payload: { ...snapshotFor("s1", items), queue } });
    return { ...port, root, unmount: () => act(() => render(null, root)) };
  }

  it("shows a drop overlay only for drags carrying files, cancels their default, and attaches dropped files", async () => {
    const f = await mountApp();
    const sidebar = f.root.querySelector(".sidebar")!;
    const link = dragEvent("dragenter", ["text/uri-list"]);
    await act(() => { sidebar.dispatchEvent(link); });
    expect(link.defaultPrevented).toBe(false);
    expect(f.root.querySelector(".drop-overlay")).toBeNull();
    const over = dragEvent("dragover", ["text/uri-list"]);
    await act(() => { sidebar.dispatchEvent(over); });
    expect(over.defaultPrevented).toBe(false);

    const enter = dragEvent("dragenter", ["Files"]);
    await act(() => { sidebar.dispatchEvent(enter); });
    expect(enter.defaultPrevented, "enter").toBe(true);
    expect(f.root.querySelector(".drop-overlay")?.textContent).toBe("Drop files to attach");
    const fileOver = dragEvent("dragover", ["Files"]);
    await act(() => { sidebar.dispatchEvent(fileOver); });
    expect(fileOver.defaultPrevented, "over").toBe(true);

    const drop = dragEvent("drop", ["Files"], [new File(["hi"], "notes.txt", { type: "text/plain" })]);
    await act(() => { sidebar.dispatchEvent(drop); });
    expect(drop.defaultPrevented, "drop").toBe(true);
    expect(f.root.querySelector(".drop-overlay")).toBeNull();
    await settle();
    expect(f.of("attachment.prepare")).toEqual([expect.objectContaining({ name: "notes.txt", sessionId: "s1" })]);
    expect((composer.props!.files as unknown[]).length).toBe(1);

    // A file drop anywhere in the window never navigates the sidebar.
    const stray = dragEvent("drop", ["Files"]);
    window.dispatchEvent(stray);
    expect(stray.defaultPrevented, "stray").toBe(true);
    await f.unmount();
  });

  it("sends only this chat's prepared file ids with a message or a steer", async () => {
    const f = await mountApp();
    const props = () => composer.props as { onAttachFiles: (files: File[], source: string) => void; onSend: (text: string) => void };
    await act(() => props().onAttachFiles([new File(["a"], "a.txt")], "picker"));
    await settle();
    await f.emit(prepared(f.of("attachment.prepare")[0]!.id as string, "id-a", "a.txt"));
    await settle();
    expect((composer.props!.files as { status: string }[])[0]!.status).toBe("ready");
    await act(() => props().onSend("Summarize it"));
    expect(f.of("run.start").at(-1)).toMatchObject({ prompt: "Summarize it", attachmentIds: ["id-a"], sessionId: "s1" });
    await f.unmount();
  });

  it("shows sent and queued files as text chips, with image thumbnails from the chat's workspace", async () => {
    const image: AttachmentRefV1 = { v: 1, path: "/workspace/uploads/photo.png", name: "<img src=x onerror=alert(1)>.png", mimeType: "image/png", bytes: 4_200, text: false };
    const pdf: AttachmentRefV1 = { v: 1, path: "/workspace/uploads/cv.pdf", name: "Jane Doe Résumé.pdf", mimeType: "application/pdf", bytes: 1_500_000, text: false };
    const f = await mountApp(
      [{ id: "u1", kind: "message", role: "user", text: "Apply with this", context: null, attachments: [image, pdf], at: 0 }],
      [{ id: "q1", mode: "follow-up", text: "Then this", attachments: [pdf], at: 1 }],
    );
    const chips = [...f.root.querySelectorAll(".timeline__item--user .file-chip")];
    expect(chips.map((chip) => chip.querySelector(".file-chip__name")!.textContent)).toEqual([image.name, pdf.name]);
    expect(chips[1]!.querySelector(".file-chip__meta")!.textContent).toBe("PDF · 1.5 MB");
    expect(f.root.querySelector(".queue .file-chip__name")?.textContent).toBe(pdf.name);
    const request = f.of("workspace.image");
    expect(request).toEqual([expect.objectContaining({ sessionId: "s1", path: image.path })]);
    await f.emit({ runId: null, conversationId: "s1", type: "workspace.image.loaded", payload: { requestId: request[0]!.id as string, result: { ok: true, mimeType: "image/png", data: "iVBORw0KGgo=" } } });
    await settle();
    const thumbs = [...f.root.querySelectorAll(".timeline__item--user img")];
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(f.root.querySelectorAll("script")).toHaveLength(0);
    await f.unmount();
  });

  it("shows a delivered steer's files in the trace", () => {
    const ref: AttachmentRefV1 = { v: 1, path: "/workspace/uploads/data.csv", name: "data.csv", mimeType: "text/csv", bytes: 900, text: true };
    const turns = buildTurns([
      { id: "u1", kind: "message", role: "user", text: "Start", context: null, at: 0 },
      { id: "c1", kind: "tool-call", call: { id: "call-1", name: "browser_program", arguments: { source: "1" } }, at: 1 },
      { id: "s1", kind: "message", role: "user", text: "Use this too", context: null, delivery: "steer", attachments: [ref], at: 2 },
    ], true);
    expect(turns[0]!.steps.at(-1)).toMatchObject({ kind: "steer", attachments: [ref] });
    const root = document.createElement("div");
    document.body.append(root);
    render(h(TurnTrace, { turn: turns[0]!, active: true, pendingApproval: null, onApprove: () => {}, onDeny: () => {} }), root);
    expect(root.querySelector(".trace__steer .file-chip__name")?.textContent).toBe("data.csv");
    expect(root.querySelector(".trace__steer .file-chip__meta")?.textContent).toBe("CSV · 900 B");
    render(null, root);
  });
});
