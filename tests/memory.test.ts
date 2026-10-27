import { beforeEach, describe, expect, it } from "vitest";
import { storage } from "wxt/utils/storage";
import { forgetAllMemories, forgetMemory, listMemories, undoMemoryChanges, writeMemory } from "@/lib/background/memory";
import {
  findSecret, isMemoryDraft, isMemoryEntry, MAX_MEMORIES, MemoryError, MEMORY_INDEX_CHARS, parseMemoryFile, renderMemoryFile, renderMemoryIndex, searchMemories,
  type MemoryEntry,
} from "@/lib/domain/memory";
import { getMemorySettings, loadMemories, saveMemorySettings } from "@/lib/storage";

const source = { sessionId: "s1", runId: "r1", tainted: false };
const draft = (name: string, description = `About ${name}`, body = "") => ({ name, description, body });

function entry(name: string, at: number, options: Partial<MemoryEntry> & { tainted?: boolean } = {}): MemoryEntry {
  return {
    name, description: options.description ?? `About ${name}`, body: options.body ?? "", createdAt: at,
    provenance: { by: "agent", sessionId: "s1", runId: "r1", at, tainted: options.tainted ?? false },
  };
}

beforeEach(() => { fakeBrowser.reset(); });

describe("memory entries", () => {
  it("bounds names, descriptions, and bodies", () => {
    expect(isMemoryDraft(draft("coffee-order", "Usual order", "Oat flat white"))).toBe(true);
    expect(isMemoryDraft(draft("a".repeat(48)))).toBe(true);
    expect(isMemoryDraft({ ...draft("x"), body: "b".repeat(2_000) })).toBe(true);
    for (const bad of [draft("Coffee"), draft("-x"), draft("a".repeat(49)), draft("a/b"), draft("x", ""), draft("x", "two\nlines"),
      draft("x", "d".repeat(161)), { ...draft("x"), body: "b".repeat(2_001) }, { ...draft("x"), extra: 1 }]) expect(isMemoryDraft(bad)).toBe(false);
    expect(isMemoryEntry(entry("x", 1))).toBe(true);
    expect(isMemoryEntry({ ...entry("x", 1), provenance: { by: "user", at: 1 } })).toBe(true);
    expect(isMemoryEntry({ ...entry("x", 1), provenance: { by: "agent", at: 1 } })).toBe(false);
  });

  it("reads the file format: the first line is the description, the rest the body", () => {
    expect(parseMemoryFile("trip", "# Trip dates\nFlying out May 3.\n\nBack May 9.\n")).toEqual({ name: "trip", description: "Trip dates", body: "Flying out May 3.\n\nBack May 9." });
    expect(parseMemoryFile("units", "Prefers metric units")).toEqual({ name: "units", description: "Prefers metric units", body: "" });
    expect(parseMemoryFile("x", "\nbody")).toMatch(/description/);
    expect(parseMemoryFile("x", `${"d".repeat(161)}\nbody`)).toMatch(/160/);
    expect(parseMemoryFile("x", `d\n${"b".repeat(2_001)}`)).toMatch(/2000/);
    expect(renderMemoryFile({ name: "trip", description: "Trip dates", body: "May 3" })).toBe("Trip dates\nMay 3");
  });
});

