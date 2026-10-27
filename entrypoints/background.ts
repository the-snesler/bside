import { contentMessageTab, isContentMessage, isCredentialRequest, isHistoryRequest, isInstructionsRequest, isMcpRequest, isMemoryRequest, isSettingsRequest, isSiteNotesRequest, isSkillsRequest, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { ContentMessageResponse, CredentialResponse, HistoryResponse, InstructionsResponse, McpResponse, MemoryResponse, SettingsResponse, SiteNotesResponse, SkillsResponse } from "@/lib/protocol";
import { handleSkillsRequest } from "@/lib/background/skills";
import { handleInstructionsRequest, handleSiteNotesRequest } from "@/lib/background/instructions";
import { handleMemoryRequest } from "@/lib/background/memory";
import { handleMcpRequest, McpConnections } from "@/lib/background/mcp";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { ApprovalBadge } from "@/lib/background/approval-badge";
import { registerSiteRequestHeaders } from "@/lib/sites";
import { registerEntryPoints, type EntryPointsApi } from "@/lib/background/context-menu";
import { isAutomationRequest, type AutomationResponse } from "@/lib/protocol";
import { RunNotifications } from "@/lib/background/notifications";

export default defineBackground({
  persistent: true,
  main() {
    // All browser listener registration lives in this function so the
    // background page's full listener set is (re)established synchronously
    // on every load, which MV2 persistent background pages require.
    const sidebarHub = new SidebarHub();
    const approvalBadge = new ApprovalBadge(browser.browserAction);
    const mcp = new McpConnections({ clientVersion: browser.runtime.getManifest().version });
    const notifications = new RunNotifications({ api: browser.notifications ? {
      create: (id, options) => browser.notifications.create(id, { ...options, iconUrl: browser.runtime.getURL("/icon.svg") }),
      clear: (id) => browser.notifications.clear(id), getAll: () => browser.notifications.getAll(),
      onClicked: browser.notifications.onClicked, onClosed: browser.notifications.onClosed,
    } : undefined,
      openSidebar: () => Reflect.get(browser, "sidebarAction").open(), selectSession: (id) => runtime.openResultsSession(id) });
    const runtime = new BackgroundRuntime(sidebarHub, { approvalBadge, mcp, alarms: browser.alarms, notifications });
    sidebarHub.delegate = runtime;
    void notifications.initialize();
    globalThis.addEventListener("unload", () => runtime.dispose(), { once: true });

    registerSiteRequestHeaders(browser);
    registerEntryPoints(browser as unknown as EntryPointsApi, {
      setAsk: (ask) => runtime.setAsk(ask),
      updateAskAlt: (id, alt) => runtime.updateAskAlt(id, alt),
      newChat: async () => { await runtime.handleCommand({ v: 1, id: crypto.randomUUID(), type: "session.create" }); },
      focusComposer: () => sidebarHub.focusComposer(),
    });

    browser.alarms.onAlarm.addListener((alarm) => { void runtime.handleAlarm(alarm.name); });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== SIDEBAR_PORT_NAME) return;
      sidebarHub.handleConnect(port);
    });

    browser.browserAction.onClicked.addListener(() => {
      const sidebarAction: { open: Function; toggle: Function } = Reflect.get(
        browser,
        "sidebarAction",
      );
      // Both calls stay synchronous in the click handler to keep the user
      // gesture; a pending approval or help request opens the sidebar rather than closing it.
      void (approvalBadge.attention ? sidebarAction.open() : sidebarAction.toggle());
      if (approvalBadge.attention) void runtime.openAttentionSession();
    });

    browser.tabs.onActivated.addListener(({ tabId }) => {
      void sidebarHub.refreshAttachment();
      void runtime.handleTabActivated(tabId);
    });

    browser.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) void runtime.handleTabCreated(tab.id);
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "complete") {
        void sidebarHub.refreshAttachment();
      }
      runtime.handleTabUpdated(tabId, changeInfo);
    });

    // Only the extension's own options page may read/write credentials,
    // settings, history retention, skills, custom instructions, memory, or MCP
    // connections; the
    // sidebar Port never exposes these methods. Its user-authored writes are a
    // single site note (`siteNote.save`) and undoing a run's memory change
    // (`memory.undo`), revalidated like these. The options page is matched
    // without its `#/page` route, which deep links (`#/memory/<name>`) carry.
    // The top-frame content script in an HTTP(S) tab (never a subframe's) may
    // only ask for its own tab's page shield or report "Take over"; the tab is
    // the sender's.
    const optionsUrl = browser.runtime.getURL("/options.html");
    browser.runtime.onMessage.addListener((message: unknown, sender):
      Promise<CredentialResponse | SettingsResponse | HistoryResponse | SkillsResponse | InstructionsResponse | SiteNotesResponse | MemoryResponse | McpResponse | ContentMessageResponse | AutomationResponse> | undefined => {
      if (sender.id !== browser.runtime.id) return undefined;
      if (sender.url?.replace(/#.*$/s, "") !== optionsUrl) {
        const tabId = contentMessageTab(sender, browser.runtime.id);
        if (tabId === null || !isContentMessage(message)) return undefined;
        return runtime.handleContentMessage(tabId, message);
      }
      if (isCredentialRequest(message)) return runtime.handleCredentialRequest(message);
      if (isAutomationRequest(message)) return runtime.handleAutomationRequest(message);
      if (isSettingsRequest(message)) return runtime.handleSettingsRequest(message);
      if (isHistoryRequest(message)) return runtime.handleHistoryRequest(message);
      if (isInstructionsRequest(message)) return handleInstructionsRequest(message);
      if (isSiteNotesRequest(message)) return handleSiteNotesRequest(message);
      if (isMemoryRequest(message)) return handleMemoryRequest(message);
      if (isMcpRequest(message)) return handleMcpRequest(mcp, message);
      if (isSkillsRequest(message)) return handleSkillsRequest(message).then(async (response) => {
        if (response.ok && message.type !== "skills.list") await sidebarHub.broadcastSnapshot();
        return response;
      });
      return undefined;
    });

    void runtime.initialize();
  },
});
