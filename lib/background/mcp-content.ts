import { MCP_CONTENT_LIMITS, isMcpContentSnapshots, type McpContentSnapshot } from "@/lib/domain/mcp-content";
import { McpError } from "@/lib/mcp/errors";

export interface ContentAcceptance { content: McpContentSnapshot[]; commit(): void }
/** In-memory capabilities owned by one sidebar Port and session. Claims are atomic; failed sends release them. */
export class PreparedMcpContent {
  #releasedOwners = new WeakSet<object>();
  #items = new Map<string, { snapshot: McpContentSnapshot; owner: object; claimed: boolean }>();
  add(snapshot: McpContentSnapshot, owner: object): void {
    if (this.#releasedOwners.has(owner)) throw new McpError("PROTOCOL", "The sidebar disconnected. Choose the content again.");
    if (!isMcpContentSnapshots([snapshot])) throw new McpError("PROTOCOL", "Invalid prepared MCP content.");
    const own = [...this.#items.values()].filter(item => item.owner === owner && item.snapshot.sessionId === snapshot.sessionId);
    if (own.length >= MCP_CONTENT_LIMITS.attachments || this.#items.size >= 64) throw new McpError("TOO_LARGE", "Remove a prepared attachment before adding another (maximum four).");
    this.#items.set(snapshot.id, { snapshot: structuredClone(snapshot), owner, claimed: false });
  }
  dismiss(ids: readonly string[], owner: object): void {
    for (const id of ids) {
      const item = this.#items.get(id);
      if (item?.owner === owner && !item.claimed) this.#items.delete(id);
    }
  }
  releaseOwner(owner: object): void {
    this.#releasedOwners.add(owner);
    for (const [id, item] of this.#items) if (item.owner === owner && !item.claimed) this.#items.delete(id);
  }
  claim(ids: readonly string[], sessionId: string, owner: object, onCommit: () => void): { accepted: ContentAcceptance; release(): void } {
    const items = ids.map(id => this.#items.get(id));
    if (this.#releasedOwners.has(owner) || !ids.length || ids.length > MCP_CONTENT_LIMITS.attachments || new Set(ids).size !== ids.length ||
      items.some(item => !item || item.owner !== owner || item.claimed || item.snapshot.sessionId !== sessionId)) {
      throw new McpError("PROTOCOL", "That MCP attachment is no longer available in this sidebar and chat. Choose it again.");
    }
    const content = items.map(item => structuredClone(item!.snapshot));
    if (!isMcpContentSnapshots(content, sessionId)) throw new McpError("TOO_LARGE", "MCP attachments exceed the message limit.");
    for (const item of items) item!.claimed = true;
    let committed = false;
    return {
      accepted: { content, commit: () => {
        if (committed) return;
        committed = true;
        for (const id of ids) this.#items.delete(id);
        onCommit();
      } },
      release: () => { if (!committed) for (const item of items) { item!.claimed = false; if (this.#releasedOwners.has(owner)) this.#items.delete(item!.snapshot.id); } },
    };
  }
}
