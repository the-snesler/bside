import { describe, expect, it } from "vitest";
import { buildProblemReport, type ProblemRun } from "@/lib/domain/problem-report";
import type { Conversation } from "@/lib/domain/conversation";
import { isContentMessage, isOptionsSender, isProblemReportRequest, isSidebarCommand } from "@/lib/protocol";

const privateText = "PAGE_PRIVATE_Orchid sk-fixture-secret https://alice:password@example.test/private?token=fixture#secret";

describe("local problem reports", () => {
  it("exports an allowlist of metadata, excluding text in every record and nested diagnostic field", () => {
    // Unknown future fields deliberately carry sensitive text too: adding a
    // field to raw exports must not silently add it to this report.
    const conversation = { id: privateText, title: privateText, lastModelId: privateText, items: [
      { kind: "message", role: "user", text: privateText, skill: { body: privateText }, context: { url: privateText }, sites: [{ text: privateText }], content: [{ version: 1, kind: "resource", name: "MCP_PRIVATE_NAME", uri: "mcp-private://document", text: "MCP_PRIVATE_BODY", arguments: privateText }] },
      { kind: "message", role: "assistant", text: privateText },
      { kind: "tool-call", call: { name: privateText, arguments: { source: privateText } } },
      { kind: "tool-result", result: { summary: privateText }, memory: [{ name: privateText }] },
      { kind: "run-digest", digest: { error: privateText, entries: [{ source: privateText, excerpt: privateText, urls: [privateText] }] } },
      { kind: "compaction", summary: privateText },
    ] } as unknown as Conversation;
    const run = { startedAt: 100, endedAt: 250, status: "failed", providerResponses: 3,
      error: { code: "TIMEOUT", status: 504, retryable: true, message: privateText, requestId: privateText },
      usage: { input: 100, output: 25, cacheRead: 50, cacheWrite: 0, totalTokens: 175, extra: privateText },
      modelId: privateText, runId: privateText, toolCalls: [{ name: privateText, callId: privateText, code: privateText,
        durationMs: 20, ok: false, outputChars: 500, truncatedOutput: true, output: privateText }],
    } as unknown as ProblemRun;
    const text = buildProblemReport(conversation, run, "0.1.0");
    for (const secret of ["Orchid", "sk-fixture", "https:", "password", "example.test", "private?", "PAGE_PRIVATE", "MCP_PRIVATE_NAME", "mcp-private://", "MCP_PRIVATE_BODY"]) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ contentIncluded: false, extensionVersion: "0.1.0",
      conversation: { itemCounts: { message: 2, "tool-call": 1, compaction: 1 } },
      latestRun: { durationMs: 150, providerResponses: 3, error: { code: "TIMEOUT", status: 504 },
        tokens: { input: 100, output: 25 }, toolCalls: [{ code: "OTHER", durationMs: 20, outputChars: 500 }] } });
    expect(JSON.parse(buildProblemReport(conversation, null, privateText))).toMatchObject({ extensionVersion: "unknown", latestRun: null });
  });

  it("validates the closed request shape and accepts no include-content bypass", () => {
    expect(isProblemReportRequest({ v: 1, id: "1", type: "problemReport.list" })).toBe(true);
    const valid = { v: 1, id: "1", type: "problemReport.export", sessionId: "session-1" };
    expect(isProblemReportRequest(valid)).toBe(true);
    for (const invalid of [{ ...valid, v: 2 }, { ...valid, sessionId: "../x" }, { ...valid, includeContent: true }, { ...valid, sessionId: null }, { ...valid, type: "context.export" }]) {
      expect(isProblemReportRequest(invalid)).toBe(false);
    }
    expect(isSidebarCommand(valid)).toBe(false);
    expect(isContentMessage(valid)).toBe(false);
  });

  it("accepts options hash routes only from this extension", () => {
    const url = "moz-extension://fixture/options.html";
    expect(isOptionsSender({ id: "bside", url: `${url}#/history` }, "bside", url)).toBe(true);
    for (const sender of [
      { id: "other", url }, { id: "bside", url: `${url}?query` },
      { id: "bside", url: "https://example.test/options.html" },
      { id: "bside", url: "moz-extension://fixture/sidepanel.html" },
      { id: "bside", url: "moz-extension://fixture/onboarding.html" }, { id: "bside" },
    ]) expect(isOptionsSender(sender, "bside", url)).toBe(false);
  });
});
