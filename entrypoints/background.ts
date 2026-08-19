import { SIDEBAR_PORT_NAME } from "@/lib/protocol";
import { SidebarHub } from "@/lib/background/sidebar-hub";

export default defineBackground({
  persistent: true,
  main() {
    // All browser listener registration lives in this function so the
    // background page's full listener set is (re)established synchronously
    // on every load, which MV2 persistent background pages require.
    const sidebarHub = new SidebarHub();

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== SIDEBAR_PORT_NAME) return;
      sidebarHub.handleConnect(port);
    });

    browser.tabs.onActivated.addListener(() => {
      void sidebarHub.refreshAttachment();
    });

    browser.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (changeInfo.status === "complete") {
        void sidebarHub.refreshAttachment();
      }
    });
  },
});
