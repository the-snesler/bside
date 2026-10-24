# AMO listing draft — bside

Status: review copy for the assembled desktop release. Not submitted. Search/PDF, entry points, and automation are sibling layers below this one; final MCP resources/prompts are still pending above it. Remove any feature not in the final tested package before submission.

**Name:** bside

**Summary:** An OpenAI-powered assistant in your Firefox sidebar that reads pages and helps with browser tasks.

**Description:**

Keep an assistant beside the page you are working on. Ask bside to summarize an article, compare information across tabs, extract a table, or help with a form. Its trace shows its work; you can stop a run, watch its agent tabs, or take over when it needs your hands. Review confirmations before consequential actions.

Separate chats keep their own history and workspace. Add custom instructions, site notes, and reusable Markdown skills. Local memory can be automatic, ask before saving, or off. Connect Notion and Todoist through their MCP services, choose which tools are available, and keep write confirmations enabled if you prefer.

In the assembled release, search uses your own Firefox default engine, text-based PDFs use a bundled local parser, context-menu and keyboard entry points help draft a request, and optional schedules run in their own sessions. Desktop notifications are opt-in. Scheduled tasks still pause for user confirmation; they never approve themselves.

**Accounts and payment:** bside requires either Sign in with ChatGPT with compatible plan access, or an OpenAI API key with billable API access. OpenAI may charge for use; bside does not include a model subscription or API credit. Connected services may require their own accounts/plans. This is an independent extension, not an OpenAI or Mozilla product.

**Privacy:** Your prompts, relevant page content and URLs, screenshots/tool results, selected connected-account data, and saved context used for a task are sent to OpenAI. Website actions and connected-account calls send data to those websites/services. Search queries go to your default search engine. Cookies are read directly only for the YouTube site API; ordinary websites use your normal browser session. Chats, memory and workspace are stored in this Firefox profile; credentials are device-key sealed. There is no bside-operated backend, cloud sync, telemetry, or automatic problem-report upload. Reports can be downloaded locally with conversation content excluded. Read the full privacy policy before use.

**Compatibility and limits:** Firefox desktop 140+ only; Firefox restricted pages cannot be controlled. AI can be wrong: inspect answers and consequential changes. PDF reading extracts text, not OCR, and may require another eligible web tab; password-protected/oversize files are refused. Synthetic interactions do not trigger browser shortcuts, and CSS-only hover menus are unsupported. One run is active at a time. OpenAI-hosted search fallback, arbitrary MCP servers, native local-server bridge, and Chrome/MV3 are not included. MCP resource mentions and prompt invocations must be added to this copy only after the final Phase 5 layer is integrated and tested.

**Support/source:** https://github.com/the-snesler/bside (never attach sensitive raw exports to public issues).

**Privacy-policy URL:** Maintainer must publish and insert a stable public URL for the policy in `docs/privacy.md` before AMO submission.

**Screenshots:** Capture actual Firefox sidebar, first-run setup, confirmations, privacy/report settings, and connection controls from the final package. No fabricated or untested platform screenshots.
