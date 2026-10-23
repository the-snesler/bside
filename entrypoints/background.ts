import { isCredentialRequest, isHistoryRequest, isInstructionsRequest, isSettingsRequest, isSiteNotesRequest, isSkillsRequest, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { CredentialResponse, HistoryResponse, InstructionsResponse, SettingsResponse, SiteNotesResponse, SkillsResponse } from "@/lib/protocol";
import { handleSkillsRequest } from "@/lib/background/skills";
import { handleInstructionsRequest, handleSiteNotesRequest } from "@/lib/background/instructions";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { ApprovalBadge } from "@/lib/background/approval-badge";
import { registerSiteRequestHeaders } from "@/lib/sites";

export default defineBackground({
  persistent: true,
  main() {
    // All browser listener registration lives in this function so the
    // background page's full listener set is (re)established synchronously
    // on every load, which MV2 persistent background pages require.
    const sidebarHub = new SidebarHub();
    const approvalBadge = new ApprovalBadge(browser.browserAction);
    const runtime = new BackgroundRuntime(sidebarHub, { approvalBadge });
    sidebarHub.delegate = runtime;

    registerSiteRequestHeaders(browser);

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
      // gesture; a pending approval opens the sidebar rather than closing it.
      void (approvalBadge.pending ? sidebarAction.open() : sidebarAction.toggle());
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
    // settings, history retention, skills, or custom instructions; the sidebar
    // Port never exposes these methods. Its one user-authored write is a single
    // site note (`siteNote.save`), revalidated like these.
    const optionsUrl = browser.runtime.getURL("/options.html");
    browser.runtime.onMessage.addListener((message: unknown, sender):
      Promise<CredentialResponse | SettingsResponse | HistoryResponse | SkillsResponse | InstructionsResponse | SiteNotesResponse> | undefined => {
      if (sender.id !== browser.runtime.id || sender.url !== optionsUrl) return undefined;
      if (isCredentialRequest(message)) return runtime.handleCredentialRequest(message);
      if (isSettingsRequest(message)) return runtime.handleSettingsRequest(message);
      if (isHistoryRequest(message)) return runtime.handleHistoryRequest(message);
      if (isInstructionsRequest(message)) return handleInstructionsRequest(message);
      if (isSiteNotesRequest(message)) return handleSiteNotesRequest(message);
      if (isSkillsRequest(message)) return handleSkillsRequest(message).then(async (response) => {
        if (response.ok && message.type !== "skills.list") await sidebarHub.broadcastSnapshot();
        return response;
      });
      return undefined;
    });

    void runtime.initialize();
  },
});
