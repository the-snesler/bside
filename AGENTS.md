# ai-firefox-extension

Firefox desktop extension built with WXT, Manifest V2, Preact, TypeScript, and pnpm.

## Toolchain and scripts

- **Node:** `>=22.13`
- **Package manager:** pnpm `11.22.0`, pinned in `package.json`. Use `corepack` and `pnpm`; do not add npm/yarn lockfiles.
- `pnpm dev` — start WXT development mode; load the generated Firefox extension through WXT/Firefox.
- `pnpm typecheck` — strict TypeScript check (`tsc --noEmit`).
- `pnpm test` — run all Vitest tests.
- `pnpm build` — build the Firefox MV2 production bundle into `.output/firefox-mv2/`.
- `pnpm zip` — create a distributable archive from the production build.

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
    runtime.ts         Sole owner of runs, persistence, cancellation, terminal transitions.
    agent-loop.ts      Provider/tool orchestration, approvals, exactly-once tool ledger.
    sidebar-hub.ts     Sidebar Port transport, snapshots, sequencing, replay buffer.
    tab-controller.ts  Bound-tab capture, page RPC, navigation settlement.
  domain/              Framework-independent conversation, provider, and tool contracts.
  providers/
    openai.ts          Only OpenAI SDK boundary; Responses API streaming and replay state.
    openai-models.ts   Source-controlled OpenAI model catalog/defaults.
  tools/
    page-executor.ts   Pure DOM snapshot/action semantics used by the content script.
  ui/
    use-background.ts  Preact hook consuming the sidebar Port; renders background state.
  protocol.ts          Versioned cross-context request/event unions and type guards.
  validation.ts        Runtime validators for prompts and tool arguments.
  storage.ts           Versioned `storage.local` records and interrupted-run recovery.

styles/theme.css       Shared system-adaptive design tokens.
public/                Packaged static extension assets.
tests/                 Vitest contract tests; fixtures hold deterministic test pages.
wxt.config.ts          Firefox MV2 manifest, permissions, CSP, and Preact Vite setup.
```

## Architecture invariants

- The persistent background page owns credentials, OpenAI requests, active-run state, persistence, cancellation, event sequencing, and approval gates.
- The sidebar and options pages render background-owned state. They must not read credentials, own streams, or implement tool loops.
- The content script owns the live DOM and executes only the closed page-tool union. Never pass provider credentials, raw prompts, generated JavaScript, or arbitrary selectors into it.
- `lib/domain/*` and `lib/protocol.ts` are the cross-context contracts. Keep values JSON-compatible, versioned, and runtime-validated.
- OpenAI SDK imports belong only in `lib/providers/openai.ts`.
- The extension has one persisted conversation (`"default"`). Run-local replay state and full page snapshots must not enter persistent storage.
- Ref-bearing page actions require the exact latest snapshot revision. Surface the real revision in text returned to the model; never guess stale targets.
- Consequential page actions require background-enforced approval. `page_snapshot` and bounded `page_scroll` are the only auto-run tools.

## Security and privacy boundaries

- The API key lives only in background memory / `storage.local` and the options password field. Never put it in sidebar events, content-script messages, page DOM, fixtures, logs, tests, or source.
- Page content, tool output, and model output are untrusted text. Render them as Preact text nodes; do not inject HTML.
- Do not widen CSP or permissions casually. Production `connect-src` permits only `https://api.openai.com`; broad HTTP(S) host access exists for the declarative page content script, not for background fetching.
- Never add arbitrary page JavaScript execution, CSS/XPath selectors, remote code, external fonts/scripts, cookies, clipboard, downloads, `tabs`, `scripting`, or `tabHide` permissions without an explicit design change.
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
5. For manifest/CSP/permission changes, inspect `.output/firefox-mv2/manifest.json` after the production build. Confirm MV2 persistent background, `sidebar_action`, options UI, only expected permissions, and no source maps or remote executable assets.
6. For sidebar or options UI changes, load the extension in Firefox and exercise the actual native surface at narrow sidebar width.
7. For page-control changes, use `tests/fixtures/agent-page.html` and confirm the changed action in Firefox, including approval behavior and stale-ref handling.
