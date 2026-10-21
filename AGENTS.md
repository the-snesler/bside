# ai-firefox-extension

bside: a Firefox desktop extension built with WXT, Manifest V2, Preact, TypeScript, Pi (`@earendil-works/pi-ai`, `pi-agent-core`), and pnpm.

## Toolchain and scripts

- **Node:** `>=22.19`
- **Package manager:** pnpm `11.22.0`, pinned in `package.json`. Use `corepack` and `pnpm`; do not add npm/yarn lockfiles.
- `pnpm dev` — start WXT development mode; load the generated Firefox extension through WXT/Firefox.
- `pnpm typecheck` — strict TypeScript check (`tsc --noEmit`).
- `pnpm test` — run all Vitest tests.
- `pnpm build` — build the Firefox MV2 production bundle into `.output/firefox-mv2/`.
- `pnpm zip` — create a distributable archive from the production build.
- `pnpm lint:ext` — run `web-ext lint` on the production build; fails on errors only.
- `pnpm check:manifest` — compare the built manifest's permissions/CSP/content-script matches/background/gecko ID against `scripts/manifest-snapshot.json` and fail on any `.map` file; after an intentional change, run `pnpm check:manifest --update` and commit the snapshot.
- CI (`.github/workflows/ci.yml`) runs install, typecheck, test, build, `lint:ext`, and `check:manifest` on pushes to `main` and on all PRs.

Before committing behavioral changes, run the narrow affected test file, then `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Repository map

```text
entrypoints/
  background.ts        Persistent MV2 background-page entrypoint and listener registration.
  page.content.ts      Top-frame HTTP(S) content-script message adapter.
  sidepanel/           Native Firefox sidebar Preact surface.
  options/             Options-page Preact surface for credentials/settings.

lib/
  background/
    runtime.ts         Sole owner of runs, the open session and session commands, persistence, cancellation, retry, terminal transitions, agent-tab ownership.
    agent-loop.ts      Pi Agent orchestration, system policy, run budgets, approvals, exactly-once tool ledger.
    browser-program.ts browser_program parser/interpreter, tab mounts, /workspace, web.search, agent-tab state.
    tab-controller.ts  Bound-tab capture, page RPC, navigation settlement, tab hide/close, agent-tab session tags.
    sidebar-hub.ts     Sidebar Port transport, snapshots, sequencing, replay buffer.
    approval-badge.ts  Toolbar "!" badge while a run awaits confirmation.
    chatgpt-auth.ts    Sign in with ChatGPT: OAuth, token refresh, device-key-sealed credential.
    device-key.ts      Non-extractable AES-GCM device key; seals and opens stored credentials.
    device-key-store.ts  Thin IndexedDB adapter holding the device CryptoKey.
    chatgpt-browser-auth.ts  Sign-in popup; captures the loopback OAuth callback with blocking webRequest.
  domain/              Framework-independent conversation, provider, and tool contracts; `run-digest.ts` builds and renders run digests; `usage.ts` holds run usage and totals.
  providers/
    openai.ts          Pi OpenAI Responses adapter: request policy, cache options, safe error envelope.
    openai-models.ts   Source-controlled API-key model catalog/defaults.
  tools/
    page-executor.ts   Pure DOM snapshot/action semantics used by the content script.
  ui/
    use-background.ts  Preact hook consuming the sidebar Port; renders background state.
    turns.ts           Groups conversation items into turns and activities; sums each turn's run usage.
    usage.ts           Compact token/cost labels for turn footers and history rows.
    TurnTrace.tsx      Per-turn work trace (built on Trace.tsx).
    Composer.tsx       Slate prompt editor with tab mentions.
    Markdown.tsx       Model-text Markdown without raw HTML, remote images, or unsafe links.
    HistoryDrawer.tsx  Sidebar chat history: title search, inline rename, pin, export, two-step delete.
  protocol.ts          Versioned cross-context request/event unions and type guards.
  validation.ts        Runtime validators for prompts and tool arguments.
  storage.ts           Versioned `storage.local` records: settings, sealed credentials, chunked conversation sessions, per-session message queues, history retention, legacy migration, interrupted-run recovery.

