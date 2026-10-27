import type { Browser } from "wxt/browser";
import { ASK_KINDS, buildAskContext, withAlt, type AskContextV1 } from "@/lib/domain/ask";
import type { PageMenuTargetRequest } from "@/lib/protocol";

type Click = Browser.contextMenus.OnClickData & { targetElementId?: number };
export interface EntryPointsApi {
  menus: Pick<typeof browser.contextMenus, "create" | "removeAll" | "onClicked">;
  commands: Pick<typeof browser.commands, "onCommand">;
  tabs: Pick<typeof browser.tabs, "sendMessage">;
  sidebarAction: { open(): Promise<void> };
}

/** Listener registration is synchronous; opening stays in the original gesture, before any await. */
export function registerEntryPoints(api: EntryPointsApi, actions: {
  setAsk(ask: AskContextV1): void;
  updateAskAlt(id: string, alt: string | null): void;
  newChat(): Promise<void>;
  focusComposer(): void;
}): void {
  void api.menus.removeAll().then(() => {
    for (const kind of ASK_KINDS) api.menus.create({
      id: `bside-ask-${kind}`,
      title: `Ask bside about this ${kind}`,
      contexts: [kind],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  }).catch(() => console.warn("[bside] Could not create context menus."));

  api.menus.onClicked.addListener((info: Click, tab) => {
    const kind = ASK_KINDS.find((kind) => info.menuItemId === `bside-ask-${kind}`);
    if (!kind) return;
    // Firefox requires this call on the gesture's stack, even if validation or initialization takes time.
    void api.sidebarAction.open().catch(() => {});
    const ask = buildAskContext(kind, info, tab ?? {}, crypto.randomUUID(), Date.now());
    if (!ask) return;
    actions.setAsk(ask);
    if (kind !== "image" || !Number.isSafeInteger(info.targetElementId)) return;
    const frameId = info.frameId ?? 0;
    const request: PageMenuTargetRequest = { v: 1, id: crypto.randomUUID(), type: "page.menu-target", frameId, tabId: ask.tabId, targetElementId: info.targetElementId! };
    // The clicked frame alone can resolve Firefox's ephemeral element id. No URL is fetched.
    void api.tabs.sendMessage(ask.tabId, request, { frameId }).then((value: unknown) => {
      if (!value || typeof value !== "object") return;
      const response = value as Record<string, unknown>;
      if (response.v !== 1 || response.id !== request.id || response.ok !== true || response.type !== request.type || typeof response.alt !== "string") return;
      actions.updateAskAlt(ask.id, withAlt(ask, response.alt).alt ?? null);
    }, () => {});
  });

  api.commands.onCommand.addListener((command) => {
    // _execute_sidebar_action is handled by Firefox and never fires onCommand.
    if (command !== "new-chat") return;
    void api.sidebarAction.open().catch(() => {});
    void actions.newChat().then(() => actions.focusComposer());
  });
}
