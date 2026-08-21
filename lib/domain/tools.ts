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
  name: PageToolName;
  arguments: JsonValue;
}

export type ToolRisk = "read" | "low-effect" | "consequential";

export type PageErrorCode =
  | "UNSUPPORTED_PAGE"
  | "TAB_CHANGED"
  | "STALE_SNAPSHOT"
  | "TARGET_MISSING"
  | "NOT_INTERACTABLE"
  | "NAVIGATION_INTERRUPTED";

export interface ToolExecutionContext {
  runId: string;
  tab: { tabId: number; revision: string };
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: PageToolName;
  description: string;
  parameters: JsonValue;
  risk: ToolRisk;
}

export interface ToolResult {
  ok: boolean;
  code?: PageErrorCode | "ACTION_DENIED" | "LIMIT_EXCEEDED" | "INVALID_TOOL_ARGUMENTS";
  summary: string;
  data?: JsonValue;
}

export interface ToolRegistry {
  definitions(): readonly ToolDefinition[];
  risk(call: ToolCall): ToolRisk;
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
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

// ---------------------------------------------------------------------------
// Strict tool catalog: every schema is `additionalProperties:false` with
// every property required (OpenAI strict-mode contract). Auto-run risk is
// "read" (page_snapshot) and "low-effect" (page_scroll); everything else is
// "consequential" and requires inline user approval.
// ---------------------------------------------------------------------------

const REF_SCHEMA: JsonValue = { type: "string", maxLength: 128 };
const REVISION_SCHEMA: JsonValue = {
  type: "string",
  maxLength: 128,
  description: "The exact `Revision:` value from the most recent page snapshot or tool result. Never invent or reuse an old one.",
};

export const PAGE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "page_snapshot",
    description: "Capture a fresh bounded snapshot of the current page. Use before acting on any ref.",
    risk: "read",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["readable", "interactive"] } },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "page_click",
    description: "Click an element identified by ref from the latest snapshot.",
    risk: "consequential",
    parameters: {
      type: "object",
      properties: { ref: REF_SCHEMA, revision: REVISION_SCHEMA },
      required: ["ref", "revision"],
      additionalProperties: false,
    },
  },
  {
    name: "page_fill",
    description: "Fill a text input or textarea identified by ref with the given text.",
    risk: "consequential",
    parameters: {
      type: "object",
      properties: { ref: REF_SCHEMA, revision: REVISION_SCHEMA, text: { type: "string", maxLength: 8000 } },
      required: ["ref", "revision", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "page_select_option",
    description: "Select one or more option values on a <select> identified by ref.",
    risk: "consequential",
    parameters: {
      type: "object",
      properties: {
        ref: REF_SCHEMA,
        revision: REVISION_SCHEMA,
        values: { type: "array", items: { type: "string", maxLength: 256 }, minItems: 1, maxItems: 20 },
      },
      required: ["ref", "revision", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "page_set_checked",
    description: "Check or uncheck a checkbox/radio input identified by ref.",
    risk: "consequential",
    parameters: {
      type: "object",
      properties: { ref: REF_SCHEMA, revision: REVISION_SCHEMA, checked: { type: "boolean" } },
      required: ["ref", "revision", "checked"],
      additionalProperties: false,
    },
  },
  {
    name: "page_scroll",
    description: "Scroll the page or a specific ref. Pass ref:null to scroll the whole page.",
    risk: "low-effect",
    parameters: {
      type: "object",
      properties: {
        ref: { type: ["string", "null"], maxLength: 128 },
        revision: REVISION_SCHEMA,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "string", enum: ["line", "page"] },
      },
      required: ["ref", "revision", "direction", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "page_navigate",
    description: "Navigate the bound tab to an HTTP(S) URL.",
    risk: "consequential",
    parameters: {
      type: "object",
      properties: { url: { type: "string", maxLength: 2048 } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "page_go_back",
    description: "Navigate the bound tab back to the previous page.",
    risk: "consequential",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

const PAGE_TOOL_RISK: Record<PageToolName, ToolRisk> = Object.fromEntries(
  PAGE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition.risk]),
) as Record<PageToolName, ToolRisk>;

export function riskForTool(name: PageToolName): ToolRisk {
  return PAGE_TOOL_RISK[name];
}