styles/theme.css       Shared system-adaptive design tokens.
public/                Packaged static extension assets.
tests/                 Vitest contract tests; helpers/pi-provider.ts fakes Pi streams; fixtures hold deterministic test pages.
scripts/
  check-manifest.mjs   Built-manifest drift and source-map guard (`pnpm check:manifest`).
  manifest-snapshot.json  Committed expected permissions/CSP/content scripts/background/gecko ID.
.github/workflows/ci.yml  CI checks listed above.
wxt.config.ts          Firefox MV2 manifest, permissions, CSP, and Preact Vite setup.
```

## Architecture invariants

- The persistent background page owns credentials, OpenAI requests, active-run state, persistence, cancellation, event sequencing, and approval gates.
- The sidebar and options pages render background-owned state. They must not read credentials, own streams, or implement tool loops.
- The content script owns the live DOM and executes only the closed page-tool union. Never pass provider credentials, raw prompts, generated JavaScript, or arbitrary selectors into it.
- `lib/domain/*` and `lib/protocol.ts` are the cross-context contracts. Keep values JSON-compatible, versioned, and runtime-validated.
- Pi is the provider boundary. Outside tests, runtime `@earendil-works/pi-ai` imports belong only in `lib/providers/openai.ts` and `@earendil-works/pi-agent-core` only in `lib/background/agent-loop.ts`; `lib/domain/provider.ts` and `agent-loop.ts` may import Pi types. No other provider SDK.
- The system prompt and tool definitions are a byte-stable cacheable prefix: no per-run content goes there. The attached page outline rides on the current user turn. Requests use `cacheRetention: "short"` with `sessionId` = conversation id, which Pi sends as `prompt_cache_key`.
- Model history is rendered from session items by `renderHistory` in `agent-loop.ts`, deterministically, so earlier turns replay byte-identically across runs: user/assistant text (delivered steers as plain user messages where the model received them), each run's `run-digest` as a user-role note after its answer (newest within `DIGEST_REPLAY_CHARS`, dropped in steps), and, after a `compaction`, its summary note in place of every item before `firstKeptItemId`. Prior tool calls/results are never replayed. Digests and summaries are untrusted page-derived notes: label them so, never put them in the system prompt.
- A run digest is built by the background from the tool ledger (sources, URLs read, bounded result excerpts, failures, confirmations), never from model text, and appended at every terminal state (rebuilt from persisted calls on interrupted-run recovery). At run start, when the estimate passes 60% of the model's `contextWindow`, older turns are summarized with Pi's `compact` through the provider adapter and persisted; on failure the run continues, leaving the oldest turns out of that request only. Compaction never deletes items; the sidebar shows an "Earlier conversation summarized" marker.
- Usage: each run's provider-reported tokens (compaction calls included) accumulate in a `RunUsageV1`, published as `run.usage`, kept in the run checkpoint, and appended at every terminal state (on interrupted-run recovery, as checkpointed) as the `run-usage` item `usage-<runId>`, only if tokens were reported. It is never sent to the model. `costUsd` is an API-key-only estimate, summed from Pi's per-response `usage.cost` (its bundled catalog prices, long-context tiers included) and fixed at run end; ChatGPT-plan runs and models with no bundled price record `null` and show "plan usage" or tokens, never dollars. Never fetch prices. `touchSession` adds the ended run's usage to `ConversationSummary.usage` (O(1), no item rescans; missing or invalid totals read as zero). A turn's footer sums all its runs (retries, steered rounds); the history row shows the session total.
- Runs have budgets (`DEFAULT_RUN_LIMITS` in `agent-loop.ts`: provider rounds, active wall-clock time, output tokens), checked between rounds. Exceeding one fails the run with `LIMIT_EXCEEDED` and keeps committed effects. Time awaiting confirmation does not count.
- Conversations are sessions with opaque ids: `local:conversationIndex` lists them; each has a `conversation:<id>` record (the item count, the commit point) and 32-item `conversation:<id>:items:<n>` chunks. Appends write only the tail chunk and record, never a whole history; the index is rewritten only by session commands, pruning, and at turn boundaries, and every rewrite is pushed to all sidebars as `session.listed`. `local:openConversation` is the session the sidebar shows. Run-local replay state and full page snapshots must not enter persistent storage; run digests keep only bounded excerpts.
- One run is active globally. It stays bound to the session it started in (`activeRun.conversationId`, run events' `conversationId`) while the user views or creates other sessions; deleting its session is refused. New chat reuses an untouched open session, and leaving an untouched session deletes it.
- History retention (`local:historySettings`: `forever` | `30d` | `7d`, default `forever`) deletes unpinned sessions by index `updatedAt` at startup, when changed, and hourly from the sweep timer; never the open session or the active run's. "Delete all history" deletes every session except the active run's, pinned included, and opens a fresh empty one. Both are options-page `history.*` requests, never sidebar commands.
- `context.export` exports one session by id. Latest-run diagnostics, model input, tool output, and scratch files appear only in the export of the session that run belongs to.
- `run.retry` re-runs the open session's last failed, cancelled, or interrupted turn against its existing user message (plus any steers that attempt delivered) and never appends a user item. It is refused if that attempt committed (or, after an interruption, may have committed) a page effect. Run checkpoints record their session, and recovery writes the interrupted marker there.
- Talk while it works: while the active run belongs to the open session, `run.start` queues a follow-up and `run.steer` hands guidance to the run's Pi steering queue (`steeringMode: "all"`). Pi injects steers after the current round's tool results (or after a final answer, costing one more budget-checked round); the delivered steer is persisted then as a user item with `delivery: "steer"` and the queued id, and published as `steer.delivered`. A steer is part of its turn: never a turn start, compaction cut point, retry target, or title (`isTurnStart`). Follow-ups are a runtime queue, not Pi's: each becomes its own turn, dispatched oldest-first only after a completed run, keeping its queued id as its user item id. Undelivered steers become follow-ups when the run ends; after failure, cancellation, or interruption nothing auto-sends. Queues persist per session as `local:queue:<id>` (`MessageQueueV1`, ≤20), pushed as `queue.changed`; on load, entries whose id is already an item are dropped.
- Ref-bearing page actions require the exact latest snapshot revision. Surface the real revision in text returned to the model; never guess stale targets.
- The model uses `browser_program` for bounded capability programs and `request_action_confirmation(title, message, artifact)` before externally visible, destructive, or paid actions. Deciding when to ask is model policy; the background pauses only for explicit confirmation calls and records the decision. Do not reintroduce automatic per-action or per-program approvals. While a confirmation is pending, the toolbar shows a `!` badge, which clears on resolve, cancel, terminal state, and startup. Clicking the toolbar button then opens the sidebar instead of toggling it.
- Browser programs are parsed and interpreted, never evaluated as JavaScript. Locators resolve uniquely against a fresh snapshot before each effect. Stop on the first failure and retain earlier effects.
- `/tabs/<id>/page.md` and `/agent-tabs/<id>/page.md` are live read-only snapshots. Explicit cross-mount moves hide/show tabs; removal closes them. `/workspace` is bounded per-session scratch storage (64 files × 32k chars), persisted as one `local:workspace:<sessionId>:<slot>` record per file, written through before a program reports the change, revalidated on read, and deleted with its session; never host filesystem access.
- Agent-tab ownership lives on the tabs themselves as a versioned `sessions` tab value (`AGENT_TAB_TAG_KEY`, v2: role `agent`/`search`, owning `sessionId`, and `lastUsedAt`), which Firefox keeps across browser restarts, session restore, and undo-close even though it reassigns tab IDs. Every agent tab, search tabs included, belongs to one chat session; a run sees and reaches only its own session's agent tabs (others are absent from both mounts), and each session gets its own search tab. Opening, adopting, and moving a tab into `/agent-tabs` tags it with the run's session. Moving it to `/tabs` untags it, and so does closing it, before the tab is removed. At startup and on `tabs.onCreated`, a tab is adopted only if it carries a valid v2 tag and is hidden; a tagged tab that is visible is untagged and left to the user, never re-hidden. A legacy v1 tag names no session and is never adopted: its hidden tab is shown and untagged. Never adopt an untagged tab by ID or URL. Switching sessions leaves agent tabs alone. Deleting a session closes its agent tabs, or shows and untags them if the user keeps them; retention and "Delete all history" close them, and the retention sweep also closes tabs whose session no longer exists. Agent tabs unused for 30 minutes are auto-closed. Idle close and the sidebar's "Close agent tabs" (the open session's only) are refused while a run is active.

## Security and privacy boundaries

- The API key and ChatGPT tokens live only in background memory and in `storage.local`, sealed with the device key; the API key is also entered in the options password field. Never put them in sidebar events, content-script messages, page DOM, fixtures, logs, tests, or source.
- The device key (`lib/background/device-key.ts`) is a non-extractable AES-GCM `CryptoKey` kept in the extension's IndexedDB and loaded silently. Never store a credential in plaintext or reintroduce a PIN. A record the key cannot decrypt is deleted and reads as not connected.
- Page content, tool output, and model output are untrusted text. Render them as Preact text nodes (model Markdown only through `lib/ui/Markdown.tsx`); do not inject HTML.
- Do not widen CSP or permissions casually. CI fails on drift; for an intentional change, run `pnpm check:manifest --update` and commit the snapshot. Production `connect-src` permits only `https://api.openai.com` (Responses, models) and `https://auth.openai.com` (ChatGPT OAuth).
- Permissions: `storage`; `identity` for the redirect-URL subdomain in the ChatGPT callback path; `webRequest` + `webRequestBlocking` to cancel that `http://127.0.0.1` callback, filtered to the sign-in popup tab; `tabHide` for the agent-tab workspace; `sessions` to tag agent tabs so ownership survives a browser restart; host access to `api.openai.com` and `auth.openai.com`; and `http://*/*` + `https://*/*` for the declarative page content script, tab URLs, and the callback filter, not for background fetching.
- Never add arbitrary page JavaScript execution, CSS/XPath selectors, remote code, external fonts/scripts, cookies, clipboard, downloads, `tabs`, or `scripting` permissions without an explicit design change.
- Keep `store:false`, `parallel_tool_calls:false`, and `maxRetries:0` in the OpenAI Responses API integration unless the run state machine is deliberately redesigned.

