import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";
import Icons from "unplugin-icons/vite";

const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self' https://api.openai.com https://auth.openai.com https://www.youtube.com https://mcp.notion.com https://ai.todoist.net https://todoist.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

export default defineConfig({
  browser: "firefox",
  manifestVersion: 2,
  // WXT's default Firefox source ZIP globs the working tree. Release sources
  // must come only from scripts/source-submission.mjs's committed allowlist.
  zip: { zipSources: false },
  vite: () => ({
    plugins: [preact(), Icons({ compiler: "jsx", jsx: "preact" })],
  }),
  manifest: {
    browser_specific_settings: { gecko: {
      id: "bside@tsuni.dev",
      // Firefox's built-in data-transmission consent starts at desktop 140.
      // Tasks can include sensitive page/account content: see docs/privacy.md.
      strict_min_version: "140.0",
      data_collection_permissions: { required: [
        "authenticationInfo", "browsingActivity", "financialAndPaymentInfo",
        "healthInfo", "locationInfo", "personalCommunications",
        "personallyIdentifyingInfo", "searchTerms", "websiteActivity", "websiteContent",
      ] },
    }, gecko_android: { strict_min_version: "142.0" } },
    icons: { "32": "icon.svg" },
    permissions: [
      "storage",
      // User-authored local scheduled tasks (docs/automation.md): one-shot
      // wakeups, no catch-up runs after a browser restart.
      "alarms",
      // Private generic hints only, behind an explicit opt-in (default off).
      "notifications",
      "cookies",
      "identity",
      "webRequest",
      "webRequestBlocking",
      "tabHide",
      "sessions",
      // web.search runs the user's default engine in the hidden search tab
      // (search.query); no search service or API of bside's own.
      "search",
      // "Ask bside about this selection / link / image / page" in the page's
      // context menu (lib/background/context-menu.ts).
      "menus",
      "https://api.openai.com/*",
      "https://auth.openai.com/*",
      // MCP directory servers (lib/mcp/servers.ts): Notion's MCP and OAuth
      // server, Todoist's MCP server, and Todoist's OAuth server.
      "https://mcp.notion.com/*",
      "https://ai.todoist.net/*",
      "https://todoist.com/*",
      // Page content scripts, tab URLs, the sign-in callback filter, site API
      // requests, and tabs.captureTab (screenshots), which requires <all_urls>.
      "<all_urls>",
    ],
    content_security_policy: {
      extension_pages: CSP,
    },
    browser_action: {
      default_icon: "icon.svg",
      default_title: "Toggle sidebar",
    },
    // Ctrl+Shift+Y is Firefox's Downloads on Linux and Cmd+Shift+B its
    // bookmarks toolbar on macOS; Alt+Shift+B and Control+Shift+B are free.
    // Users change or clear these in about:addons → Manage Extension Shortcuts.
    commands: {
      _execute_sidebar_action: {
        suggested_key: { default: "Alt+Shift+B", mac: "MacCtrl+Shift+B" },
        description: "Open or close the bside sidebar",
      },
      "new-chat": { description: "Start a new bside chat" },
    },
  },
  hooks: {
    // In dev mode, Vite's HMR client inside the sidepanel/options pages
    // opens a WebSocket back to the dev server at `wxt.server.origin`. The
    // port is chosen at runtime (WXT falls back to another port if 3000 is
    // taken), so it can't be a static CSP entry — widen `connect-src` here,
    // once the real origin is known, and only for dev builds.
    "build:manifestGenerated": (wxt, manifest) => {
      if (!wxt.server) return;
      const csp = manifest.content_security_policy;
      if (!csp || typeof csp !== "object" || !csp.extension_pages) return;
      const wsOrigin = wxt.server.origin.replace(/^http/, "ws");
      csp.extension_pages = csp.extension_pages.replace(
        /connect-src ([^;]*)/,
        (_match, sources) => `connect-src ${sources} ${wsOrigin}`,
      );
    },
  },
});
