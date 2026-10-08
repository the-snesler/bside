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
  name: "browser_program" | "request_action_confirmation";
  arguments: JsonValue;
}

/**
 * Identifies one element for a DOM action. A ref is only meaningful inside the
 * document that issued it, so ref targets carry that document's id; role
 * targets are resolved uniquely against the live document immediately before
 * the effect.
 */
export type ElementTarget =
  | { kind: "ref"; ref: string; documentId: string }
  | { kind: "role"; role: string; name: string | null; exact: boolean };

/** A text file from `/workspace`, attached to a file input. Never host files. */
export interface UploadFile {
  name: string;
  mimeType: string;
  text: string;
}

export type PressKey = "Enter" | "Tab" | "Escape" | "Space" | "Backspace" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** The closed set of effects the content script may perform. */
export type DomAction =
  | { kind: "click"; target: ElementTarget }
  | { kind: "fill"; target: ElementTarget; text: string }
  | { kind: "select"; target: ElementTarget; values: string[] }
  | { kind: "check"; target: ElementTarget; checked: boolean }
  | { kind: "press"; target: ElementTarget; key: PressKey }
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
  code?: PageErrorCode | "ACTION_DENIED" | "LIMIT_EXCEEDED" | "INVALID_TOOL_ARGUMENTS";
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
}

export interface PageFindResult {
  documentId: string;
  url: string;
  query: string;
  /** Total matching outline lines; `matches` may be capped. */
  count: number;
  matches: { offset: number; text: string }[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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
  target: { kind: "tab"; tabId: number };
  snapshot: PageSnapshot;
}

export type ContextArtifact = PageContextArtifact;
