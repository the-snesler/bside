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
    permissions: ["storage", "https://api.openai.com/*", "http://*/*", "https://*/*"],
    content_security_policy: {
      extension_pages: CSP,
    },
  },
});
