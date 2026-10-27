/**
 * Domain types for the page tool vocabulary: the closed action union the
 * content script executes, and the bounded page outline the agent observes.
 * Independent of WXT, Preact, Firefox, and OpenAI — nothing here imports a
 * browser or SDK type.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ToolCall {
  id: string;
  /** A built-in tool, or a connected account's tool exposed as `mcp__<server>__<tool>`. */
  name: "browser_program" | "request_action_confirmation" | "request_user_help" | "current_time" | `mcp__${string}`;
  arguments: JsonValue;
  /** For an MCP tool: the directory server, the server's own tool name, and whether it is annotated read-only (a call of any other counts as a committed effect). */
  mcp?: McpCallInfo;
}

export interface McpCallInfo {
  server: string;
  tool: string;
  readOnly: boolean;
}

/** What `request_user_help` asks the user to do in an agent tab. */
export const HELP_KINDS = ["login", "verification", "information", "permission", "other"] as const;
export type HelpKind = (typeof HELP_KINDS)[number];
export const MAX_HELP_REASON_CHARS = 1000;
/** The optional note the user may send back with "Can't help". */
export const MAX_HELP_NOTE_CHARS = 500;

/**
 * Identifies one element for a DOM action. A ref is only meaningful inside the
 * document that issued it, so ref targets carry that document's id; role
 * targets are resolved uniquely against the live document immediately before
 * the effect.
 */
export type ElementTarget =
  | { kind: "ref"; ref: string; documentId: string }
  | { kind: "role"; role: string; name: string | null; exact: boolean };

/** A `/workspace` file attached to a file input: text, or a binary's base64 bytes. Never host files. */
export type UploadFile =
  | { name: string; mimeType: string; text: string }
  | { name: string; mimeType: string; base64: string };

export type NamedKey = "Enter" | "Tab" | "Escape" | "Space" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" |
  "Home" | "End" | "PageUp" | "PageDown";
/** A letter or digit; pressed only together with Control, Alt, or Meta (bare text is typed with fill). */
export type CharacterKey = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m" | "n" | "o" | "p" | "q" | "r" | "s" | "t" |
  "u" | "v" | "w" | "x" | "y" | "z" | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type PressKey = NamedKey | CharacterKey;
export type KeyModifier = "Control" | "Alt" | "Shift" | "Meta";

/** The closed set of effects the content script may perform. */
export type DomAction =
  | { kind: "click"; target: ElementTarget }
  /** Moves the pointer onto the element (over/enter/move events), leaving the one hovered before. */
  | { kind: "hover"; target: ElementTarget }
  /** Drags the target onto `to`, both in one document: HTML drag and drop for a draggable source, pointer events otherwise. */
  | { kind: "drag"; target: ElementTarget; to: ElementTarget }
  /** With `commit`, Enter and blur follow the text, as a typed-date picker needs to accept it. */
  | { kind: "fill"; target: ElementTarget; text: string; commit?: boolean }
  | { kind: "select"; target: ElementTarget; values: string[] }
  /** Picks the one option matching `option` in a native select or an ARIA combobox/listbox: opens it, types to filter if editable, waits for options. */
  | { kind: "choose"; target: ElementTarget; option: string }
  | { kind: "check"; target: ElementTarget; checked: boolean }
  /** A key, optionally held with modifiers (`Control+Enter`); a closed set that never includes copy, cut, or paste. */
  | { kind: "press"; target: ElementTarget; key: PressKey; modifiers?: KeyModifier[] }
  | { kind: "upload"; target: ElementTarget; files: UploadFile[] }
  | { kind: "scroll"; target: ElementTarget | null; direction: "up" | "down" | "left" | "right"; amount: "line" | "page" };

export type PageErrorCode =
  | "UNSUPPORTED_PAGE"
  | "TAB_CHANGED"
  | "STALE_SNAPSHOT"
  | "TARGET_MISSING"
  | "NOT_INTERACTABLE"
  | "NAVIGATION_INTERRUPTED";

export interface ToolResult {
  ok: boolean;
  /** `TOOL_ERROR`: a connected account's tool reported failure or the server rejected the call; `CONNECTION_ERROR`: bside could not reach or sign in to the server. */
  code?: PageErrorCode | "ACTION_DENIED" | "LIMIT_EXCEEDED" | "INVALID_TOOL_ARGUMENTS" | "SKIPPED" | "TOOL_ERROR" | "CONNECTION_ERROR";
  summary: string;
  data?: JsonValue;
}

/**
 * One bounded slice of a page outline. The outline is markdown-like text in
 * document order with interactive elements inlined as `[e12 button "Save"]`.
 * Refs stay attached to the same element for the document's lifetime.
 */
