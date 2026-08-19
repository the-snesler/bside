import { isPageHealthRequest } from "@/lib/protocol";
import type { PageResponse } from "@/lib/protocol";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isPageHealthRequest(message)) return undefined;
      const response: PageResponse = {
        v: 1,
        id: message.id,
        ok: true,
        type: "page.health",
        url: location.href,
      };
      sendResponse(response);
      return undefined;
    });
  },
});
