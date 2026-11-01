import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserProgram, ScratchFiles, ScratchFilesError, UPLOADS_READ_ONLY_MESSAGE, uploadFileName, WorkspaceState,
  type ScratchFileEntry, type ScratchStore, type UploadInput,
} from "@/lib/background/browser-program";
import { ImageScaleError, scaleImageInPage, type ImageScaler } from "@/lib/background/image-scale";
import { PdfReader } from "@/lib/background/pdf";
import { TabController, type TabControllerBrowserApi, type TabSnapshot } from "@/lib/background/tab-controller";
import { bytesToBase64 } from "@/lib/domain/pdf";
import type { DomAction, ElementTarget } from "@/lib/domain/tools";
import { extractPdfText } from "@/lib/pdf/extract";
import {
  isWorkspacePath, validateDomAction, WORKSPACE_MAX_BINARY_BYTES, WORKSPACE_MAX_BINARY_TOTAL_BYTES, WORKSPACE_MAX_UPLOAD_BYTES,
} from "@/lib/validation";
import { makePdf } from "./helpers/pdf";

const encode = (text: string) => bytesToBase64(new TextEncoder().encode(text));
/** Canonical base64 of `bytes` zero bytes, built without allocating them. */
const zeros = (bytes: number) => "A".repeat(Math.floor(bytes / 3) * 4) + (bytes % 3 === 1 ? "AA==" : bytes % 3 === 2 ? "AAA=" : "");

function upload(name: string, fields: Partial<UploadInput> = {}): UploadInput {
  const data = fields.data ?? encode(`contents of ${name}`);
  return { name, mimeType: "text/plain", data, bytes: fields.bytes ?? atob(data).length, text: true, ...fields };
}

function textUpload(name: string, text: string): UploadInput {
  return upload(name, { data: encode(text), bytes: new TextEncoder().encode(text).length });
}

/** A store over a map of slots, whose writes can be made to fail. */
function memoryStore(initial: ScratchFileEntry[] = []) {
  const slots = new Map(initial.map((entry) => [entry.slot, entry]));
  const store: ScratchStore = {
    load: vi.fn(async () => [...slots.values()].map((entry) => ({ ...entry }))),
    write: vi.fn(async (entry: ScratchFileEntry) => { slots.set(entry.slot, { ...entry }); }),
    remove: vi.fn(async (slot: number) => { slots.delete(slot); }),
  };
  const paths = () => [...slots.values()].map((entry) => entry.path).sort();
  return { store, slots, paths };
}

/** One user tab with a file input; records the actions sent to it. */
function fakeTab() {
  const tab: TabSnapshot = { id: 1, url: "https://jobs.example/apply", title: "Apply", hidden: false };
  const executed: DomAction[] = [];
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [tab]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        const request = message as { id: string; type: string; target?: ElementTarget | null };
        if (request.type === "page.snapshot") {
          const text = '[e1 file "Résumé"]';
          return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot: { version: 2, tabId, documentId: "doc-1", url: tab.url, title: "Apply", text, offset: 0, end: text.length, totalChars: text.length, selectionText: "" } };
        }
        if (request.type === "page.execute") {
          executed.push((message as { action: DomAction }).action);
          return { v: 1, id: request.id, ok: true, type: "page.execute", result: { ok: true, summary: "Attached." }, documentId: "doc-1" };
        }
        throw new Error(`unexpected ${request.type}`);
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return { api, executed };
}

function setup(options: { files?: ScratchFiles; scaleImage?: ImageScaler; maxImages?: number } = {}) {
  const { api, executed } = fakeTab();
  const files = options.files ?? new ScratchFiles();
  const program = new BrowserProgram(new TabController(api, async () => false, undefined, new PdfReader(extractPdfText)),
    { state: new WorkspaceState(), runId: "r1", sessionId: "s1", files, maxImages: options.maxImages ?? 3, scaleImage: options.scaleImage }, () => {});
  const run = (source: string) => program.execute(source, new AbortController().signal);
  return { run, program, files, executed };
}

