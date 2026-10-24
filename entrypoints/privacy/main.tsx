import { render } from "preact";
import { Markdown } from "@/lib/ui/Markdown";
import policy from "../../docs/privacy.md?raw";
import "@/styles/theme.css";
import "@/styles/welcome.css";

render(<main class="welcome"><Markdown text={policy} /><p><a href="/options.html#/history">History &amp; privacy settings</a> · <a href="/onboarding.html">Getting started</a></p></main>, document.getElementById("app")!);
