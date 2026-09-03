import { defineConfig } from "wxt";
import preact from "@preact/preset-vite";

const CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self' https://api.openai.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

export default defineConfig({
  browser: "firefox",
  manifestVersion: 2,
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: {
    icons: { "32": "icon.svg" },
    permissions: [
      "storage",
      "https://api.openai.com/*",
      "http://*/*",
      "https://*/*",
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
