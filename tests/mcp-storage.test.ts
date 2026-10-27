import { beforeEach, describe, expect, it } from "vitest";
import { DeviceKey } from "@/lib/background/device-key";
import { MemoryDeviceKeyStore } from "@/tests/helpers/memory-key-store";
import { clipMcpError, DEFAULT_MCP_SERVER_STATE, isMcpServerState, isMcpToolName, MAX_MCP_SCHEMA_CHARS, MAX_MCP_SERVER_TOOLS, type McpServerStateV1, type McpToolInfo } from "@/lib/domain/mcp";
import { deleteMcpSecret, getMcpSecret, getMcpServerState, saveMcpSecret, saveMcpServerState } from "@/lib/storage";

const tool = (patch: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name: "search", title: null, description: "[Notion] Search pages.", inputSchema: { type: "object", properties: {} },
  readOnly: true, destructive: false, unavailable: null, ...patch,
});
const state = (patch: Partial<McpServerStateV1> = {}): McpServerStateV1 => ({ ...DEFAULT_MCP_SERVER_STATE, tools: [tool()], toolsAt: 5, ...patch });

beforeEach(() => {
  fakeBrowser.reset();
});

describe("MCP domain validators", () => {
  it("accepts a well-formed server state and the default", () => {
    expect(isMcpServerState(DEFAULT_MCP_SERVER_STATE)).toBe(true);
    expect(isMcpServerState(state({ disabled: ["search"], trust: "model", needsReauth: true, error: "Notion is temporarily unavailable." }))).toBe(true);
    expect(isMcpServerState(state({ tools: [tool({ name: "big", inputSchema: null, unavailable: "Its input schema is too large." })] }))).toBe(true);
  });

  it("rejects unknown versions, extra keys, and unknown trust levels", () => {
    expect(isMcpServerState({ ...state(), version: 2 })).toBe(false);
    expect(isMcpServerState({ ...state(), token: "secret" })).toBe(false);
    expect(isMcpServerState(state({ trust: "always" as never }))).toBe(false);
    expect(isMcpServerState(null)).toBe(false);
    expect(isMcpServerState([])).toBe(false);
  });

  it("rejects tools that are inconsistent, duplicated, or over the bounds", () => {
    expect(isMcpServerState(state({ tools: [tool({ readOnly: true, destructive: true })] }))).toBe(false);
    // An unavailable tool has no schema, and a tool with a schema is available.
    expect(isMcpServerState(state({ tools: [tool({ inputSchema: null })] }))).toBe(false);
    expect(isMcpServerState(state({ tools: [tool({ unavailable: "too large" })] }))).toBe(false);
    expect(isMcpServerState(state({ tools: [tool(), tool()] }))).toBe(false);
    expect(isMcpServerState(state({ tools: [tool({ name: "" })] }))).toBe(false);
    expect(isMcpServerState(state({ tools: [tool({ inputSchema: { description: "x".repeat(MAX_MCP_SCHEMA_CHARS) } })] }))).toBe(false);
    expect(isMcpServerState(state({ tools: [tool({ inputSchema: [] as never })] }))).toBe(false);
    expect(isMcpServerState(state({ tools: Array.from({ length: MAX_MCP_SERVER_TOOLS + 1 }, (_, i) => tool({ name: `t${i}` })) }))).toBe(false);
    expect(isMcpServerState(state({ tools: [{ ...tool(), extra: 1 } as McpToolInfo] }))).toBe(false);
  });

  it("bounds tool names and errors", () => {
    expect(isMcpToolName("notion-search")).toBe(true);
    expect(isMcpToolName("x".repeat(129))).toBe(false);
    expect(isMcpToolName(3)).toBe(false);
    expect(isMcpServerState(state({ error: "x".repeat(301) }))).toBe(false);
    expect(clipMcpError("x".repeat(400))).toHaveLength(300);
    expect(clipMcpError("short")).toBe("short");
  });
});

