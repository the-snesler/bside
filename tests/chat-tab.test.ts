import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHAT_TAB_ICONS, chatHash, chatTabStatus, chatTabTitle, parseChatHash, type ChatTabState } from "@/lib/ui/chat-tab";
import type { ApprovalRequest } from "@/lib/protocol";

const idle: ChatTabState = { run: null, outcome: null, failed: false, unseen: false };
const run = (status: "running" | "awaiting-approval" | "awaiting-help" | "cancelling", pendingApproval: ApprovalRequest | null = null) => ({ status, pendingApproval, pendingHelp: null });

describe("pop-out chat tab", () => {
  it("names a chat in the hash, and reads back only a valid session id", () => {
    expect(chatHash("abc-123")).toBe("#/abc-123");
    expect(parseChatHash(chatHash("abc-123"))).toBe("abc-123");
    for (const hash of ["", "#", "#/", "#abc", "#/a/b", "#/a b", "#/../x", `#/${"a".repeat(65)}`, "#/abc\n"]) expect(parseChatHash(hash)).toBeNull();
  });

  it("shows needs you over working, then a failed or interrupted last run, then a run finished unseen, else idle", () => {
    expect(chatTabStatus(idle)).toBe("idle");
    expect(chatTabStatus({ ...idle, run: run("running") })).toBe("working");
    expect(chatTabStatus({ ...idle, run: run("cancelling") })).toBe("working");
    expect(chatTabStatus({ ...idle, run: run("awaiting-approval") })).toBe("needs-you");
    expect(chatTabStatus({ ...idle, run: run("awaiting-help") })).toBe("needs-you");
    expect(chatTabStatus({ ...idle, run: run("running", { call: { id: "c", name: "request_action_confirmation", arguments: {} }, title: "", message: "", artifact: "" } as unknown as ApprovalRequest) })).toBe("needs-you");
    // A run in progress shows over how the last one ended.
    expect(chatTabStatus({ ...idle, run: run("running"), outcome: "failed", unseen: true })).toBe("working");
    expect(chatTabStatus({ ...idle, outcome: "failed" })).toBe("failed");
    expect(chatTabStatus({ ...idle, outcome: "interrupted" })).toBe("failed");
    expect(chatTabStatus({ ...idle, failed: true, unseen: true })).toBe("failed");
    expect(chatTabStatus({ ...idle, outcome: "cancelled" })).toBe("idle");
    expect(chatTabStatus({ ...idle, outcome: "completed", unseen: true })).toBe("finished");
    expect(chatTabStatus({ ...idle, outcome: "completed" })).toBe("idle");
  });

  it("prefixes the chat's title by status, and gives each status its own icon", () => {
    expect(chatTabTitle("idle", "Trip plan")).toBe("Trip plan — bside");
    expect(chatTabTitle("working", "Trip plan")).toBe("◌ Trip plan");
    expect(chatTabTitle("needs-you", "Trip plan")).toBe("(!) Trip plan");
    expect(chatTabTitle("failed", "Trip plan")).toBe("✕ Trip plan");
    expect(chatTabTitle("finished", "Trip plan")).toBe("• Trip plan");
    expect(chatTabTitle("idle", "  ")).toBe("New chat — bside");
    // An untrusted title is kept as text: it only ever becomes a document title.
    expect(chatTabTitle("working", "<img src=x onerror=alert(1)>")).toBe("◌ <img src=x onerror=alert(1)>");
    const icons = Object.values(CHAT_TAB_ICONS);
    expect(new Set(icons).size).toBe(5);
    for (const icon of icons) {
      expect(icon).toMatch(/^\/favicon\/[a-z-]+\.svg$/);
      // A static SVG shipped in public/: no script, no external reference.
      const svg = readFileSync(`public${icon}`, "utf8");
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
      expect(svg).not.toMatch(/<script|href=|url\(/i);
    }
  });
});