export interface PageSnapshot {
  version: 2;
  tabId: number;
  documentId: string;
  url: string;
  title: string;
  text: string;
  /** Character offsets of this slice within the full outline. */
  offset: number;
  end: number;
  totalChars: number;
  selectionText: string;
  /**
   * Document id of each cross-origin frame composed into the outline, by its
   * name (`f3`); their refs (`f3:e12`) resolve against these. Absent when there are none.
   */
  frames?: Record<string, string>;
  /** Set when the tab shows a PDF: the outline is its text, read-only, with no refs. */
  pdf?: { pages: number };
}

/**
 * A cross-origin frame in a frame's outline. Its own content script reads it;
 * the background replaces the placeholder line with that outline.
 */
export interface ChildFrame {
  /** Firefox's frame id (`runtime.getFrameId`), as `tabs.sendMessage` addresses it. */
  frameId: number;
  /** Index of the frame's placeholder line in the outline's `lines`. */
  line: number;
  title: string;
  /** The frame element's `src`; the frame's own outline reports where it actually is. */
  url: string;
}

/** One frame's whole (bounded) outline, for the background to compose a tab's outline from. */
export interface FrameOutline {
  documentId: string;
  url: string;
  title: string;
  lines: string[];
  frames: ChildFrame[];
  selectionText: string;
}

export interface PageFindResult {
  documentId: string;
  url: string;
  query: string;
  /** Total matching outline lines; `matches` may be capped. */
  count: number;
  matches: { offset: number; text: string }[];
  /** As `PageSnapshot.frames`. */
  frames?: Record<string, string>;
}

/** Bounds on one `page.table` read. */
export const TABLE_LIMITS = {
  /** Rows returned when the call names no limit. */
  defaultRows: 50,
  maxRows: 200,
  /** Columns past this are left out, and the result says so. */
  maxColumns: 50,
  cellChars: 300,
  /** Characters of cell text one read returns at most; it stops at a whole row and pages on from there. */
  maxChars: 40_000,
  /** Rows counted at most; a longer table is cut there. */
  maxScanRows: 20_000,
  maxOffset: 1_000_000,
} as const;

/** The table roles an outline lists (`[table e12 "Caption" 340 rows × 6 cols]`) and `page.table` reads. */
export type TableRole = "table" | "grid" | "treegrid";

/**
 * One page of a table's data rows as plain JSON: multi-row headers are
 * flattened to "Group / Column", row and column spans are expanded into
 * every cell they cover, and cell text is bounded. A cell lists the refs of
 * controls inside it (`Alice [e14 link]`).
 */
export interface PageTable {
  documentId: string;
  url: string;
  /** The table's ref as the model sees it: `e12`, or `f3:e12` in a cross-origin frame. */
  ref: string;
  role: TableRole;
  caption: string;
  headers: string[];
  rows: string[][];
  /** Data rows in the table (header rows are not counted). */
  totalRows: number;
  offset: number;
  /** Where the next page starts, or null after the last row. */
  nextOffset: number | null;
  /** Cut columns, a capped row count, or rows a virtualized grid has not rendered. */
  note?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Most organic results one `web.search` returns. */
export const SEARCH_RESULT_LIMIT = 10;

/** The engines with their own result extractors; any other engine's page is read generically. */
export type SearchEngineId = "google" | "bing" | "duckduckgo" | "other";

/**
 * What the search tab shows after a search with the user's default engine:
 * a compact result list, never a page snapshot. `blocked` is set when the
 * engine shows a consent wall or a CAPTCHA instead of results; only the user
 * can clear it.
 */
export interface SearchPage {
  engine: SearchEngineId;
  /** "Google", "Bing", "DuckDuckGo", or the page's host name. */
  engineName: string;
  url: string;
  results: SearchResult[];
  /** A featured snippet, direct answer, or knowledge panel, as one short block. */
  answer: string | null;
  blocked: "consent" | "captcha" | null;
  /** The start of the page's text, shown when nothing could be extracted. */
  excerpt: string;
}

/** A rectangle in CSS pixels, in document coordinates (relative to the top-left of the page). */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a screenshot can be taken from: the scrolled viewport, the whole page, and an optional target element's box. */
export interface CaptureGeometry {
  documentId: string;
  url: string;
  title: string;
  viewport: PageRect;
  page: { width: number; height: number };
  /** The target element's border box, or null when the capture has no target. */
  element: PageRect | null;
}

/** Summary of a captured page, safe to persist alongside a conversation turn. */
export interface PageArtifactSummary {
  artifactId: string;
  kind: "page";
  title: string;
  url: string;
  capturedAt: number;
}

/** Full run-local artifact, including the bounded snapshot; never persisted as-is. */
export interface PageContextArtifact extends PageArtifactSummary {
  /** `agent-tabs` when the user sent the message while watching one of the run's agent tabs. */
  target: { kind: "tab"; tabId: number; mount: "tabs" | "agent-tabs" };
  snapshot: PageSnapshot;
}

export type ContextArtifact = PageContextArtifact;
