# Pointer control

Use this to click, hover, and drag at pixel coordinates read off a screenshot: canvases (drawings, games, maps, charts), sliders or knobs with no ref, and widgets the outline shows nothing to target in. Prefer refs whenever the outline gives one (`page.ref("e5").click()`): a ref follows its element, while coordinates only hold for the exact picture you read them from.

## Procedure

1. Get the page where you want it first (scroll, open the panel, pick the tab). Then take a screenshot: `await page.screenshot()` for the viewport, or `await page.ref("e7").screenshot()` to crop to one widget. Its result ends with an id like `[shot s1]`.
2. Read coordinates from that image, in its own pixels, from its top-left corner. When unsure what is under a point, `await page.elementAt("s1", x, y)` names it (with its ref when it has one) and gives its box in the image's pixels: use the box to find exact centers and edges.
3. Act with `clickAt`, `dragAlong`, or `hoverAt` (below). Each result says what the first point landed on and lists the outline lines that appeared (+) or disappeared (−).
4. Check the result with a new screenshot after a short group of actions. A task may take only a few images, so plan a batch, act, then look once.

Coordinates from a shot stop working when the page scrolls, navigates, or the window is resized; the call then fails with `STALE_SNAPSHOT`. Take a new screenshot and read the coordinates again; never reuse old numbers on a new shot.

## Methods

```js
await page.clickAt("s1", 640, 360);                        // left click
await page.clickAt("s1", 640, 360, {double: true});        // double click
await page.clickAt("s1", 640, 360, {button: "right"});     // right click (contextmenu); "middle" for auxclick
await page.clickAt("s1", [[100, 80], [125, 80], [150, 80]]); // up to 100 clicks, one after another
await page.hoverAt("s1", 640, 360);                        // move the pointer there, no button
await page.dragAlong("s1", [[100, 80], [300, 80], [300, 200]]); // press at the first point, move through the rest, release at the last (2–500 points)
await page.elementAt("s1", 640, 360);                      // read only: what is there, and its box
```

Every point must be inside the screenshot. A `clickAt` call's points must all be in one frame; a drag stays in the frame it starts in. Points inside a frame from another site work like any other.

## Grids and drawings

- Measure first: `elementAt` on the canvas or board gives its box. For a grid of N columns, the cell width is the box width / N, and the center of column c (from 0) is `left + (c + 0.5) × cell`; the same for rows.
- Pick a color or tool first (click its swatch), then paint.
- Paint cells with one `clickAt` call listing their centers, row by row.
- Draw strokes with `dragAlong`: the pointer moves in small steps between the points you give, so a straight line needs only its two ends and a shape only its corners.
- If a stroke draws only part of the line or nothing, the page may draw only once per animation frame or may ignore synthetic input: click the cells one by one instead.
- Do not press the page's submit, send, or save control without the user's go-ahead: call `request_action_confirmation` first, as for any externally visible action.

## Limits

- These are synthetic events (`isTrusted` is false). Most pages accept them; some games, anti-bot checks, and widgets that require real pointer capture ignore them. Say so rather than retrying the same thing.
- The browser's own pointer behavior does not happen: no text selection, no native drag and drop of links or images, no scrolling by dragging, and menus that open only by CSS `:hover` stay closed.
- Read-only mode refuses `clickAt` and `dragAlong`; `hoverAt` and `elementAt` still work.
