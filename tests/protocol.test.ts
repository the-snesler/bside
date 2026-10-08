import { describe, expect, it } from "vitest";
import { validateDomAction } from "@/lib/validation";
import {
  isCredentialRequest,
  isPageExecuteRequest,
  isPageFindRequest,
  isPageHealthRequest,
  isPageSnapshotRequest,
  isSettingsRequest,
  isSidebarCommand,
} from "@/lib/protocol";

describe("isSidebarCommand: accepts every valid variant", () => {
  it("accepts state.subscribe with a null lastSeq", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "state.subscribe", lastSeq: null })).toBe(true);
  });

  it("accepts state.subscribe with a numeric lastSeq", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "state.subscribe", lastSeq: 42 })).toBe(true);
  });

  it("accepts run.start", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.start", prompt: "Hi" })).toBe(true);
  });

  it("accepts run.cancel", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.cancel", runId: "r1" })).toBe(true);
  });

  it("accepts action.approve and action.deny", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "action.approve", runId: "r1", callId: "c1" })).toBe(true);
    expect(isSidebarCommand({ v: 1, id: "1", type: "action.deny", runId: "r1", callId: "c1" })).toBe(true);
  });
});

describe("isSidebarCommand: rejects malformed input", () => {
  it("rejects a non-object value", () => {
    expect(isSidebarCommand(null)).toBe(false);
    expect(isSidebarCommand(undefined)).toBe(false);
    expect(isSidebarCommand("run.start")).toBe(false);
    expect(isSidebarCommand(42)).toBe(false);
    expect(isSidebarCommand([])).toBe(false);
  });

  it("rejects a wrong envelope version", () => {
    expect(isSidebarCommand({ v: 2, id: "1", type: "run.start", prompt: "Hi" })).toBe(false);
  });

  it("rejects a missing or non-string id", () => {
    expect(isSidebarCommand({ v: 1, type: "run.start", prompt: "Hi" })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: 1, type: "run.start", prompt: "Hi" })).toBe(false);
  });

  it("rejects an unknown command type", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.retry" })).toBe(false);
  });

  it("rejects state.subscribe with a non-numeric, non-null lastSeq", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "state.subscribe", lastSeq: "5" })).toBe(false);
  });

  it("rejects run.start with a non-string prompt", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.start", prompt: 5 })).toBe(false);
  });

  it("rejects run.start with a missing prompt", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.start" })).toBe(false);
  });

  it("rejects run.cancel with a missing runId", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.cancel" })).toBe(false);
  });

  it("rejects action.approve missing callId", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "action.approve", runId: "r1" })).toBe(false);
  });

  it("rejects action.deny with a non-string runId", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "action.deny", runId: 1, callId: "c1" })).toBe(false);
  });
});

describe("isCredentialRequest: accepts every valid variant, rejects malformed input", () => {
  it("accepts status/save/delete", () => {
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.status" })).toBe(true);
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.save", apiKey: "sk-test" })).toBe(true);
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.delete" })).toBe(true);
  });

  it("accepts ChatGPT account actions only with a valid PIN where required", () => {
    for (const action of ["login", "unlock"]) {
      const request = { v: 1, id: "1", type: `credentials.chatgpt.${action}`, pin: "12345678" };
      expect(isCredentialRequest(request)).toBe(true);
      expect(isSidebarCommand(request)).toBe(false);
      for (const pin of [undefined, 12345678, "1234567", "abcd1234", "1".repeat(65)])
        expect(isCredentialRequest({ ...request, pin })).toBe(false);
    }
    for (const action of ["lock", "disconnect", "test"]) {
      const request = { v: 1, id: "1", type: `credentials.chatgpt.${action}` };
      expect(isCredentialRequest(request)).toBe(true);
      expect(isSidebarCommand(request)).toBe(false);
    }
  });

  it("rejects save with a missing apiKey", () => {
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.save" })).toBe(false);
  });

  it("rejects save with a non-string apiKey", () => {
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.save", apiKey: 12345 })).toBe(false);
  });

  it("rejects a wrong envelope version", () => {
    expect(isCredentialRequest({ v: 2, id: "1", type: "credentials.openai.status" })).toBe(false);
  });

  it("rejects an unknown request type", () => {
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.export" })).toBe(false);
  });
});

describe("isSettingsRequest: accepts every valid variant, rejects malformed input", () => {
  const settings = { version: 1 as const, providerId: "openai" as const, modelId: "gpt-5.6-terra", reasoningEffort: "medium" as const };

  it("accepts get and save", () => {
    expect(isSettingsRequest({ v: 1, id: "1", type: "settings.get" })).toBe(true);
    expect(isSettingsRequest({ v: 1, id: "1", type: "settings.save", settings })).toBe(true);
  });

  it("rejects save with a null settings payload", () => {
    expect(isSettingsRequest({ v: 1, id: "1", type: "settings.save", settings: null })).toBe(false);
  });

  it("rejects save with a non-object settings payload", () => {
    expect(isSettingsRequest({ v: 1, id: "1", type: "settings.save", settings: "gpt-5.6-terra" })).toBe(false);
  });

  it("rejects save with a missing settings field", () => {
    expect(isSettingsRequest({ v: 1, id: "1", type: "settings.save" })).toBe(false);
  });

  it("rejects an unknown request type", () => {
    expect(isSettingsRequest({ v: 1, id: "1", type: "settings.reset" })).toBe(false);
  });
});

