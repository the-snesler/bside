import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMcpServer, isMcpServerId, MCP_SERVERS, mcpOrigins } from "@/lib/mcp/servers";

const config = readFileSync(new URL("../wxt.config.ts", import.meta.url), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("../scripts/manifest-snapshot.json", import.meta.url), "utf8")) as {
  permissions: string[];
  content_security_policy: Record<string, string[]>;
};
const connectSrc = Object.values(snapshot.content_security_policy).flat().find((directive) => directive.startsWith("connect-src "))!.split(" ").slice(1);

describe("MCP server directory", () => {
  it("pins Notion and Todoist to their hosted endpoints and OAuth servers", () => {
    expect(MCP_SERVERS.map((server) => [server.id, server.endpoint, server.issuer])).toEqual([
      ["notion", "https://mcp.notion.com/mcp", "https://mcp.notion.com"],
      ["todoist", "https://ai.todoist.net/mcp", "https://todoist.com"],
    ]);
    expect(findMcpServer("todoist")?.origins).toEqual(["https://ai.todoist.net", "https://todoist.com"]);
    expect(isMcpServerId("notion")).toBe(true);
    expect(isMcpServerId("github")).toBe(false);
    expect(findMcpServer("__proto__")).toBeNull();
  });

  it("keeps each entry's endpoint and issuer inside its own HTTPS origins", () => {
    for (const server of MCP_SERVERS) {
      expect(server.id).toMatch(/^[a-z][a-z0-9]{0,15}$/);
      for (const origin of [...server.origins, ...server.authorizeOrigins]) expect(new URL(origin).origin).toBe(origin);
      expect(server.origins.every((origin) => origin.startsWith("https://"))).toBe(true);
      expect(server.origins).toContain(new URL(server.endpoint).origin);
      expect(server.origins).toContain(new URL(server.issuer).origin);
    }
  });

  it("adds exactly the directory's origins to connect-src and host permissions, never https:", () => {
    expect(connectSrc).toEqual(["'self'", "https://api.openai.com", "https://auth.openai.com", "https://www.youtube.com", ...mcpOrigins()]);
    expect(connectSrc).not.toContain("https:");
    for (const origin of mcpOrigins()) {
      expect(snapshot.permissions).toContain(`${origin}/*`);
      expect(config).toContain(`"${origin}/*"`);
    }
  });
});
