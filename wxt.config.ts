import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";
import Icons from "unplugin-icons/vite";

const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self' https://api.openai.com https://auth.openai.com https://www.youtube.com https://mcp.notion.com https://ai.todoist.net https://todoist.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

export default defineConfig({
  browser: "firefox",
  manifestVersion: 2,
  vite: () => ({
    plugins: [preact(), Icons({ compiler: "jsx", jsx: "preact" })],
  }),
  manifest: {
    browser_specific_settings: { gecko: { id: "bside@tsuni.dev" } },
    icons: { "32": "icon.svg" },
    permissions: [
      "storage",
      "cookies",
      "identity",
      "webRequest",
      "webRequestBlocking",
      "tabHide",
      "sessions",
      // web.search runs the user's default engine in the hidden search tab
      // (search.query); no search service or API of bside's own.
      "search",
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
