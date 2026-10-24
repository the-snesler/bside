import { describe, expect, it } from "vitest";
import { validateDomAction } from "@/lib/validation";
import {
  isContentMessage,
  isContentMessageResponse,
  isCredentialRequest,
  isHistoryRequest,
  isPageExecuteRequest,
  isPageFindRequest,
  isPageHealthRequest,
  isPageCaptureDoneRequest,
  isPageCapturePrepareRequest,
  isPageShieldRequest,
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

  it("accepts run.steer and the queue commands only with their fields", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.steer", runId: "r1", text: "Use tab 2" })).toBe(true);
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.steer", text: "Use tab 2" })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.steer", runId: "r1", text: 5 })).toBe(false);
    for (const type of ["queue.remove", "queue.send"]) {
      expect(isSidebarCommand({ v: 1, id: "1", type, sessionId: "s1", messageId: "m1" })).toBe(true);
      expect(isSidebarCommand({ v: 1, id: "1", type, sessionId: "../s1", messageId: "m1" })).toBe(false);
      expect(isSidebarCommand({ v: 1, id: "1", type, sessionId: "s1" })).toBe(false);
    }
  });

  it("accepts run.retry, which carries no prompt", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.retry" })).toBe(true);
  });

  it("accepts run.cancel", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.cancel", runId: "r1" })).toBe(true);
  });

  it("accepts action.approve and action.deny", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "action.approve", runId: "r1", callId: "c1" })).toBe(true);
    expect(isSidebarCommand({ v: 1, id: "1", type: "action.deny", runId: "r1", callId: "c1" })).toBe(true);
  });

  it("accepts tabs.watch only for an integer tab id, and tabs.unwatch with no arguments", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.watch", tabId: 5 })).toBe(true);
    for (const tabId of [undefined, "5", 1.5, Number.NaN, null]) {
      expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.watch", tabId })).toBe(false);
    }
    expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.unwatch" })).toBe(true);
    expect(isSidebarCommand({ v: 2, id: "1", type: "tabs.unwatch" })).toBe(false);
  });

  it("accepts tabs.takeOver only for an integer tab id", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.takeOver", tabId: 5 })).toBe(true);
    for (const tabId of [undefined, "5", 1.5, null]) {
      expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.takeOver", tabId })).toBe(false);
    }
  });

  it("accepts help.resolve only with a known outcome and a bounded note", () => {
    const resolve = { v: 1, id: "1", type: "help.resolve", runId: "r1", callId: "c1", outcome: "done", note: "" };
    expect(isSidebarCommand(resolve)).toBe(true);
    expect(isSidebarCommand({ ...resolve, outcome: "unable", note: "No account here." })).toBe(true);
    expect(isSidebarCommand({ ...resolve, outcome: "approved" })).toBe(false);
    expect(isSidebarCommand({ ...resolve, note: "x".repeat(501) })).toBe(false);
    expect(isSidebarCommand({ ...resolve, note: undefined })).toBe(false);
    expect(isSidebarCommand({ ...resolve, callId: undefined })).toBe(false);
    expect(isSidebarCommand({ ...resolve, runId: 5 })).toBe(false);
  });

  it("accepts tabs.closeAgentTabs only in a v1 envelope naming a session", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.closeAgentTabs", sessionId: "s1" })).toBe(true);
    expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.closeAgentTabs" })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "1", type: "tabs.closeAgentTabs", sessionId: "../x" })).toBe(false);
    expect(isSidebarCommand({ v: 2, id: "1", type: "tabs.closeAgentTabs", sessionId: "s1" })).toBe(false);
    expect(isSidebarCommand({ v: 1, type: "tabs.closeAgentTabs", sessionId: "s1" })).toBe(false);
  });

  it("accepts every session command", () => {
    const sessionId = crypto.randomUUID();
    for (const command of [
      { type: "session.create" }, { type: "session.list" }, { type: "session.open", sessionId }, { type: "session.delete", sessionId: "default", closeAgentTabs: true },
      { type: "session.delete", sessionId, closeAgentTabs: false },
      { type: "session.rename", sessionId, title: "Trip plans" }, { type: "session.pin", sessionId, pinned: false },
    ]) expect(isSidebarCommand({ v: 1, id: "1", ...command })).toBe(true);
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
    expect(isSidebarCommand({ v: 1, id: "1", type: "run.resume" })).toBe(false);
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

  it("rejects run.retry with a wrong envelope", () => {
    expect(isSidebarCommand({ v: 2, id: "1", type: "run.retry" })).toBe(false);
    expect(isSidebarCommand({ v: 1, type: "run.retry" })).toBe(false);
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

  it("accepts context.export only for a valid session id", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "context.export", sessionId: "default" })).toBe(true);
    for (const sessionId of [undefined, null, "", "../x"]) expect(isSidebarCommand({ v: 1, id: "1", type: "context.export", sessionId })).toBe(false);
  });

  it("rejects the removed context.reset command", () => {
    expect(isSidebarCommand({ v: 1, id: "1", type: "context.reset" })).toBe(false);
  });

  it("rejects session commands with a malformed session id, title, or pinned flag", () => {
    for (const sessionId of [undefined, 7, "", "../x", "a b", "x".repeat(65)]) {
      expect(isSidebarCommand({ v: 1, id: "1", type: "session.open", sessionId })).toBe(false);
      expect(isSidebarCommand({ v: 1, id: "1", type: "session.delete", sessionId, closeAgentTabs: true })).toBe(false);
    }
    for (const closeAgentTabs of [undefined, "yes", 1, null]) {
      expect(isSidebarCommand({ v: 1, id: "1", type: "session.delete", sessionId: "s1", closeAgentTabs })).toBe(false);
    }
    expect(isSidebarCommand({ v: 1, id: "1", type: "session.rename", sessionId: "s1" })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "1", type: "session.rename", sessionId: "s1", title: 5 })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "1", type: "session.rename", sessionId: "s1", title: "x".repeat(10_000) })).toBe(false);
    expect(isSidebarCommand({ v: 1, id: "1", type: "session.pin", sessionId: "s1", pinned: "yes" })).toBe(false);
    expect(isSidebarCommand({ v: 2, id: "1", type: "session.create" })).toBe(false);
  });
});

