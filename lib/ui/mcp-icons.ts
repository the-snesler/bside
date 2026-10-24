import BrandNotion from "~icons/tabler/brand-notion";
import Checklist from "~icons/tabler/checklist";
import PlugConnected from "~icons/tabler/plug-connected";
import { findMcpServer, type McpServerIcon } from "@/lib/mcp/servers";

type Icon = typeof PlugConnected;

/** Bundled icons for directory servers (no remote assets). */
const MCP_SERVER_ICONS: Record<McpServerIcon, Icon> = { "brand-notion": BrandNotion, checklist: Checklist };

/** A directory server's icon, or a generic plug for an unknown id. */
export function mcpServerIcon(id: string): Icon {
  const server = findMcpServer(id);
  return server ? MCP_SERVER_ICONS[server.icon] : PlugConnected;
}
