/**
 * The source-controlled directory of remote MCP servers bside can connect to.
 * Adding a server is a reviewed code change: its `origins` must also be added
 * to `connect-src` and the host permissions in wxt.config.ts, and to the
 * manifest snapshot. Users never enter server URLs. See docs/mcp.md.
 */

/** Tabler icons the options page bundles for directory entries (no remote assets). */
export type McpServerIcon = "brand-notion" | "checklist";

export interface McpServer {
  /** Slug used in tool names (`mcp__<id>__<tool>`) and storage keys. */
  id: string;
  name: string;
  /** One line for the Connections page. */
  description: string;
  icon: McpServerIcon;
  /** Streamable HTTP endpoint; also the OAuth protected resource. */
  endpoint: string;
  /** Authorization server the resource metadata must name; its metadata's `issuer` must match exactly. */
  issuer: string;
  /** Every origin bside may fetch for this server: MCP, OAuth metadata, registration, token, revocation. */
  origins: readonly string[];
  /** Origins the sign-in popup may be sent to (a navigation, not a fetch). */
  authorizeOrigins: readonly string[];
}

/** Checked against the live servers' metadata on 2026-10-23. */
export const MCP_SERVERS: readonly McpServer[] = [
  {
    id: "notion",
    name: "Notion",
    description: "Search, read, and edit pages and databases in your Notion workspace.",
    icon: "brand-notion",
    endpoint: "https://mcp.notion.com/mcp",
    issuer: "https://mcp.notion.com",
    origins: ["https://mcp.notion.com"],
    authorizeOrigins: ["https://mcp.notion.com"],
  },
  {
    id: "todoist",
    name: "Todoist",
    description: "Find, add, and complete tasks and projects in your Todoist account.",
    icon: "checklist",
    endpoint: "https://ai.todoist.net/mcp",
    issuer: "https://todoist.com",
    origins: ["https://ai.todoist.net", "https://todoist.com"],
    authorizeOrigins: ["https://todoist.com"],
  },
];

export type McpServerId = string;

export function findMcpServer(id: string): McpServer | null {
  return MCP_SERVERS.find((server) => server.id === id) ?? null;
}

export function isMcpServerId(value: unknown): value is McpServerId {
  return typeof value === "string" && MCP_SERVERS.some((server) => server.id === value);
}

/** Every origin any directory server may fetch, for `connect-src` and host permissions. */
export function mcpOrigins(): string[] {
  return [...new Set(MCP_SERVERS.flatMap((server) => server.origins))];
}
