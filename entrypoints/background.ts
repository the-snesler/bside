import { isCredentialRequest, isSettingsRequest, SIDEBAR_PORT_NAME } from "@/lib/protocol";
import type { CredentialResponse, SettingsResponse } from "@/lib/protocol";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { ApprovalBadge } from "@/lib/background/approval-badge";

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

    browser.tabs.onActivated.addListener(() => {
      void sidebarHub.refreshAttachment();
    });

    browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.status === "complete") {
        void sidebarHub.refreshAttachment();
      }
    });

    // Only the extension's own options page may read/write credentials or
    // settings; the sidebar Port never exposes these methods.
    const optionsUrl = browser.runtime.getURL("/options.html");
    browser.runtime.onMessage.addListener((message: unknown, sender): Promise<CredentialResponse | SettingsResponse> | undefined => {
      if (sender.id !== browser.runtime.id || sender.url !== optionsUrl) return undefined;
      if (isCredentialRequest(message)) return runtime.handleCredentialRequest(message);
      if (isSettingsRequest(message)) return runtime.handleSettingsRequest(message);
      return undefined;
    });

    void runtime.initialize();
  },
});