describe("upload file names", () => {
  it("sanitizes names, keeps the extension, bounds the length, and never reuses a taken name", () => {
    const free = () => false;
    expect(uploadFileName("Jane Doe Résumé.pdf", "application/pdf", free)).toBe("Jane-Doe-R-sum-.pdf");
    expect(uploadFileName("..hidden config", "text/plain", free)).toBe("hidden-config");
    expect(uploadFileName("--- notes ---.md", "text/markdown", free)).toBe("notes-.md");
    expect(uploadFileName("日本語", "text/plain", free)).toBe("file");
    expect(uploadFileName("日本語.txt", "text/plain", free)).toBe("file.txt");
    const long = uploadFileName(`${"x".repeat(300)}.tar.gz`, "application/gzip", free);
    expect(long).toHaveLength(120);
    expect(long.endsWith("x.tar.gz") || long.endsWith(".gz")).toBe(true);
    // An image's path names its type, so the sidebar and Markdown can show it.
    expect(uploadFileName("photo", "image/png", free)).toBe("photo.png");
    expect(uploadFileName("photo.PNG", "image/png", free)).toBe("photo.PNG");
    expect(uploadFileName("scan.png", "image/jpeg", free)).toBe("scan.png.jpg");
    expect(uploadFileName("...", "image/webp", free)).toBe("file.webp");
    expect(uploadFileName(".bashrc", "text/plain", free)).toBe("bashrc");

    const taken = new Set(["cv.pdf", "cv-2.pdf", "README"]);
    expect(uploadFileName("cv.pdf", "application/pdf", (name) => taken.has(name))).toBe("cv-3.pdf");
    expect(uploadFileName("README", "text/plain", (name) => taken.has(name))).toBe("README-2");
    const longTaken = `${"y".repeat(116)}.txt`;
    expect(uploadFileName(longTaken, "text/plain", (name) => name === longTaken)).toBe(`${"y".repeat(114)}-2.txt`);
    for (const name of ["Jane Doe Résumé.pdf", "..hidden", long, "photo", "日本語"]) {
      expect(isWorkspacePath(`/workspace/uploads/${uploadFileName(name, "image/png", free)}`)).toBe(true);
    }
  });
});