describe("MCP server state storage", () => {
  it("reads the default (disconnected, writes confirmed) when nothing is stored", async () => {
    expect(await getMcpServerState("notion")).toEqual({ version: 1, tools: [], toolsAt: null, disabled: [], trust: "confirm-writes", needsReauth: false, error: null });
  });

  it("round-trips a server's state under its own key", async () => {
    await saveMcpServerState("notion", state({ disabled: ["search"] }));
    expect(await getMcpServerState("notion")).toEqual(state({ disabled: ["search"] }));
    expect(await getMcpServerState("todoist")).toEqual(DEFAULT_MCP_SERVER_STATE);
    expect(Object.keys(await browser.storage.local.get(null))).toEqual(["mcpServer:notion"]);
  });

  it("deletes a malformed record and reads the default", async () => {
    await browser.storage.local.set({ "mcpServer:notion": { ...state(), trust: "yolo" } });
    expect(await getMcpServerState("notion")).toEqual(DEFAULT_MCP_SERVER_STATE);
    expect(await browser.storage.local.get("mcpServer:notion")).toEqual({});
  });
});

describe("MCP sealed records", () => {
  const tokens = JSON.stringify({ accessToken: "at-secret-value", refreshToken: "rt-secret-value" });

  it("seals with the device key: no plaintext in storage.local", async () => {
    await saveMcpSecret("credential", "notion", tokens);
    const stored = await browser.storage.local.get(null);
    expect(stored["mcpCredential:notion"]).toEqual({ version: 1, iv: expect.any(String), ciphertext: expect.any(String) });
    expect(JSON.stringify(stored)).not.toContain("secret-value");
    expect(await getMcpSecret("credential", "notion")).toBe(tokens);
  });

  it("binds a record to its kind and server", async () => {
    await saveMcpSecret("credential", "notion", tokens);
    const { "mcpCredential:notion": sealed } = await browser.storage.local.get("mcpCredential:notion");
    // Copied under another server or kind, it cannot be opened, and is deleted.
    await browser.storage.local.set({ "mcpCredential:todoist": sealed, "mcpRegistration:notion": sealed });
    expect(await getMcpSecret("credential", "todoist")).toBeNull();
    expect(await getMcpSecret("registration", "notion")).toBeNull();
    expect(await browser.storage.local.get(["mcpCredential:todoist", "mcpRegistration:notion"])).toEqual({});
    expect(await getMcpSecret("credential", "notion")).toBe(tokens);
  });

  it("deletes a record a different device key cannot open", async () => {
    await saveMcpSecret("registration", "todoist", "{}");
    expect(await getMcpSecret("registration", "todoist", new DeviceKey(new MemoryDeviceKeyStore()))).toBeNull();
    expect(await browser.storage.local.get("mcpRegistration:todoist")).toEqual({});
  });

  it("deletes malformed and tampered records", async () => {
    await browser.storage.local.set({ "mcpCredential:notion": { version: 1, iv: "short", ciphertext: "x" } });
    expect(await getMcpSecret("credential", "notion")).toBeNull();
    expect(await browser.storage.local.get("mcpCredential:notion")).toEqual({});
    await browser.storage.local.set({ "mcpCredential:notion": "plaintext token" });
    expect(await getMcpSecret("credential", "notion")).toBeNull();
    expect(await browser.storage.local.get("mcpCredential:notion")).toEqual({});
    await saveMcpSecret("credential", "notion", tokens);
    const { "mcpCredential:notion": sealed } = await browser.storage.local.get("mcpCredential:notion") as { "mcpCredential:notion": { ciphertext: string } };
    await browser.storage.local.set({ "mcpCredential:notion": { ...sealed, ciphertext: btoa("tampered-ciphertext!") } });
    expect(await getMcpSecret("credential", "notion")).toBeNull();
    expect(await browser.storage.local.get("mcpCredential:notion")).toEqual({});
  });

  it("keeps the record but reads absent while the key store is unavailable", async () => {
    await saveMcpSecret("credential", "notion", tokens);
    const store = new MemoryDeviceKeyStore();
    store.load = async () => { throw new Error("IndexedDB unavailable"); };
    expect(await getMcpSecret("credential", "notion", new DeviceKey(store))).toBeNull();
    expect(await getMcpSecret("credential", "notion")).toBe(tokens);
  });

  it("deletes a record", async () => {
    await saveMcpSecret("credential", "notion", tokens);
    await deleteMcpSecret("credential", "notion");
    expect(await getMcpSecret("credential", "notion")).toBeNull();
  });
});
