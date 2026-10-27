import { useState } from "preact/hooks";
import type { McpServerStatus, McpTrust } from "@/lib/domain/mcp";
import type { McpRequest, McpResponse } from "@/lib/protocol";
import { mcpServerIcon } from "@/lib/ui/mcp-icons";
import { Banner, Card, Feedback, Note, Row, Select, SettingsSection, Switch } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendMcpRequest, type RequestBody } from "@/lib/ui/settings/requests";
import { useRefreshOnFocus } from "../state";

const TRUST_LABELS: Record<McpTrust, string> = { "confirm-writes": "Always confirm writes", model: "Let bside decide" };
const TRUST_DESCRIPTIONS: Record<McpTrust, string> = {
  "confirm-writes": "bside asks you before every call of a tool the service does not mark read-only.",
  model: "bside asks before consequential changes, as it does on web pages. Read-only marks come from the service.",
};

const STATUS_TEXT: Record<McpServerStatus["status"], string> = {
  disconnected: "Not connected.",
  connected: "Connected.",
  "needs-reauth": "Signed out. Connect again to keep using it.",
  error: "Connected, but its tools could not be loaded.",
};

type Listing = Extract<McpResponse, { ok: true }>;

/** The service's own description, without the `[Name]` prefix every saved tool description carries. */
function toolDescription(server: McpServerStatus, description: string): string {
  return description.startsWith(`[${server.name}] `) ? description.slice(server.name.length + 3) : description;
}

function ToolBadge(props: { tool: McpServerStatus["tools"][number] }) {
  const { tool } = props;
  if (tool.readOnly) return <span class="settings-badge" title="The service marks this tool read-only.">Read-only</span>;
  return tool.destructive
    ? <span class="settings-badge settings-badge--warning" title="Not marked read-only, and may delete or overwrite data.">Can delete</span>
    : <span class="settings-badge settings-badge--warning" title="Not marked read-only.">Writes</span>;
}

function ServerCard(props: { server: McpServerStatus; busy: boolean; connecting: boolean; request: (request: RequestBody<McpRequest>, done?: string) => Promise<void> }) {
  const { server, busy, request } = props;
  const Icon = mcpServerIcon(server.id);
  const connected = server.status === "connected" || server.status === "error";
  const enabled = server.tools.filter((tool) => tool.enabled).length;
  const statusLine = props.connecting ? "Finish signing in in the window that opened." : server.status === "error" && server.error ? `${STATUS_TEXT.error} ${server.error}` : STATUS_TEXT[server.status];
  return (
    <SettingsSection label={server.name}>
      <Card label={server.name}>
        <Row
          title={<span class="settings-connection__name"><Icon class="settings-connection__icon" aria-hidden="true" />{server.name}</span>}
          live
          description={<>
            <span class="settings-connection__line">{server.description}</span>
            <span class="settings-connection__line">{statusLine}</span>
          </>}
          control={connected ? <>
            <button type="button" class="settings-button" disabled={busy} aria-label={`Refresh ${server.name} tools`} onClick={() => void request({ type: "mcp.refresh", server: server.id }, `Refreshed ${server.name}'s tools.`)}>Refresh</button>
            <button type="button" class="settings-button" disabled={busy} aria-label={`Disconnect ${server.name}`} onClick={() => void request({ type: "mcp.disconnect", server: server.id }, `Disconnected ${server.name}.`)}>Disconnect</button>
          </> : (
            <button type="button" class="settings-button settings-button--primary" disabled={busy} aria-label={`Connect ${server.name}`} onClick={() => void request({ type: "mcp.connect", server: server.id }, `Connected ${server.name}.`)}>
              {server.status === "needs-reauth" ? "Reconnect" : "Connect"}
            </button>
          )}
        />
        <Row
          title="Confirmation"
          controlId={`mcp-trust-${server.id}`}
          description={TRUST_DESCRIPTIONS[server.trust]}
          control={
            <Select id={`mcp-trust-${server.id}`} value={server.trust} disabled={busy}
              onChange={(event) => void request({ type: "mcp.trust.save", server: server.id, trust: (event.target as HTMLSelectElement).value as McpTrust })}>
              {(Object.keys(TRUST_LABELS) as McpTrust[]).map((trust) => <option key={trust} value={trust}>{TRUST_LABELS[trust]}</option>)}
            </Select>
          }
        />
      </Card>
      {connected && server.tools.length > 0 && (
        <>
          <Card label={`${server.name} tools`}>
            {server.tools.map((tool) => {
              const id = `mcp-tool-${server.id}-${tool.name}`;
              return (
                <Row
                  key={tool.name}
                  controlId={id}
                  title={<><span class="settings-skill__name">{tool.title ?? tool.name}</span><ToolBadge tool={tool} /></>}
                  description={<span class="settings-connection__tool">{tool.unavailable ?? toolDescription(server, tool.description)}</span>}
                  control={
                    <Switch id={id} checked={tool.enabled} disabled={busy || tool.unavailable !== null} aria-label={`Use ${tool.title ?? tool.name}`}
                      onChange={(event) => void request({ type: "mcp.tool.toggle", server: server.id, tool: tool.name, enabled: (event.target as HTMLInputElement).checked })} />
                  }
                />
              );
            })}
          </Card>
          <Note>{enabled} of {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"} on.{server.toolsAt ? ` Listed ${new Date(server.toolsAt).toLocaleString()}.` : ""}</Note>
        </>
      )}
      {connected && server.tools.length === 0 && server.status === "connected" && <Note>{server.name} offers no tools to this account.</Note>}
    </SettingsSection>
  );
}

export function ConnectionsPage() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useRefreshOnFocus(async () => {
    const response = await sendMcpRequest({ type: "mcp.list" });
    if (response.ok) setListing(response);
  });

  const request = async (body: RequestBody<McpRequest>, done?: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    if (body.type === "mcp.connect") setConnecting(body.server);
    try {
      const response = await sendMcpRequest(body);
      if (!response.ok) {
        setError(response.error.message);
        const refreshed = await sendMcpRequest({ type: "mcp.list" });
        if (refreshed.ok) setListing(refreshed);
        return;
      }
      setListing(response);
      setNotice(response.notice ?? done ?? null);
    } catch { setError(BACKGROUND_FAILURE); }
    finally {
      setBusy(false);
      setConnecting(null);
    }
  };

  const reauth = listing?.servers.filter((server) => server.status === "needs-reauth") ?? [];
  return (
    <>
      {reauth.length > 0 && (
        <Banner tone="warning">{reauth.map((server) => server.name).join(" and ")} signed bside out. Connect again to keep using {reauth.length === 1 ? "it" : "them"}.</Banner>
      )}
      {notice && <Feedback>{notice}</Feedback>}
      {error && <Feedback error>{error}</Feedback>}
      {listing?.servers.map((server) => (
        <ServerCard key={server.id} server={server} busy={busy} connecting={connecting === server.id} request={request} />
      ))}
      {listing && (
        <SettingsSection label="About connections">
          <Card>
            <Row
              title="Tools offered to bside"
              live
              description={`${listing.enabledTools} of at most ${listing.maxTools} tools are on across your connections. Each one is sent with every message, so turn off tools you don't use.`}
            />
            <Row
              title="Stored only on this device"
              description="Sign-ins are encrypted in this Firefox profile and used only from bside's background page. bside talks to each service directly, never through OpenAI. Only the services listed here can be connected."
            />
          </Card>
          <Note>What a connected service returns is treated as untrusted data, like a web page: it cannot give bside instructions.</Note>
        </SettingsSection>
      )}
    </>
  );
}
