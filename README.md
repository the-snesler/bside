# bside

bside is an AI agent that lives in Firefox's sidebar. You ask it for something and it reads and works with your open pages, searches the web with your own search engine, reads PDFs, and can use your connected Notion or Todoist accounts. Before it does anything consequential, such as submitting, buying, deleting, or sending, it stops and asks you to confirm.

It's a Firefox desktop extension (Manifest V2, Firefox 140 or later) built with [WXT](https://wxt.dev), Preact, TypeScript, and [Pi](https://www.npmjs.com/package/@earendil-works/pi-ai). Models are OpenAI's, used either with your ChatGPT plan through Sign in with ChatGPT or with an OpenAI API key.

## What it does

- **Chat about the page.** The current tab is attached as a text outline, including content from cross-origin frames. You can mention other tabs with `@`. The right-click **Ask** menu sends a selection, link, image, or the whole page to the sidebar as a draft. It never sends on its own.
- **Act on pages.** The agent writes small browser programs that bside parses and interprets. It never runs them as JavaScript. They can click, type, fill forms, pick options, hover, drag, press keys, read tables, and take screenshots, and every action is checked against a fresh snapshot of the page first.
- **Agent tabs.** The agent does its own browsing in hidden tabs that belong to the chat. You can watch one, take it over, or close them from the tray above the composer. While you watch, a shield blocks accidental input until you choose **Take over**.
- **Search** goes through Firefox's default search engine in a hidden tab. bside has no search service of its own.
- **PDFs** open in Firefox's viewer, and bside reads them as text.
- **Confirmation and help.** The agent asks before consequential actions, and it can pause for you to handle a login, CAPTCHA, or permission prompt. A permission menu under the composer switches between **Ask**, **Read-only**, and **Auto**.
- **Your context.** You can set custom instructions, per-site notes, saved skills (`/name`), and agent memory. Each memory records where it came from and is flagged if it was written after the agent read web content.
- **Connected accounts.** Notion and Todoist connect over MCP and OAuth. Each tool can be switched on or off, and each server can be set to always confirm writes ([docs/mcp.md](docs/mcp.md)).
- **Automation.** Scheduled tasks run in a hidden agent tab, and desktop notifications are opt-in.
- **History.** Chats are saved locally, and you can search, pin, export, or delete them, or set a retention period. Long conversations are summarized automatically, and each turn shows its token usage, plus estimated cost when using an API key.

## Getting started

You need Node 22.19 or later, Corepack, and Firefox 140 or later.

```sh
corepack enable
pnpm install
pnpm dev        # starts WXT and opens Firefox with the extension loaded
```

On first install bside opens a welcome page. To sign in, open the options page's **Account** section and either sign in with ChatGPT or paste an OpenAI API key. Then open the sidebar from the toolbar button or with Firefox's sidebar shortcut.

To build an unpacked production extension:

```sh
pnpm build      # writes .output/firefox-mv2/
```

You can load it temporarily from `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `.output/firefox-mv2/manifest.json`.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | WXT development mode |
| `pnpm typecheck` | Strict TypeScript check |
| `pnpm test` | Vitest suite (fake provider, no network or account needed) |
| `pnpm build` | Production Firefox MV2 bundle |
| `pnpm lint:ext` | `web-ext lint` on the build |
| `pnpm check:manifest` | Compares the built manifest's permissions and CSP to `scripts/manifest-snapshot.json` (`--update` after an intentional change) |
| `pnpm zip` | Extension ZIP |
| `pnpm source:archive` / `pnpm source:verify` | Builds the add-on store (AMO) source archive and checks that it rebuilds byte for byte ([docs/source-build.md](docs/source-build.md)) |

CI runs install, typecheck, test, build, `lint:ext`, and `check:manifest` on every PR and on pushes to `main`.

## How it's put together

- `entrypoints/`: the persistent background page, sidebar, options page, onboarding and privacy pages, the content script, and the PDF text worker.
- `lib/background/`: everything the background owns, including runs, the agent loop, tab control, sign-in, MCP, memory, skills, and the scheduler.
- `lib/domain/` and `lib/protocol.ts`: versioned, validated contracts used across contexts.
- `lib/tools/`: DOM snapshots and actions, the page shield, and search-result reading.
- `lib/ui/`: Preact components for the sidebar and options page.
- `tests/`: Vitest contract tests and fixture pages.

The background page owns credentials, model requests, and run state, and the sidebar and options page only render it. Page content, tool output, and model output are treated as untrusted text. [AGENTS.md](AGENTS.md) has the full repository map, architecture invariants, and security boundaries. Read it before changing a contract, a permission, or the CSP.

## Privacy

bside has no backend, telemetry, or cloud sync. Chats, memory, and settings stay in your Firefox profile. Credentials are encrypted with a non-extractable device key. Task content does go to OpenAI, to the websites the agent uses, to your search engine, and to any accounts you connect. See [docs/privacy.md](docs/privacy.md) for the details.
