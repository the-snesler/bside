/**
 * MCP connection contracts shared by the background, storage, and the
 * Connections settings page: the saved tool catalog, the user's per-server
 * choices, and the status the options page renders. No credential is ever
 * part of these shapes. See docs/mcp.md.
 */

import type { JsonValue } from "@/lib/domain/tools";

/**
 * The user's trust level for one server. `confirm-writes` (default): bside
 * asks on the confirmation card before every call of a tool not annotated
 * read-only. `model`: the model's confirmation policy alone decides.
 */
export type McpTrust = "confirm-writes" | "model";
export const MCP_TRUST_LEVELS: readonly McpTrust[] = ["confirm-writes", "model"];

/** At most this many MCP tools are enabled across all servers. */
export const MAX_MCP_TOOLS = 64;
/** Total characters of MCP tool definitions (names, descriptions, schemas) sent with every request. */
export const MAX_MCP_TOOL_CHARS = 64_000;
export const MAX_MCP_TOOL_DESCRIPTION = 1_024;
export const MAX_MCP_SCHEMA_CHARS = 8_000;
export const MAX_MCP_TOOL_NAME = 128;
/** Tools saved per server. */
export const MAX_MCP_SERVER_TOOLS = 200;
const MAX_ERROR_CHARS = 300;

/** One tool of a server as saved at connect time, already bounded and sanitized. */
export interface McpToolInfo {
  name: string;
  title: string | null;
  description: string;
  /** The sanitized JSON-Schema object, or null when the tool is unavailable. */
  inputSchema: { [key: string]: JsonValue } | null;
  /** The server annotated it `readOnlyHint: true`. */
  readOnly: boolean;
  /** Not read-only and not annotated `destructiveHint: false` (MCP's default is destructive). */
  destructive: boolean;
  /** Why bside cannot offer it (e.g. its schema is too large), or null. */
  unavailable: string | null;
}

/** `local:mcpServer:<id>`: one directory server's non-secret state. */
export interface McpServerStateV1 {
  version: 1;
  tools: McpToolInfo[];
  /** When `tools` was last listed. */
  toolsAt: number | null;
  /** Tools the user turned off (or that started off past the cap). */
  disabled: string[];
  trust: McpTrust;
  /** The saved connection could not be refreshed: the user must connect again. */
  needsReauth: boolean;
  /** The last safe error from connecting or listing tools. */
  error: string | null;
}

export const DEFAULT_MCP_SERVER_STATE: McpServerStateV1 = { version: 1, tools: [], toolsAt: null, disabled: [], trust: "confirm-writes", needsReauth: false, error: null };

export type McpConnectionStatus = "disconnected" | "connected" | "needs-reauth" | "error";

/** One server as the Connections page shows it. */
export interface McpServerStatus {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: McpConnectionStatus;
  error: string | null;
  trust: McpTrust;
  tools: (McpToolInfo & { enabled: boolean })[];
  toolsAt: number | null;
}

export function isMcpToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MCP_TOOL_NAME;
}

function isMcpToolInfo(value: unknown): value is McpToolInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 7 && isMcpToolName(v.name) && (v.title === null || (typeof v.title === "string" && v.title.length <= 120)) &&
    typeof v.description === "string" && v.description.length <= MAX_MCP_TOOL_DESCRIPTION + 64 &&
    (v.inputSchema === null || (typeof v.inputSchema === "object" && !Array.isArray(v.inputSchema) && JSON.stringify(v.inputSchema).length <= MAX_MCP_SCHEMA_CHARS)) &&
    typeof v.readOnly === "boolean" && typeof v.destructive === "boolean" && !(v.readOnly && v.destructive) &&
    (v.unavailable === null || (typeof v.unavailable === "string" && v.unavailable.length <= 200)) && (v.inputSchema === null) === (v.unavailable !== null);
}

export function isMcpServerState(value: unknown): value is McpServerStateV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 7 && v.version === 1 && Array.isArray(v.tools) && v.tools.length <= MAX_MCP_SERVER_TOOLS && v.tools.every(isMcpToolInfo) &&
    new Set(v.tools.map((tool: McpToolInfo) => tool.name)).size === v.tools.length &&
    (v.toolsAt === null || Number.isFinite(v.toolsAt)) && Array.isArray(v.disabled) && v.disabled.length <= MAX_MCP_SERVER_TOOLS && v.disabled.every(isMcpToolName) &&
    (MCP_TRUST_LEVELS as readonly unknown[]).includes(v.trust) && typeof v.needsReauth === "boolean" &&
    (v.error === null || (typeof v.error === "string" && v.error.length <= MAX_ERROR_CHARS));
}

export function clipMcpError(message: string): string {
  return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
