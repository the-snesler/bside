# AMO reviewer notes (draft)

This is a release candidate for **Firefox desktop**, Manifest V2, persistent background page, add-on ID `bside@tsuni.dev`. Nothing in this repository submits or publishes the add-on. Submit the matching extension/source ZIPs and provide dedicated testing accounts through AMO's private reviewer channel; never place credentials in this file.

## Data consent and privacy

Policy/schema checked against Mozilla's current documentation on 24 October 2026:

- [Add-on Policies, data transmission and control](https://extensionworkshop.com/documentation/publish/add-on-policies/#data-collection-and-transmission-disclosure-and-control)
- [Built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Manifest browser-specific settings schema](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
- [Source submission and reproducible build requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/)

New AMO extensions must declare transmission even when it is the primary function. Desktop `strict_min_version: 140.0` ensures Firefox's built-in install consent is available. `gecko_android.strict_min_version: 142.0` supplies the corresponding consent floor; it does **not** establish Android support. Select desktop platforms only in AMO. Required categories are authentication information, browsing activity, website content/activity, search terms, identifying information, personal communications, location, financial/payment information, and health information. An unconstrained task may include those sensitive kinds of page/account content, and this build cannot selectively guarantee they are excluded from the model input. Bookmarks are not read through the browser bookmarks API. No technical/interaction transmission permission is requested: problem reports are local files and have no sender or upload path.

The full [privacy policy](privacy.md) is bundled as `privacy.html`, linked from first-run onboarding and History & privacy. It describes OpenAI, website interactions, the user's search engine, YouTube's cookie-backed read API, connected MCP accounts, local history/memory/workspace, sealed credentials, exports, and deletion controls. No bside-operated backend or telemetry exists. Required install consent does not automatically execute a task; onboarding does not sign in or run the sample.

## Permission justifications

Search/PDF, entry points, and automation are integrated below this layer. The explanations below match the combined manifest; they do not assert that native APIs have been exercised in Firefox.

- **`<all_urls>`**: content scripts run only in HTTP(S) documents/frames to read outlines and perform the closed action union; Firefox's `tabs.captureTab` requires this permission for bounded screenshots. Also permits tab URL inspection and the scoped OAuth callback. In the PDF layer, a content script fetches only the URL of a tab already showing a PDF; same-origin fetch can include that site's normal session credentials, cross-origin fetch is anonymous. This avoids widening the background's `connect-src`. No arbitrary URL fetch or generated JavaScript reaches the content script.
- **`webRequest` / `webRequestBlocking`**: (1) intercept/cancel the exact loopback OAuth callback path, `main_frame` only, filtered to and rechecked against the sign-in popup's tab; the listener is removed on completion/cancel. (2) on this extension's own background XHR to `www.youtube.com` only, replace `Origin: moz-extension://…` with the YouTube origin and remove the extension Referer. The header rewrite checks `tabId === -1` and the exact extension Origin; page requests and other extensions are left alone. These are the two uses; do not describe the entire permission as popup-only.
- **`cookies`**: read the YouTube SAPISID family solely for its read-only InnerTube site API. No cookie writes, general browsing-cookie export, MCP cookie use, or tokens in model input.
- **`identity`**: derive the extension-specific redirect subdomain used in ChatGPT and MCP OAuth callback paths.
- **`tabHide`**: keep per-chat agent/search tabs out of the user's ordinary tab strip; the tray can show, watch, hand over, and close them. Ownership is bounded by session.
- **`sessions`**: persist a versioned agent-tab ownership tag on tabs across Firefox session restore, rather than adopting by URL or tab id.
- **`search`** (search layer): `browser.search.query` runs the user's default engine in the session's search tab. It does not change engines, intercept unrelated searches, or use a bside-hosted search backend. CAPTCHA/consent walls require the user's help.
- **`menus`** (entry-point layer): selection/link/image context-menu entry points draft an explicit user request in the sidebar; they do not run the selected task automatically.
- **`alarms`** (automation layer): locally scheduled task wakeups. Unattended runs retain the normal confirmation pause; there is no auto-approval.
- **`notifications`** (automation layer): a declared API permission whose use is controlled by an explicit local preference, off by default. It supplies locally generated run-complete, pending-confirmation/help, and schedule-result alerts only after user opt-in. No notification server, telemetry, or automatic permission prompt on first run.
- **`storage`**: settings, local chat chunks/queues/workspace, memory, instructions/skills/site notes, scheduling preferences, and sealed credentials. Non-extractable AES-GCM key in IndexedDB; no storage sync.
- **`https://api.openai.com/*`**: Responses inference and model catalog; **`https://auth.openai.com/*`**: ChatGPT OAuth registration/discovery/grants/refresh/revocation. Stored credentials stay background-owned.
- **`https://mcp.notion.com/*`**: Notion MCP endpoint and OAuth issuer. **`https://ai.todoist.net/*`**: Todoist MCP. **`https://todoist.com/*`**: Todoist OAuth metadata, registration, token, and revocation. Each server has its own origin allowlist in `lib/mcp/servers.ts`; `mcpFetch` refuses redirects, non-HTTPS, cookies, and endpoints outside that entry. Users cannot supply arbitrary servers. Host entries are explicitly named even though `<all_urls>` covers them.

## Bundled code and lint findings

The integrated release layer passes `lint:ext` with **zero errors and nine warnings**: bundled DOM sinks, Function constructors, and dynamic imports, including PDF.js. These warnings remain for reviewer inspection. MCP previews render plain text only and introduce no additional remote origins, executable assets, or permission categories.

- Preact's renderer contains `innerHTML` support for its `dangerouslySetInnerHTML` API. bside does not use that API for page/model/MCP text. JSX text nodes and `Markdown` with `skipHtml`, no raw-HTML plugin, restricted link protocols, and disabled remote images render those inputs.
- The Markdown bundle's `innerHTML` comes from `decode-named-character-reference`: a temporary element decodes an entity token between `&` and `;`, then reads textContent. The `document().write` warning maps to `mdast-util-from-markdown`/micromark's `parse(options).document().write(...)`: `document()` returns a Markdown tokenizer, not the browser Document. It does not write HTML into the page. Keep these findings visible for upstream-source review; application raw-HTML rendering remains disabled.
- Slate's lodash dependency has a global-object fallback `Function('return this')`. Standard browser globals take the earlier branch; the CSP has no `unsafe-eval`, so string compilation is forbidden regardless. This layer has not exercised the fallback in native Firefox.
- Pi bundles a variable `import()` helper for lazy local provider modules. The app selects only the OpenAI Responses adapter; no remote module URL is accepted by the app. `script-src 'self'` and fixed `connect-src` remain unchanged. Other provider runtimes are not product capabilities.
- The PDF layer bundles PDF.js and its worker into local `pdf-text.js`. `globalThis.pdfjsWorker` supplies the worker implementation; the background starts a packaged worker. Text extraction disables font/image/canvas/wasm fetch paths. PDF.js retains Function/dynamic-import code, blocked by the extension CSP; this is a dependency warning, not permission for remote code. Real Firefox PDF/worker/CSP behavior remains a manual gate.

Production CSP is `default-src 'self'; script-src 'self'; object-src 'none'` with `connect-src` restricted to self, OpenAI API/auth, YouTube, and the three directory MCP origins; `img-src 'self' data:`; local styles allow inline CSS. No remote scripts/fonts, eval, arbitrary JS execution tool, source maps, broad `https:` fetch policy, or externally hosted PDF worker is added. Browser programs are parsed/interpreted against a bounded capability DSL. WXT's local HMR WebSocket is development-only.

## Review walkthrough

1. Install in Firefox desktop 140+ and inspect the data-transmission prompt. Confirm one local welcome tab on install and none on restart/update.
2. Follow Account settings and connect with a dedicated reviewer account or API key. Open the sidebar via a real click. Use a public fixture for the sample task.
3. Check narrow keyboard navigation, history confirmations, page-attachment labels, table/code scrolling, stop/retry, and manual help/approval pauses.
4. Use Notion/Todoist dedicated accounts to inspect read-only/write choices, confirmation, disconnect, and expiry behavior. Open `/` for namespaced account prompts beside saved skills, fill required/optional string arguments, and prepare a preview; open `@` for resources beside tabs. Nothing auto-sends. Inspect source labels and text-only previews, disconnect/refresh invalidation of unsent items, preserved accepted snapshots on retry/history, and safe refusal of arbitrary resource URIs.
5. Download Report a problem for a chosen chat; inspect metadata-only JSON. Attachment names, URIs, arguments and text must be absent, including accepted snapshots and namespaced command text. No network request is made. Compare the separate raw chat export, which deliberately carries sensitive conversation content.
6. Follow [source-build.md](source-build.md) to reproduce the build and compare bytes. Complete [release-checklist.md](release-checklist.md) before any manual submission.
