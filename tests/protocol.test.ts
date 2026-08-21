import { describe, expect, it } from "vitest";
import {
  isCredentialRequest,
  isPageExecuteRequest,
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
  it("accepts readable and interactive modes", () => {
    expect(isPageSnapshotRequest({ v: 1, id: "1", type: "page.snapshot", tabId: 1, mode: "readable" })).toBe(true);
    expect(isPageSnapshotRequest({ v: 1, id: "1", type: "page.snapshot", tabId: 1, mode: "interactive" })).toBe(true);
  });

  it("rejects a missing tabId", () => {
    expect(isPageSnapshotRequest({ v: 1, id: "1", type: "page.snapshot", mode: "readable" })).toBe(false);
  });

  it("rejects a non-numeric tabId", () => {
    expect(isPageSnapshotRequest({ v: 1, id: "1", type: "page.snapshot", tabId: "1", mode: "readable" })).toBe(false);
  });

  it("rejects an invalid mode", () => {
    expect(isPageSnapshotRequest({ v: 1, id: "1", type: "page.snapshot", tabId: 1, mode: "full" })).toBe(false);
  });

  it("rejects a missing mode", () => {
    expect(isPageSnapshotRequest({ v: 1, id: "1", type: "page.snapshot", tabId: 1 })).toBe(false);
  });
});

describe("isPageExecuteRequest: accepts valid, rejects malformed input", () => {
  it("accepts a well-formed execute request", () => {
    expect(
      isPageExecuteRequest({
        v: 1,
        id: "1",
        type: "page.execute",
        tabId: 1,
        call: { id: "c1", name: "page_click", arguments: { ref: "e1", revision: "rev-1" } },
      }),
    ).toBe(true);
  });

  it("rejects a missing tabId", () => {
    expect(
      isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", call: { id: "c1", name: "page_click", arguments: {} } }),
    ).toBe(false);
  });

  it("rejects a missing call", () => {
    expect(isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", tabId: 1 })).toBe(false);
  });

  it("rejects a call missing id", () => {
    expect(
      isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", tabId: 1, call: { name: "page_click", arguments: {} } }),
    ).toBe(false);
  });

  it("rejects a call missing name", () => {
    expect(isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", tabId: 1, call: { id: "c1", arguments: {} } })).toBe(false);
  });

  it("rejects a null call", () => {
    expect(isPageExecuteRequest({ v: 1, id: "1", type: "page.execute", tabId: 1, call: null })).toBe(false);
  });
});
