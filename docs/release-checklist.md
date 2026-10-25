# Release candidate checklist

This is preparation for review, not an AMO submission or a claim that the complete roadmap has shipped. Do not merge or publish from these scripts. The final maintainer/parent owns independent review and the manual gates below.

## Integration and roadmap coverage

- [x] Restack `feat/release-prep` onto `feat/automation` at `7b8b830`, including search/PDF and entry points. The combined manifest preserves the intended permissions, data declaration, and restricted CSP.
- [x] Integrate the final Phase 5 MCP prompt/resource layer above release prep at `f994ef4`: namespaced `/` prompts, `@` resources, bounded previews, immutable snapshots, memory taint, sidebar/session ownership, and scheduler/report isolation. Privacy/reviewer/listing copy describes the implemented data flows.
- [x] Audit the assembled automated boundaries and address the three MCP review findings: serialize every queue mutation, preserve catalog authorization across protocol-session recovery, and retain delivered-steer source previews. The final head, exact base, checks, and artifact hashes are recorded in [PR #19](https://github.com/the-snesler/bside/pull/19). The parent owns fresh independent review; native API verification and AMO approval remain manual.
- [x] Phase 6.3 preparation: privacy policy and guarded manifest data declaration; native first-run page and revisit links; narrow layout/keyboard changes; reproducible source submission; reviewer permission notes and listing draft.
- [x] Phase 6.4 implementation: options-only, background-owned, validated local problem reports with an explicit metadata allowlist; no content opt-in or sender; separate raw export remains sensitive.
- [x] Phase 6.1/6.2 integration: persistent alarms, dedicated results sessions, and opt-in local notifications. Contract tests cover confirmation/help pauses, MCP write gates, restart recovery, and isolation from unsent menu drafts. Native Firefox checks remain below.

Earlier foundations, device-key credentials, sessions/history/compaction/steering/usage, instructions/site notes/skills/memory, screenshot/frame/table/page-action support, and MCP directory/OAuth/tools have contract tests in the stack. This release-prep task did not rerun the live benchmark or measure prompt-cache cost on the seven benchmark tasks; those roadmap evidence items remain manual. Search through the default engine, bundled PDF text extraction, menu/shortcut entry points, and quick actions are included in the assembled automated checks; native verification remains below.

**Optional/deferred work:** OpenAI-hosted `web_search` fallback remains unimplemented; user search is the default-engine path. No third-party hosted search or bside backend is planned. Native stdio MCP bridge/bside-as-MCP-server, arbitrary MCP URLs, cloud sync, additional providers, and Chrome/MV3 are outside this release. MCP resource mentions and prompt invocations are implemented and covered by the integration item above; live authenticated service checks remain below.

## Automated release gates

From the final clean checkout, using Node 22.22.3 and Corepack's pinned pnpm 11.22.0:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm exec wxt prepare
corepack pnpm typecheck
corepack pnpm test --maxWorkers=2
corepack pnpm build
corepack pnpm lint:ext
corepack pnpm check:manifest
corepack pnpm source:verify
corepack pnpm zip
```

- [x] Focused regressions, strict typecheck, **1,005 tests in 55 files** (two workers), production build, lint, and manifest guard pass for the final implementation. Source verification repeats typecheck/build/manifest from the committed archive.
- [x] Lint has **zero errors and nine documented bundled-code warnings**; reviewed against [amo-reviewer-notes.md](amo-reviewer-notes.md). This is not a warning-free claim.
- [x] Source ZIP (207 committed allowlisted files, including `pnpm-workspace.yaml`) rebuild matches every production file byte for byte. Secret/local/generated files and dependencies are excluded. Source commit and final ZIP SHA-256 values are recorded in the PR handoff.
- [x] Inspected the generated manifest: MV2 persistent background, sidebar/options, desktop consent minimum 140, Android consent floor 142 (desktop listing only), accurate required data categories, scoped network policy, and the intended notification API permission with off-by-default local controls.
- [x] Reviewed extension ZIP: **21 files**, matching every current production file byte for byte; locally bundled workers/scripts only, no `.map`, sourceMappingURL, remote executable assets, or development HMR policy.

## Native Firefox manual gates

The release-prep environment has **no Firefox executable**: WXT launch returned `not found: firefox`. T3's browser rendered production pages with an injected fake background on localhost. Those render checks do not exercise install consent, OAuth, sidebar gestures, browser search, PDF loading, hidden-tab capture, alarms, notification prompts, or live MCP services.

- [ ] Install in a clean desktop Firefox 140+ profile and a current stable profile; inspect required data consent. Confirm rejection prevents install, and one local onboarding tab appears only on a new install. Revisit it from History & privacy.
- [ ] Sign in with ChatGPT and an API key separately; confirm disconnect and stale credentials/registration recovery. Verify applicable account/token-sharing terms before distribution. Supply reviewer-only test access privately through AMO.
- [ ] Pin the toolbar button and open sidebar by a real click/shortcut. Onboarding never signs in or starts the sample automatically. Test keyboard-only focus, visible rings, settings menu open/close/Tab containment/Escape, selected-route focus, history confirmation cancel, table/code scrolling, and labels at 240/320/480 px and 200% zoom, light/dark/reduced-motion. Use a screen reader for announcements.
- [ ] Exercise page/frame actions, stale refs, screenshots including hidden-tab fallback, help/approval/cancel/retry, and session ownership in Firefox fixtures. Confirm no unwanted effect after denial/cancel.
- [ ] Search with Google/Bing/DuckDuckGo as the user's default; test fresh-profile consent/CAPTCHA and no silent engine switch. Read the bundled PDF fixture in Firefox with and without another eligible content-script tab, test private/authenticated PDFs, navigation invalidation, large/password/scanned PDFs, and packaged worker CSP.
- [ ] Exercise context-menu entry points, sidebar keyboard command, draft-only sample/quick actions, and correct attached-tab semantics.
- [ ] Test a scheduled read task, browser downtime/restart, busy-run handling, pause for confirmation/help, and notification preference opt-in/off and OS permission denial/revocation. Notification text must not expose task/page content.
- [ ] Connect/refresh/disconnect Notion and Todoist with dedicated accounts; test origin enforcement, denied writes, token expiry, and prompt/resource arguments, text previews, disconnect/refresh invalidation, replay after remote edits, and binary placeholders.
- [ ] Put distinctive private page text and a dummy token/URL in a fixture/chat. Download the redacted report for that chat and another: no content, selected MCP attachment names/URIs/text, titles, URLs, tool names/payloads, request IDs or tokens; latest-run diagnostics appear only for their owning chat. Check the download is local and no transmission occurs. Raw history export is separately labeled sensitive.

## Manual AMO steps (external, not automated)

- [ ] Choose release version/license/platform metadata and produce matching final ZIP/source artifacts. Recheck Mozilla policy/schema links in reviewer notes at submission time.
- [ ] Review and publish the privacy policy at a stable public URL, and set that URL in AMO. The bundled `privacy.html` is available before any task; it is not a hosted policy URL.
- [ ] Edit [amo-listing-draft.md](amo-listing-draft.md), confirm final feature copy, add genuine screenshots, support/source links, and actual payment/account requirements. No fabricated store listing, review, user count, or claim of Mozilla approval.
- [ ] Manually upload the extension ZIP, corresponding source ZIP, exact [source-build.md](source-build.md), reviewer notes and test access to AMO. Address reviewer findings. No script uploads anything.
- [ ] Only the authorized maintainer may complete signing/listing publication. This task does not merge PRs, sign, or publish.