describe("isHistoryRequest: accepts every valid variant, rejects malformed input", () => {
  it("accepts get, each retention, and delete-all", () => {
    expect(isHistoryRequest({ v: 1, id: "1", type: "history.get" })).toBe(true);
    expect(isHistoryRequest({ v: 1, id: "1", type: "history.deleteAll" })).toBe(true);
    for (const retention of ["forever", "30d", "7d"]) expect(isHistoryRequest({ v: 1, id: "1", type: "history.retention.save", retention })).toBe(true);
  });

  it("rejects unknown retentions, wrong envelopes, and sidebar commands", () => {
    for (const retention of [undefined, "1d", 7, null]) expect(isHistoryRequest({ v: 1, id: "1", type: "history.retention.save", retention })).toBe(false);
    expect(isHistoryRequest({ v: 2, id: "1", type: "history.deleteAll" })).toBe(false);
    expect(isHistoryRequest({ v: 1, type: "history.get" })).toBe(false);
    expect(isHistoryRequest({ v: 1, id: "1", type: "session.delete", sessionId: "s1" })).toBe(false);
    // History deletion is options-page only, never a sidebar Port command.
    expect(isSidebarCommand({ v: 1, id: "1", type: "history.deleteAll" })).toBe(false);
  });
});

describe("isCredentialRequest: accepts every valid variant, rejects malformed input", () => {
  it("accepts status/save/delete", () => {
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.status" })).toBe(true);
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.save", apiKey: "sk-test" })).toBe(true);
    expect(isCredentialRequest({ v: 1, id: "1", type: "credentials.openai.delete" })).toBe(true);
  });

  it("accepts ChatGPT account actions only from the options channel and has no PIN commands", () => {
    for (const action of ["login", "disconnect", "test", "notice.dismiss"]) {
      const request = { v: 1, id: "1", type: `credentials.chatgpt.${action}` };
      expect(isCredentialRequest(request)).toBe(true);
      expect(isSidebarCommand(request)).toBe(false);
    }
    for (const action of ["unlock", "lock"])
      expect(isCredentialRequest({ v: 1, id: "1", type: `credentials.chatgpt.${action}`, pin: "12345678" })).toBe(false);
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
      { kind: "upload", target: ref, files: [{ name: "a.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }] },
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
      { kind: "upload", target: ref, files: [{ name: "a.png", mimeType: "image/jpeg", base64: "iVBORw0KGgo=" }] },
      { kind: "upload", target: ref, files: [{ name: "a.exe", mimeType: "application/octet-stream", base64: "iVBORw0KGgo=" }] },
      { kind: "upload", target: ref, files: [{ name: "a.png", mimeType: "image/png", base64: "not base64" }] },
      { kind: "upload", target: ref, files: [{ name: "a.png", mimeType: "image/png", base64: "A".repeat(2_000_004) }] },
      { kind: "upload", target: ref, files: [{ name: "a.png", mimeType: "image/png", base64: "iVBORw0KGgo=", text: "both" }] },
      { kind: "select", target: ref, values: [] },
      { kind: "fill", target: ref, text: "x".repeat(16_001) },
    ]) expect(validateDomAction(action), JSON.stringify(action)).toBeNull();
    expect(isPageExecuteRequest(execute({ kind: "click" }))).toBe(false);
    expect(isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", action: { kind: "click", target: ref } })).toBe(false);
  });
});

describe("page shield messages", () => {
  it("accepts a shield request only with a tab id and a known state", () => {
    for (const shield of ["off", "working", "idle"]) {
      expect(isPageShieldRequest({ v: 1, id: "1", type: "page.shield", tabId: 3, shield })).toBe(true);
    }
    expect(isPageShieldRequest({ v: 1, id: "1", type: "page.shield", tabId: 3, shield: "on" })).toBe(false);
    expect(isPageShieldRequest({ v: 1, id: "1", type: "page.shield", shield: "off" })).toBe(false);
    expect(isPageShieldRequest({ v: 1, id: "1", type: "page.shield", tabId: -1, shield: "off" })).toBe(false);
    expect(isPageShieldRequest({ v: 2, id: "1", type: "page.shield", tabId: 3, shield: "off" })).toBe(false);
  });

  it("accepts capture requests only with a tab id and a valid target or none", () => {
    const ref = { kind: "ref", ref: "e5", documentId: "doc" };
    expect(isPageCapturePrepareRequest({ v: 1, id: "1", type: "page.capture-prepare", tabId: 3, target: null })).toBe(true);
    expect(isPageCapturePrepareRequest({ v: 1, id: "1", type: "page.capture-prepare", tabId: 3, target: ref })).toBe(true);
    expect(isPageCapturePrepareRequest({ v: 1, id: "1", type: "page.capture-prepare", tabId: 3, target: { kind: "css", selector: "#x" } })).toBe(false);
    expect(isPageCapturePrepareRequest({ v: 1, id: "1", type: "page.capture-prepare", tabId: 3 })).toBe(false);
    expect(isPageCapturePrepareRequest({ v: 1, id: "1", type: "page.capture-prepare", target: null })).toBe(false);
    expect(isPageCaptureDoneRequest({ v: 1, id: "1", type: "page.capture-done", tabId: 3 })).toBe(true);
    expect(isPageCaptureDoneRequest({ v: 1, id: "1", type: "page.capture-done" })).toBe(false);
  });

  it("accepts only the two content-script messages, which name no tab", () => {
    expect(isContentMessage({ v: 1, id: "1", type: "shield.sync" })).toBe(true);
    expect(isContentMessage({ v: 1, id: "1", type: "shield.takeover" })).toBe(true);
    expect(isContentMessage({ v: 1, id: "1", type: "page.shield", tabId: 1, shield: "off" })).toBe(false);
    expect(isContentMessage({ v: 1, type: "shield.sync" })).toBe(false);
    expect(isContentMessage({ v: 1, id: "1", type: "credentials.openai.status" })).toBe(false);
  });

  it("reads a background answer only when it carries a known shield state", () => {
    expect(isContentMessageResponse({ v: 1, id: "1", ok: true, shield: "working" })).toBe(true);
    expect(isContentMessageResponse({ v: 1, id: "1", ok: true, shield: "visible" })).toBe(false);
    expect(isContentMessageResponse({ v: 1, id: "1", ok: false, shield: "off" })).toBe(false);
    expect(isContentMessageResponse(undefined)).toBe(false);
  });
});