describe("secret validator", () => {
  it.each([
    ["sk-proj-" + "Ab3dEf6hIj9kLm2nOp5q", "an API key"],
    ["key: sk_live_51Hx9ZqK2eZvKYlo2C0aBcDeF", "an API key"],
    ["ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", "an access token"],
    ["AKIAIOSFODNN7EXAMPLE", "an access token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "a login token (JWT)"],
    ["Card 4111 1111 1111 1111 exp 04/29", "a payment card number"],
    ["4242-4242-4242-4242", "a payment card number"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=", "a private key"],
    ["token=Zx8Qw2Er4Ty6Ui8Op0As2Df4Gh6Jk8Lz", "a long secret token"],
  ])("refuses %s", (text, label) => {
    expect(findSecret(text)).toBe(label);
  });

  it.each([
    "Prefers window seats; frequent flyer with Lufthansa.",
    "Order 1234 5678 9012 3456 arrives Tuesday",
    "Call +1 555-123-4567 after 5pm",
    "See https://github.com/the-snesler/bside/pull/9 and the sk-learn-pipeline-tips doc",
    "Session 3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f",
    "a-very-long-hyphenated-project-name-without-any-digits-at-all",
  ])("accepts %s", (text) => {
    expect(findSecret(text)).toBeNull();
  });
});

describe("memory search", () => {
  const entries = [
    entry("coffee-order", 3, { description: "Usual coffee order", body: "Oat flat white, no sugar." }),
    entry("flight-prefs", 2, { description: "How the user likes to fly", body: "Window seat. Avoid red-eye flights; coffee on board is fine." }),
    entry("kids", 1, { description: "Family", body: "Two kids, ages 4 and 7.", tainted: true }),
  ];

  it("ranks name over description over body, and entries matching every word first", () => {
    expect(searchMemories(entries, "coffee").map((hit) => hit.name)).toEqual(["coffee-order", "flight-prefs"]);
    expect(searchMemories(entries, "window coffee").map((hit) => hit.name)).toEqual(["flight-prefs", "coffee-order"]);
    expect(searchMemories(entries, "flights")[0]).toMatchObject({ path: "/memory/flight-prefs.md", tainted: false, excerpt: expect.stringContaining("red-eye flights") });
    expect(searchMemories(entries, "kid")[0]).toMatchObject({ name: "kids", tainted: true });
    expect(searchMemories(entries, "zebra")).toEqual([]);
    expect(searchMemories(entries, "  ")).toEqual([]);
    expect(searchMemories(entries, "o", 1)).toHaveLength(1);
  });
});

describe("memory index", () => {
  it("lists paths and descriptions newest first, labels tainted entries, and states the policy", () => {
    const index = renderMemoryIndex([entry("old", 1), entry("new", 2, { tainted: true })], "ask")!;
    expect(index).toContain("not the user's instructions");
    expect(index.indexOf("/memory/new.md (saved after reading web content)")).toBeLessThan(index.indexOf("/memory/old.md: \"About old\""));
    expect(index).toContain("approve each save");
    expect(renderMemoryIndex([], "auto")).toBeNull();
    expect(renderMemoryIndex([], "off")).toContain("do not write or remove memories");
  });

  it("lists the most recently updated subset within its budget and points to memory.search", () => {
    const many = Array.from({ length: MAX_MEMORIES }, (_, n) => entry(`entry-${n}`, n, { description: `Description ${"x".repeat(100)} ${n}` }));
    const index = renderMemoryIndex(many, "auto")!;
    const lines = index.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.join("\n").length).toBeLessThanOrEqual(MEMORY_INDEX_CHARS);
    expect(lines[0]).toContain("/memory/entry-199.md");
    expect(index).toContain(`(${MAX_MEMORIES - lines.length} older memories are not listed; find them with memory.search("words")`);
    // Deterministic for the same entries, in any stored order.
    expect(renderMemoryIndex(many.toReversed(), "auto")).toBe(index);
  });
});

describe("memory storage", () => {
  it("drops malformed slots and later duplicates of a name", async () => {
    await storage.setItem("local:memory:0", { version: 1, ...entry("a", 1) });
    await storage.setItem("local:memory:1", { version: 1, ...entry("a", 2) });
    await storage.setItem("local:memory:2", { version: 2, ...entry("b", 1) });
    await storage.setItem("local:memory:3", { version: 1, ...entry("c", 1), body: "b".repeat(2_001) });
    await storage.setItem("local:memory:4", { version: 1, ...entry("d", 1) });
    expect((await loadMemories()).map(({ slot, entry }) => [slot, entry.name])).toEqual([[0, "a"], [4, "d"]]);
    for (const slot of [1, 2, 3]) expect(await storage.getItem(`local:memory:${slot}`)).toBeNull();
  });

  it("defaults the write policy to auto and resets a malformed record", async () => {
    expect(await getMemorySettings()).toEqual({ version: 1, writes: "auto" });
    await saveMemorySettings({ version: 1, writes: "ask" });
    expect(await getMemorySettings()).toEqual({ version: 1, writes: "ask" });
    await storage.setItem("local:memorySettings", { version: 1, writes: "sometimes" });
    expect(await getMemorySettings()).toEqual({ version: 1, writes: "auto" });
    expect(await storage.getItem("local:memorySettings")).toBeNull();
  });
});

describe("memory changes", () => {
  it("saves with provenance, replaces in place keeping the creation time, and removes", async () => {
    const first = await writeMemory(draft("coffee", "Usual order", "Oat flat white"), source, 100);
    expect(first).toMatchObject({ op: "write", name: "coffee", tainted: false });
    const second = await writeMemory(draft("coffee", "Usual order", "Oat cortado"), { sessionId: "s2", runId: "r2", tainted: true }, 200);
    expect(second.tainted).toBe(true);
    const slots = await loadMemories();
    expect(slots).toHaveLength(1);
    expect(slots[0]!.entry).toEqual({ name: "coffee", description: "Usual order", body: "Oat cortado", createdAt: 100,
      provenance: { by: "agent", sessionId: "s2", runId: "r2", at: 200, tainted: true } });
    expect((await forgetMemory("coffee", source)).op).toBe("remove");
    expect(await listMemories()).toEqual([]);
    await expect(forgetMemory("coffee", source)).rejects.toThrow("/memory/coffee.md does not exist");
  });

  it("refuses secrets and invalid drafts without saving and without echoing the secret", async () => {
    const error = await writeMemory(draft("key", "OpenAI key", "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs"), source).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as Error).message).toContain("looks like it contains an API key");
    expect((error as Error).message).not.toContain("Ab3dEf6");
    await expect(writeMemory(draft("Bad Name"), source)).rejects.toThrow("Invalid memory");
    expect(await listMemories()).toEqual([]);
  });

  it("holds at most 200 entries", async () => {
    for (let n = 0; n < MAX_MEMORIES; n++) await storage.setItem(`local:memory:${n}`, { version: 1, ...entry(`m-${n}`, n) });
    const error = await writeMemory(draft("one-more"), source).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ limit: true, message: expect.stringContaining("Memory is full (200 entries)") });
    await writeMemory(draft("m-5", "Replaced"), source);
    expect((await listMemories()).find((item) => item.name === "m-5")?.description).toBe("Replaced");
  });

  it("undoes run changes newest first, only while the entry is as the change left it", async () => {
    const created = await writeMemory(draft("trip", "Trip", "May 3"), source, 1);
    const replaced = await writeMemory(draft("trip", "Trip", "May 4"), source, 2);
    expect(await undoMemoryChanges([created.id, replaced.id])).toEqual({ undone: [replaced.id, created.id], error: null });
    expect(await listMemories()).toEqual([]);

    const saved = await writeMemory(draft("seat", "Seat", "Window"), source, 3);
    const removed = await forgetMemory("seat", source);
    expect((await undoMemoryChanges([removed.id])).undone).toEqual([removed.id]);
    expect((await listMemories())[0]?.body).toBe("Window");

    // A later change wins: the save is no longer what the entry holds.
    await writeMemory(draft("seat", "Seat", "Aisle"), source, 4);
    expect(await undoMemoryChanges([saved.id])).toEqual({ undone: [], error: expect.stringContaining("changed since") });
    expect((await listMemories())[0]?.body).toBe("Aisle");
    expect(await undoMemoryChanges(["unknown"])).toEqual({ undone: [], error: expect.stringContaining("can no longer be undone") });
  });

  it("forgets everything, undo history included", async () => {
    const change = await writeMemory(draft("a"), source);
    await writeMemory(draft("b"), source);
    await forgetAllMemories();
    expect(await listMemories()).toEqual([]);
    expect((await undoMemoryChanges([change.id])).undone).toEqual([]);
  });
});