describe("isPageHealthRequest: accepts valid, rejects malformed input", () => {
  it("accepts a well-formed health request", () => {
    expect(isPageHealthRequest({ v: 1, id: "1", type: "page.health" })).toBe(true);
  });

  it("rejects the wrong envelope type", () => {
    expect(isPageHealthRequest({ v: 1, id: "1", type: "page.snapshot" })).toBe(false);
  });

  it("rejects a non-object value", () => {
    expect(isPageHealthRequest(null)).toBe(false);
    expect(isPageHealthRequest("page.health")).toBe(false);
  });
});

describe("isPageSnapshotRequest: accepts valid, rejects malformed input", () => {
  const valid = { v: 1, id: "1", type: "page.snapshot", tabId: 1, offset: 0, maxChars: 16000 };

  it("accepts a bounded slice request", () => {
    expect(isPageSnapshotRequest(valid)).toBe(true);
    expect(isPageSnapshotRequest({ ...valid, offset: 32000, maxChars: 40000 })).toBe(true);
  });

  it("rejects missing or non-numeric tab ids", () => {
    expect(isPageSnapshotRequest({ ...valid, tabId: undefined })).toBe(false);
    expect(isPageSnapshotRequest({ ...valid, tabId: "1" })).toBe(false);
  });

  it("rejects unbounded or malformed slices", () => {
    expect(isPageSnapshotRequest({ ...valid, maxChars: 40001 })).toBe(false);
    expect(isPageSnapshotRequest({ ...valid, maxChars: 10 })).toBe(false);
    expect(isPageSnapshotRequest({ ...valid, offset: -1 })).toBe(false);
    expect(isPageSnapshotRequest({ ...valid, offset: 1.5 })).toBe(false);
  });
});

describe("isPageFindRequest", () => {
  it("accepts bounded non-empty queries only", () => {
    expect(isPageFindRequest({ v: 1, id: "1", type: "page.find", tabId: 1, query: "User Score" })).toBe(true);
    expect(isPageFindRequest({ v: 1, id: "1", type: "page.find", tabId: 1, query: "  " })).toBe(false);
    expect(isPageFindRequest({ v: 1, id: "1", type: "page.find", tabId: 1, query: "x".repeat(201) })).toBe(false);
  });
});

describe("isPageExecuteRequest: accepts the closed action union only", () => {
  const ref = { kind: "ref", ref: "e1", documentId: "doc-1" };
  const execute = (action: unknown) => ({ v: 1, id: "1", type: "page.execute", tabId: 1, action });

  it("accepts every action kind with ref and role targets", () => {
    for (const action of [
      { kind: "click", target: ref },
      { kind: "click", target: { kind: "role", role: "button", name: "Save", exact: false } },
      { kind: "click", target: { kind: "role", role: "textbox", name: null, exact: false } },
      { kind: "fill", target: ref, text: "x" },
      { kind: "select", target: ref, values: ["us"] },
      { kind: "check", target: ref, checked: true },
      { kind: "press", target: ref, key: "Enter" },
      { kind: "upload", target: ref, files: [{ name: "a.txt", mimeType: "text/plain", text: "hi" }] },
      { kind: "scroll", target: null, direction: "down", amount: "page" },
    ]) expect(validateDomAction(action), JSON.stringify(action)).not.toBeNull();
    expect(isPageExecuteRequest(execute({ kind: "click", target: ref }))).toBe(true);
  });

  it("rejects unknown kinds, extra keys, selectors, and malformed targets", () => {
    for (const action of [
      { kind: "evaluate", target: ref, script: "alert(1)" },
      { kind: "click", target: ref, extra: true },
      { kind: "click", target: { kind: "css", selector: "#email" } },
      { kind: "click", target: { kind: "ref", ref: "#email", documentId: "doc" } },
      { kind: "click", target: { kind: "ref", ref: "e1" } },
      { kind: "press", target: ref, key: "F12" },
      { kind: "upload", target: ref, files: [{ name: "../etc/passwd", mimeType: "text/plain", text: "" }] },
      { kind: "upload", target: ref, files: [] },
      { kind: "select", target: ref, values: [] },
      { kind: "fill", target: ref, text: "x".repeat(16_001) },
    ]) expect(validateDomAction(action), JSON.stringify(action)).toBeNull();
    expect(isPageExecuteRequest(execute({ kind: "click" }))).toBe(false);
    expect(isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", action: { kind: "click", target: ref } })).toBe(false);
  });
});
