# Browser workspace

The Pi agent has two tools: `browser_program({source})` and
`request_action_confirmation({title, message, artifact})`.

Programs use a small interpreted language: double-quoted strings,
arrays and objects containing values or calls (including object shorthand),
`const`/`let`, named variables, capability calls, `await`, and
`return`. They are never evaluated as JavaScript. There are no loops,
functions, imports, arbitrary properties, CSS selectors, or browser globals.
Each program allows 32 statements, 64 calls, and 16000 source characters.
Variables remain available for the current run; redeclaring replaces a value.

```js
return await fs.list("/tabs");
```

Results print automatically. Combine listings with
`return {tabs: fs.list("/tabs"), agentTabs: fs.list("/agent-tabs")};`,
or store them in variables and return `[tabs, agentTabs]`.
`JSON.stringify(value)` is a bounded formatting capability, not access to
arbitrary JavaScript globals. Nested calls execute sequentially, left to right.

`/tabs/<id>/page.md` and `/agent-tabs/<id>/page.md` expose fresh, bounded
markdown snapshots with URL, title, revision, and interactive elements.
Tab IDs keep paths stable across navigation. The files are read-only.
Listing a tab only proves its metadata is accessible. Browser-controlled
viewers and pages still loading may not expose a content reader. `fs.read`
and `page.snapshot` share that reader; changing methods or URL escaping does
not repair it. Errors preserve the page error code and tab path. Reuse the
existing tab, retry a snapshot once if loading, or navigate it to an HTML page.

```js
const page = browser.tab("/tabs/123/page.md");
await page.getByRole("textbox", {name: "Email", exact: true}).fill("fixture@example.com");
await page.getByRole("combobox", {name: "Priority", exact: true}).selectOption(["high"]);
return await page.snapshot("interactive");
```

Locators capture the tab, role, and exact name, and resolve again before
every action. Resolution scans matching DOM elements independently of the
displayed snapshot's node cap (up to 10000 candidates). Missing or ambiguous
targets, or an exhausted scan budget, stop the program.
The existing DOM executor still checks the exact snapshot revision.
Readable snapshots include up to 60 controls; interactive snapshots include
up to 300. Both include link destinations. Page text follows the visible
document, excluding hidden templates, rather than article-only extraction.
Available locator actions are `click`, `fill`, `selectOption`, and
`setChecked`. Page handles also support `navigate(url)`, `goBack()`,
`scroll(direction, amount)`, `snapshot(mode)`, and `path()`.

The model must call `request_action_confirmation` before externally visible,
destructive, or paid actions, including submission, shared autosaving edits,
deletion, purchases, and closing user tabs. It supplies a title, explanation,
and complete proposed artifact as plain text. The sidebar pauses for Approve
or Deny. The model receives `approved:true` or `ACTION_DENIED` with
`approved:false`. Deciding when to request confirmation is model policy;
the runtime does not independently classify or approve individual actions.

After confirmation, the model can submit in a subsequent program:

```js
await page.getByRole("button", {name: "Submit", exact: true}).click();
return await page.snapshot("readable");
```

Programs stop at the first failure or cancellation boundary. Earlier effects
are not rolled back; the result reports completed statements. Do not retry
the whole program. An effect already dispatched to Firefox can still finish
after cancellation. Tool call IDs are recorded to avoid duplicate execution,
and effect dispatch disables automatic run retry even if the response is lost.

`browser.open(url)` creates an inactive agent tab, hides it, waits for the
content script, and returns a page handle. Firefox controls which tabs can be
hidden and may show its own first-use notice. If hiding or readiness fails,
the result identifies the created tab so it can be recovered without opening
a duplicate. `fs.list("/agent-tabs")` includes actual visibility.

```js
const research = await browser.open("https://example.com");
return await research.snapshot("readable");
```

`fs.move("/agent-tabs/123/page.md", "/tabs/123/page.md")` shows a tab and
transfers it to the user mount; the reverse move hides it. The ID must stay
the same. `fs.remove(tabPath)` closes precisely that tab. Firefox may reject
hiding an active or pinned tab. No host filesystem operations are available.

Scratch files support `fs.write`, `fs.read`, `fs.list`, `fs.move`, and
`fs.remove` under `/workspace`. Limits are 64 files and 32000 characters per
file. Scratch files and agent-tab ownership last for the background session
and survive conversational turns, but are not durable memory across extension
or browser restarts. Full page output is available to the active model run;
only a compact completion record or failure diagnostic (including the failed
statement number) is persisted in the conversation, without full page output.

Download context includes a separate full-tool-output section for the latest
run, including every retained page snapshot exactly as returned to the agent.
This debug buffer is held in background memory and cleared on the next run,
context reset, or restart. It retains up to 2 million characters and explicitly
reports when earlier results were dropped. Snapshot extraction limits still
apply: the export contains agent-visible page output, not the entire DOM.

Validation: `pnpm test tests/browser-program.test.ts tests/browser-program-dom.test.ts tests/agent-loop.test.ts tests/runtime.test.ts`.
For live testing, serve `tests/fixtures` on localhost, reload the built
extension, prepare the fixture fields in one program, deny a submission
confirmation, then approve a newly requested submission. Also exercise
opening a hidden fixture tab and moving it into `/tabs`.
