import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";
import preact from "@preact/preset-vite";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  plugins: [WxtVitest(), preact(), Icons({ compiler: "jsx", jsx: "preact" })],
  test: {
    server: { deps: { inline: ["react-markdown", "slate-react", "slate-dom"] } },
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