describe("ScratchFiles.attach and discard", () => {
  it("writes each upload through to its own slot under /workspace/uploads, never replacing a file", async () => {
    const scratch = memoryStore([{ slot: 0, path: "/workspace/uploads/cv.pdf", kind: "upload", name: "cv.pdf", mimeType: "application/pdf", data: "JVBERi0=", bytes: 5, text: false }]);
    const files = new ScratchFiles(scratch.store);
    const paths = await files.attach([
      upload("cv.pdf", { mimeType: "application/pdf", data: "JVBERi0=", bytes: 5, text: false }),
      upload("Cover letter.txt"),
      upload("Cover letter.txt"),
    ]);
    expect(paths).toEqual(["/workspace/uploads/cv-2.pdf", "/workspace/uploads/Cover-letter.txt", "/workspace/uploads/Cover-letter-2.txt"]);
    expect([...scratch.slots.entries()].map(([slot, entry]) => [slot, entry.path])).toEqual([
      [0, "/workspace/uploads/cv.pdf"], [1, "/workspace/uploads/cv-2.pdf"], [2, "/workspace/uploads/Cover-letter.txt"], [3, "/workspace/uploads/Cover-letter-2.txt"],
    ]);
    expect(await files.read("/workspace/uploads/Cover-letter-2.txt")).toEqual({ kind: "upload", ...upload("Cover letter.txt") });
    expect(scratch.slots.get(1)).toEqual({ slot: 1, path: "/workspace/uploads/cv-2.pdf", kind: "upload", name: "cv.pdf", mimeType: "application/pdf", data: "JVBERi0=", bytes: 5, text: false });
  });

  it("checks every limit for the whole batch first and writes nothing when one fails", async () => {
    const scratch = memoryStore();
    const files = new ScratchFiles(scratch.store);
    const tooBig = upload("huge.bin", { data: zeros(WORKSPACE_MAX_UPLOAD_BYTES + 1), bytes: WORKSPACE_MAX_UPLOAD_BYTES + 1, text: false });
    await expect(files.attach([upload("a.txt"), tooBig])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", message: "Attached files can be up to 10 MB each." });

    // 25 MB for the chat: saved binaries and attachments together.
    await files.write("/workspace/shot.jpg", { kind: "binary", mimeType: "image/jpeg", data: zeros(WORKSPACE_MAX_BINARY_BYTES), bytes: WORKSPACE_MAX_BINARY_BYTES });
    const tenMb = (name: string) => upload(name, { mimeType: "application/octet-stream", data: zeros(WORKSPACE_MAX_UPLOAD_BYTES), bytes: WORKSPACE_MAX_UPLOAD_BYTES, text: false });
    await expect(files.attach([tenMb("a.bin"), tenMb("b.bin"), tenMb("c.bin")])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(scratch.paths()).toEqual(["/workspace/shot.jpg"]);
    expect(await files.attach([tenMb("a.bin"), tenMb("b.bin")])).toHaveLength(2);
    // Program binaries count against the same budget.
    const shot = { kind: "binary", mimeType: "image/jpeg", data: zeros(WORKSPACE_MAX_BINARY_BYTES), bytes: WORKSPACE_MAX_BINARY_BYTES } as const;
    await files.write("/workspace/more1.jpg", shot);
    await files.write("/workspace/more2.jpg", shot);
    await expect(files.write("/workspace/more3.jpg", shot)).rejects.toThrow("25,000,000 bytes together");
    expect(WORKSPACE_MAX_BINARY_TOTAL_BYTES).toBe(25_000_000);

    // 64 files at most, counted for the whole batch.
    for (let n = 0; n < 58; n++) await files.write(`/workspace/f${n}.txt`, { kind: "text", content: "" });
    await expect(files.attach([upload("x.txt"), upload("y.txt")])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(scratch.slots.size).toBe(63);
    expect(await files.attach([upload("x.txt")])).toEqual(["/workspace/uploads/x.txt"]);

    // Malformed input is refused, not repaired.
    for (const bad of [upload("a/b.txt"), upload("ok.txt", { mimeType: "text plain" }), upload("ok.txt", { bytes: 3 }), upload("ok.txt", { data: "not base64!", bytes: 8 })]) {
      await expect(new ScratchFiles().attach([bad])).rejects.toMatchObject({ code: "INVALID_FILE" });
    }
  });

  it("removes the files of a batch whose write fails partway, and keeps it out of memory", async () => {
    const scratch = memoryStore();
    const files = new ScratchFiles(scratch.store);
    vi.mocked(scratch.store.write).mockImplementationOnce(async (entry) => { scratch.slots.set(entry.slot, { ...entry }); }).mockRejectedValueOnce(new Error("Quota exceeded"));
    const failed = files.attach([upload("a.txt"), upload("b.txt")]);
    await expect(failed).rejects.toBeInstanceOf(ScratchFilesError);
    await expect(failed).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(scratch.slots.size).toBe(0);
    expect(await files.paths()).toEqual([]);
    expect(await files.attach([upload("a.txt")])).toEqual(["/workspace/uploads/a.txt"]);
  });

  it("discards only attachments, and refuses every change once closed", async () => {
    const scratch = memoryStore();
    const files = new ScratchFiles(scratch.store);
    const [a, b] = await files.attach([upload("a.txt"), upload("b.txt")]);
    await files.write("/workspace/notes.md", { kind: "text", content: "mine" });
    await files.discard([a!, "/workspace/notes.md", "/workspace/uploads/missing.txt"]);
    expect(scratch.paths()).toEqual([b, "/workspace/notes.md"].sort());

    // A change queued before close still lands; nothing after it does.
    const queued = files.attach([upload("c.txt")]);
    const closed = files.close();
    await expect(queued).resolves.toEqual(["/workspace/uploads/c.txt"]);
    await closed;
    await expect(files.attach([upload("d.txt")])).rejects.toMatchObject({ code: "CLOSED" });
    await expect(files.discard([b!])).rejects.toMatchObject({ code: "CLOSED" });
    await expect(files.write("/workspace/late.md", { kind: "text", content: "late" })).rejects.toThrow("This chat no longer exists.");
    expect(scratch.paths()).toEqual([b, "/workspace/notes.md", "/workspace/uploads/c.txt"].sort());
  });
});

describe("attachments in browser programs", () => {
  async function withUploads(...uploads: UploadInput[]) {
    const scratch = memoryStore();
    const files = new ScratchFiles(scratch.store);
    const paths = await files.attach(uploads);
    return { scratch, files, paths };
  }

  it("refuses to write, move, or remove anything in /workspace/uploads before any change", async () => {
    const { scratch, files } = await withUploads(upload("cv.txt"));
    await files.write("/workspace/notes.md", { kind: "text", content: "n" });
    const { run } = setup({ files });
    for (const source of [
      'await fs.write("/workspace/uploads/cv.txt", "replaced");',
      'await fs.write("/workspace/uploads/new.txt", "new");',
      'await fs.write("/workspace/uploads", "a file where the directory is");',
      'await fs.remove("/workspace/uploads/cv.txt");',
      'await fs.move("/workspace/uploads/cv.txt", "/workspace/cv.txt");',
      'await fs.move("/workspace/notes.md", "/workspace/uploads/notes.md");',
      'await fs.move("/workspace/notes.md", "/workspace/uploads");',
    ]) {
      const result = await run(source);
      expect(result.ok, source).toBe(false);
      expect(result.summary, source).toContain(UPLOADS_READ_ONLY_MESSAGE);
    }
    await expect(files.write("/workspace/uploads/x.png", { kind: "binary", mimeType: "image/png", data: "iVBORw0KGgo=", bytes: 8 })).rejects.toThrow(UPLOADS_READ_ONLY_MESSAGE);
    expect(scratch.paths()).toEqual(["/workspace/notes.md", "/workspace/uploads/cv.txt"]);
    expect(vi.mocked(scratch.store.write)).toHaveBeenCalledTimes(2);
  });

  it("lists attachments with their original name, type, and size", async () => {
    const { files } = await withUploads(upload("Jane Doe CV.pdf", { mimeType: "application/pdf", data: "JVBERi0=", bytes: 5, text: false }));
    await files.write("/workspace/notes.md", { kind: "text", content: "n" });
    const { run } = setup({ files });
    const entry = { path: "/workspace/uploads/Jane-Doe-CV.pdf", name: "Jane Doe CV.pdf", mimeType: "application/pdf", bytes: 5, attachedByUser: true };
    expect(JSON.parse((await run('return JSON.stringify(fs.list("/workspace"));')).summary)).toEqual([entry, "/workspace/notes.md"]);
    expect(JSON.parse((await run('return JSON.stringify(fs.list("/workspace/uploads"));')).summary)).toEqual([entry]);
  });

  it("reads an attached text file as untrusted text, paged, and taints the run", async () => {
    const text = `${"line one\n".repeat(100)}${"x".repeat(1200)}`;
    const { files } = await withUploads(textUpload("notes.md", text));
    const { run, program } = setup({ files });
    const whole = await run('return fs.read("/workspace/uploads/notes.md");');
    expect(whole.summary).toBe(`File: /workspace/uploads/notes.md ("notes.md", text/plain, ${text.length} bytes; attached by the user, read-only)\nBEGIN_UNTRUSTED_FILE\n${text}\nEND_UNTRUSTED_FILE`);
    expect(program.tainted).toBe(true);
    // Pages end after a whole line when there is one.
    const first = await run('return fs.read("/workspace/uploads/notes.md", {maxChars: 500});');
    expect(first.summary).toContain(`BEGIN_UNTRUSTED_FILE\n${"line one\n".repeat(55)}\nEND_UNTRUSTED_FILE`);
    expect(first.summary).toContain(`[Showing characters 0–495 of ${text.length}. Continue with fs.read("/workspace/uploads/notes.md", {offset: 495})`);
    // A line longer than a page still advances.
    const long = await run('return fs.read("/workspace/uploads/notes.md", {offset: 900, maxChars: 500});');
    expect(long.summary).toContain(`BEGIN_UNTRUSTED_FILE\n${"x".repeat(500)}\nEND_UNTRUSTED_FILE`);
    expect(long.summary).toContain("{offset: 1400}");
    const last = await run('return fs.read("/workspace/uploads/notes.md", {offset: 1900});');
    expect(last.summary).toContain(`[Showing characters 1900–2100 of 2100; end of file.]`);
  });

  it("reads an attached PDF as its text, like a workspace PDF", async () => {
    const pdf = bytesToBase64(makePdf([["Jane Doe", "Senior engineer"]], { title: "CV" }));
    const { files } = await withUploads(upload("Jane CV.pdf", { mimeType: "application/pdf", data: pdf, bytes: atob(pdf).length, text: false }));
    const { run, program } = setup({ files });
    const read = await run('return fs.read("/workspace/uploads/Jane-CV.pdf");');
    expect(read.ok, read.summary).toBe(true);
    expect(read.summary).toContain("File: /workspace/uploads/Jane-CV.pdf (PDF, read-only)\nBEGIN_UNTRUSTED_PAGE\nPDF: 1 page · CV");
    expect(read.summary).toContain("Senior engineer");
    expect(program.tainted).toBe(true);
  });

  it("describes images and unreadable files instead of reading them", async () => {
    const { files } = await withUploads(
      upload("photo.png", { mimeType: "image/png", data: "iVBORw0KGgo=", bytes: 8, text: false }),
      upload("archive.zip", { mimeType: "application/zip", data: "UEsDBA==", bytes: 4, text: false }),
      // Said to be text, but its bytes are not UTF-8: treated as unreadable.
      upload("broken.txt", { data: "/w==", bytes: 1, text: true }),
    );
    const { run, program } = setup({ files });
    expect(JSON.parse((await run('return JSON.stringify(fs.read("/workspace/uploads/photo.png"));')).summary)).toEqual(
      { path: "/workspace/uploads/photo.png", name: "photo.png", mimeType: "image/png", bytes: 8, binary: true, attachedByUser: true });
    const zip = JSON.parse((await run('return JSON.stringify(fs.read("/workspace/uploads/archive.zip"));')).summary);
    expect(zip).toMatchObject({ path: "/workspace/uploads/archive.zip", name: "archive.zip", mimeType: "application/zip", bytes: 4 });
    expect(zip.note).toContain('setInputFiles("/workspace/uploads/archive.zip")');
    expect(JSON.parse((await run('return JSON.stringify(fs.read("/workspace/uploads/broken.txt"));')).summary).note).toContain("cannot read");
    expect((await run('return fs.read("/workspace/uploads/archive.zip", {offset: 10});')).summary).toContain("the file is not text");
    expect((await run('return fs.view("/workspace/uploads/archive.zip");')).summary).toContain("fs.view() shows images");
    expect(program.tainted).toBe(false);
  });

  it("shows an attached image through the scaling seam, counted as an image, and keeps the original bytes", async () => {
    const original = "iVBORw0KGgo=";
    const { files } = await withUploads(upload("Big photo.png", { mimeType: "image/png", data: original, bytes: 8, text: false }));
    const scaleImage = vi.fn<ImageScaler>(async () => ({ mimeType: "image/jpeg", data: "SCALED", width: 1600, height: 900 }));
    const { run, program } = setup({ files, scaleImage, maxImages: 1 });
    const viewed = await run('await fs.view("/workspace/uploads/Big-photo.png");');
    expect(viewed.ok, viewed.summary).toBe(true);
    expect(viewed.summary).toBe("[image /workspace/uploads/Big-photo.png, 8 bytes] (image 1 of this result)");
    expect(scaleImage).toHaveBeenCalledWith({ mimeType: "image/png", data: original }, 1600);
    expect(program.takeImages()).toEqual([{ mimeType: "image/jpeg", data: "SCALED", placeholder: "[image /workspace/uploads/Big-photo.png, 8 bytes]" }]);
    expect(program.tainted).toBe(true);
    expect(await files.read("/workspace/uploads/Big-photo.png")).toMatchObject({ data: original });
    // The run's image budget applies, before any decoding.
    expect((await run('await fs.view("/workspace/uploads/Big-photo.png");')).code).toBe("LIMIT_EXCEEDED");
    expect(scaleImage).toHaveBeenCalledTimes(1);
  });

  it("fails a view whose image cannot be decoded with a safe message", async () => {
    const { files } = await withUploads(upload("fake.png", { mimeType: "image/png", data: "AAAA", bytes: 3, text: false }));
    const scaleImage: ImageScaler = async () => { throw new ImageScaleError("The image could not be decoded; it may be damaged or not the type it claims."); };
    const { run, program } = setup({ files, scaleImage });
    const result = await run('await fs.view("/workspace/uploads/fake.png");');
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_PAGE" });
    expect(result.summary).toContain("/workspace/uploads/fake.png: The image could not be decoded");
    expect(program.takeImages()).toEqual([]);
  });

  it("uploads an attachment to a page with its original name, type, and raw bytes", async () => {
    const data = zeros(4_000_000);
    const { files } = await withUploads(upload("Jane Doe Résumé.docx", { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data, bytes: 4_000_000, text: false }));
    const { run, executed } = setup({ files });
    const result = await run('await browser.tab("/tabs/1/page.md").getByRole("file").setInputFiles("/workspace/uploads/Jane-Doe-R-sum-.docx");');
    expect(result.ok, result.summary).toBe(true);
    expect(executed).toEqual([{ kind: "upload", target: { kind: "role", role: "file", name: null, exact: false }, files: [
      { name: "Jane Doe Résumé.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: data },
    ] }]);
    // The content script accepts it too.
    expect(validateDomAction(executed[0])).toEqual(executed[0]);
  });

  it("bounds one upload action to the chat's byte budget", async () => {
    const tenMb = zeros(WORKSPACE_MAX_UPLOAD_BYTES);
    const { files } = await withUploads(upload("a.bin", { mimeType: "application/octet-stream", data: tenMb, bytes: WORKSPACE_MAX_UPLOAD_BYTES, text: false }));
    const { run, executed } = setup({ files });
    const result = await run('await browser.tab("/tabs/1/page.md").getByRole("file").setInputFiles(["/workspace/uploads/a.bin", "/workspace/uploads/a.bin", "/workspace/uploads/a.bin"]);');
    expect(result).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
    expect(executed).toEqual([]);
  });
});

describe("upload validation for the content script", () => {
  const target = { kind: "ref", ref: "e1", documentId: "doc-1" };
  const action = (...files: object[]) => ({ kind: "upload", target, files });
  it("accepts any valid type up to 10 MB per file and 25 MB per action, and nothing malformed", () => {
    const tenMb = zeros(WORKSPACE_MAX_UPLOAD_BYTES);
    expect(validateDomAction(action({ name: "cv.docx", mimeType: "application/msword", base64: tenMb }))).not.toBeNull();
    expect(validateDomAction(action({ name: "x", mimeType: "application/octet-stream", base64: zeros(WORKSPACE_MAX_UPLOAD_BYTES + 1) }))).toBeNull();
    expect(validateDomAction(action(...Array.from({ length: 3 }, () => ({ name: "a.bin", mimeType: "application/octet-stream", base64: tenMb }))))).toBeNull();
    for (const file of [
      { name: "a.bin", mimeType: "not a type", base64: "AAAA" },
      { name: "a/b.bin", mimeType: "application/octet-stream", base64: "AAAA" },
      { name: "a.bin", mimeType: "application/octet-stream", base64: "" },
      { name: "a.bin", mimeType: "application/octet-stream", base64: "AAA" },
      { name: "a.bin", mimeType: "application/octet-stream", base64: "AAAA", extra: 1 },
    ]) expect(validateDomAction(action(file)), JSON.stringify(file)).toBeNull();
  });
});

describe("fitting an image for the model in the background page", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Fake canvas APIs: a decoded image of `width`×`height`, and the size each canvas drew at. */
  function stubCanvas(width: number, height: number, decodes = true) {
    const drawn: { width: number; height: number; type?: string }[] = [];
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      if (!decodes) throw new DOMException("bad image", "InvalidStateError");
      return { width, height, close };
    }));
    vi.stubGlobal("OffscreenCanvas", class {
      constructor(readonly width: number, readonly height: number) {}
      getContext() { return { fillRect: vi.fn(), drawImage: vi.fn(), set fillStyle(_: string) {} }; }
      async convertToBlob(options: { type: string }) {
        drawn.push({ width: this.width, height: this.height, type: options.type });
        return new Blob([new Uint8Array([1, 2, 3])], { type: options.type });
      }
    });
    return { drawn, close };
  }

  it("scales a large image to 1600 px on its longest side as JPEG, and leaves a small light one alone", async () => {
    const { drawn, close } = stubCanvas(4000, 3000);
    expect(await scaleImageInPage({ mimeType: "image/png", data: "iVBORw0KGgo=" }, 1600)).toEqual({ mimeType: "image/jpeg", data: "AQID", width: 1600, height: 1200 });
    expect(drawn).toEqual([{ width: 1600, height: 1200, type: "image/jpeg" }]);
    expect(close).toHaveBeenCalled();

    const small = stubCanvas(800, 600);
    expect(await scaleImageInPage({ mimeType: "image/webp", data: "iVBORw0KGgo=" }, 1600)).toEqual({ mimeType: "image/webp", data: "iVBORw0KGgo=", width: 800, height: 600 });
    expect(small.drawn).toEqual([]);
  });

  it("fails with a safe message when the image cannot be decoded or there is no canvas", async () => {
    stubCanvas(1, 1, false);
    await expect(scaleImageInPage({ mimeType: "image/png", data: "AAAA" }, 1600)).rejects.toThrow(ImageScaleError);
    vi.unstubAllGlobals();
    vi.stubGlobal("OffscreenCanvas", undefined);
    await expect(scaleImageInPage({ mimeType: "image/png", data: "AAAA" }, 1600)).rejects.toThrow("Images cannot be decoded here.");
  });
});
