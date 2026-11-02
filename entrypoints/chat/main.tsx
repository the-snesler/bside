import { render } from "preact";
import "@/styles/theme.css";
import "@/entrypoints/sidepanel/style.css";
import { App } from "@/entrypoints/sidepanel/App";

// A chat popped out of the sidebar into a tab of its own (`chat.html#/<sessionId>`).
const root = document.getElementById("app");
if (!root) throw new Error("chat: missing #app mount node");

render(<App mode="tab" />, root);
