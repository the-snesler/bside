/**
 * Domain types for the page tool vocabulary: the closed, Playwright-like
 * action union the agent can call, and the bounded semantic snapshot it
 * observes. Independent of WXT, Preact, Firefox, and OpenAI — nothing here
 * imports a browser or SDK type.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PageToolName =
  | "page_snapshot"
  | "page_click"
  | "page_fill"
  | "page_select_option"
  | "page_set_checked"
  | "page_scroll"
  | "page_navigate"
  | "page_go_back";

export interface ToolCall {
  id: string;
  name: PageToolName | "browser_program" | "request_action_confirmation";
  arguments: JsonValue;
}

export type PageToolCall = ToolCall & { name: PageToolName };

export interface SemanticLocator { role: string; name: string }

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

export interface PageSnapshotV1 {
  version: 1;
  tabId: number;
  revision: string;
  url: string;
  origin: string;
  title: string;
  readableText: string;
  selectionText: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  nodes: PageNode[];
  truncated: { readableText: boolean; nodes: boolean };
  warnings: string[];
}

export interface PageNode {
  ref: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  tag: string;
  inputType?: string;
  href?: string;
  options?: { label: string; value: string; disabled: boolean; selected: boolean }[];
  optionsTruncated?: boolean;
  state: {
    disabled: boolean;
    checked?: boolean;
    expanded?: boolean;
    selected?: boolean;
  };
  bounds: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
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
  snapshot: PageSnapshotV1;
}

export type ContextArtifact = PageContextArtifact;
