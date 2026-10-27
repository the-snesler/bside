import type { McpContentSnapshot } from "@/lib/domain/mcp-content";

/** Remote content is rendered as text, including names and URI labels. No remote Markdown/images. */
export function McpContentChip({ item, onRemove }: { item: McpContentSnapshot; onRemove?: () => void }) {
  return <div class="mcp-content-chip">
    <details>
      <summary>{item.server} · {item.kind === "prompt" ? "Prompt" : "Resource"} · {item.name}</summary>
      <small>Untrusted connected-account data · {item.text.length.toLocaleString()} characters</small>
      {item.uri && <small>{item.uri}</small>}
      <pre>{item.text}</pre>
    </details>
    {onRemove && <button type="button" aria-label={`Remove ${item.name}`} onClick={onRemove}>×</button>}
  </div>;
}
