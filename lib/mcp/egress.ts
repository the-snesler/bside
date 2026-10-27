/**
 * The one network path for MCP and MCP-OAuth traffic. Every request is checked
 * against the directory entry it serves before it reaches `fetch`: defense in
 * depth on top of `connect-src`, which allows every directory origin at once.
 */

import { McpError } from "@/lib/mcp/errors";
import type { McpServer } from "@/lib/mcp/servers";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Whether `url` is plain HTTPS on one of `origins` (no credentials in the URL). */
export function isAllowedUrl(url: string, origins: readonly string[]): boolean {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return false; }
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && origins.includes(parsed.origin);
}

/**
 * A fetch limited to `server.origins`. A redirect fails rather than leaving
 * the allowlist, and the user's cookies for those sites are never attached.
 */
export function mcpFetch(server: McpServer, fetcher: Fetcher = (url, init) => fetch(url, init)): Fetcher {
  return async (url, init) => {
    if (!isAllowedUrl(url, server.origins)) throw new McpError("EGRESS", `bside blocked a ${server.name} request to an address outside its allowed origins.`);
    return fetcher(url, { ...init, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  };
}