## Development practices

- Read the existing call path before editing a contract or exported symbol. Update every caller in one cutover; do not add compatibility aliases or shims.
- Prefer a focused regression test that fails before a bug fix. Test observable behavior: message validation, lifecycle transitions, page effects, error classification, and security boundaries.
- Keep DOM behavior in `lib/tools/page-executor.ts`; `entrypoints/page.content.ts` should remain a thin validated adapter.
- Keep browser API behavior behind the existing adapters/factories so it remains testable with fake APIs.
- Provider errors must become `NormalizedError` values with a safe message, status, request ID, phase, and retryability. Never forward raw API response bodies or headers.
- A retryable provider error is retry-safe only when no consequential page effect committed during the failed run.
- Cancellation is terminal and idempotent. Preserve uncommitted partial assistant text as visibly interrupted; never replay or roll back page effects.
- Generated `.wxt/` and `.output/` files are build artifacts. Do not edit or commit them.
- `.env` is local-only. Do not read, log, copy, or commit secrets from it.

## Verification checklist

1. Run the narrow changed test file while developing.
2. Run `pnpm typecheck`.
3. Run `pnpm test`.
4. Run `pnpm build`.
5. For manifest/CSP/permission changes, inspect `.output/firefox-mv2/manifest.json` after the production build and run `pnpm check:manifest`. Confirm MV2 persistent background, `sidebar_action`, options UI, only expected permissions, and no source maps or remote executable assets.
6. For sidebar or options UI changes, load the extension in Firefox and exercise the actual native surface at narrow sidebar width.
7. For page-control changes, use `tests/fixtures/agent-page.html` and confirm the changed action in Firefox, including approval behavior and stale-ref handling.
