# Release-prep accessibility evidence

Checked 24 October 2026 using T3's collaborative preview, rendering the production HTML/CSS/JS from `.output/firefox-mv2` on localhost. A separate, temporary fixture injected fake extension background state and a public sample conversation; it is not packaged. No credentials or live provider calls were used. WXT's native launch failed with `not found: firefox`, so this is browser-render evidence, not Firefox extension API, screen-reader, or install verification.

Observed and fixed:

- Narrow options menu: Escape previously left focus in the now-hidden search field. Escape now returns to the visible menu button; navigating moves focus to the page heading, including selecting the current route. While the narrow menu covers the settings pane, that pane is inert and Tab/Shift+Tab wraps through visible menu controls.
- Sidebar Markdown tables/code had no explicit keyboard focus target for horizontal scrolling. They now have labeled Tab stops. Table cells previously inherited `overflow-wrap: anywhere`, splitting ordinary words such as “column” at 240 px; normal word wrapping keeps those words intact while wide values scroll within the table.
- New onboarding uses native links/buttons, headings, a labeled read-only sample field, visible shared focus rings, wrapping text, and a direct-click sidebar action. It does not start sign-in or execute the sample.
- Problem reports use a labeled chat selector, status/error feedback, explicit Prepare and Download controls, and no automatic export on opening Settings.

Measurements/interactions in the preview:

- Options History & privacy at **320 × 720**: document scrollWidth 320, no offscreen element found; report preparation and its long chat selector also kept scrollWidth 320. Opening the menu focused “Search settings” and made the pane inert; Escape focused “Settings menu” and cleared inert.
- Sidebar at **240 × 720**: document scrollWidth 240; a long title and URL wrapped/truncated within the page; all visible interactive controls had names. The sample table viewport was 208 px, with ordinary words intact after the cell-wrap fix. A deliberately wide cell stayed within the horizontal scroll container and could be reached with keyboard focus; ArrowRight moved scrollLeft from 0 to 40 while the document remained 240 px wide.
- History at **240 × 720**: search received focus on opening; row actions and the delete-confirmation step stayed within document scrollWidth 240; Cancel received focus. Escape canceled deletion and returned focus to its initiating action.
- Onboarding at **240 × 720**: document scrollWidth 240; links, sidebar button, and sample field stayed inside the viewport. Account link wrapped within its button. The sample is selectable/read-only.

Automated contracts cover menu focus return/navigation, keyboard focus on Markdown tables/code, install-only onboarding, direct-click sidebar opening, no sample/sign-in auto-run, report request validation/options boundary/session isolation, secret/page-content exclusion, and deliberate selected-chat Blob download. See `tests/options-ui.test.ts`, `sidebar-ui.test.ts`, `onboarding.test.ts`, `problem-report.test.ts`, `problem-report-ui.test.ts`, and `runtime.test.ts`.

Remaining manual gates are in [release-checklist.md](release-checklist.md): actual native sidebar/options widths, browser zoom, all color/motion modes, screen-reader announcements, Firefox user gestures, and the assembled entry-point/automation/MCP-content layers. This is a focused pass with specific fixes, not a comprehensive accessibility conformance claim.
