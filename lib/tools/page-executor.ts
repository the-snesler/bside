/**
 * Pure, testable DOM semantics for the page tool vocabulary. Given a live
 * `Document` and a revision-scoped ref registry, this module extracts a
 * bounded semantic snapshot and executes validated mutations against it.
 *
 * This file never touches `browser.*` APIs and never receives credentials or
 * generated JavaScript — it only ever sees a `Document` and opaque refs.
 */

import type { DomToolCall } from "@/lib/protocol";
import type { PageNode, PageSnapshotV1, ToolResult, SemanticLocator } from "@/lib/domain/tools";
import {
  validateClickArgs,
  validateFillArgs,
  validateScrollArgs,
  validateSelectOptionArgs,
  validateSetCheckedArgs,
} from "@/lib/validation";

export interface ElementRefRegistry {
  revision: string;
  elements: Map<string, { element: Element; role: string; name: string; inputType?: string }>;
}

export function createElementRefRegistry(): ElementRefRegistry {
  return { revision: "", elements: new Map() };
}

export interface SnapshotLimits {
  maxText: number;
  maxNodes: number;
}

const DEFAULT_LIMITS: SnapshotLimits = { maxText: 40_000, maxNodes: 300 };
const NON_CONTENT_TAGS: Record<string, true> = { script: true, style: true, noscript: true, template: true };
const INTERACTIVE_SELECTOR = "a[href], button, select, textarea, input, [role]";

export function extractSnapshot(
  document: Document,
  tabId: number,
  registry: ElementRefRegistry,
  mode: "readable" | "interactive",
  limits: SnapshotLimits = DEFAULT_LIMITS,
  locator?: SemanticLocator,
): PageSnapshotV1 {
  const revision = crypto.randomUUID();
  registry.revision = revision;
  registry.elements.clear();

  const { readableText, truncatedText } = locator ? { readableText: "", truncatedText: false } : extractReadableText(document, limits.maxText);

  let nodes: PageNode[] = [];
  let truncatedNodes = false;
  {
    const extracted = extractInteractiveNodes(document, registry, locator ? 2 : mode === "readable" ? Math.min(60, limits.maxNodes) : limits.maxNodes, locator);
    nodes = extracted.nodes;
    truncatedNodes = extracted.truncated;
  }

  const view = document.defaultView;
  const location = document.location;

  return {
    version: 1,
    tabId,
    revision,
    url: location?.href ?? "",
    origin: location?.origin ?? "",
    title: document.title ?? "",
    readableText,
    selectionText: trimText(document.getSelection?.()?.toString() ?? "").slice(0, 2000),
    viewport: {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      scrollX: view?.scrollX ?? 0,
      scrollY: view?.scrollY ?? 0,
    },
    nodes,
    truncated: { readableText: truncatedText, nodes: truncatedNodes },
    warnings: [],
  };
}

export function executeDomCall(
  document: Document,
  registry: ElementRefRegistry,
  call: DomToolCall,
): ToolResult {
  if (call.name === "page_click") return handleClick(registry, call.arguments);
  if (call.name === "page_fill") return handleFill(registry, call.arguments);
  if (call.name === "page_select_option") return handleSelectOption(registry, call.arguments);
  if (call.name === "page_set_checked") return handleSetChecked(registry, call.arguments);
  if (call.name === "page_scroll") return handleScroll(document, registry, call.arguments);
  return {
    ok: false,
    code: "INVALID_TOOL_ARGUMENTS",
    summary: `Unsupported page tool for execution: ${call.name}`,
  };
}

// ---------------------------------------------------------------------------
// Readable text extraction
// ---------------------------------------------------------------------------

function extractReadableText(document: Document, maxText: number): { readableText: string; truncatedText: boolean } {
  // Article extraction can discard sorting controls and include hidden data
  // templates. A browser agent needs the visible document, in document order.
  const pending: Node[] = document.body ? [document.body] : [];
  const parts: string[] = [];
  let size = 0;
  let scanned = 0;
  while (pending.length && scanned++ < 20_000) {
    const node = pending.pop()!;
    if (node.nodeType === 3) {
      const text = trimText(node.textContent ?? "");
      if (text) { parts.push(text); size += text.length + 1; }
      if (size > maxText) return { readableText: parts.join(" ").slice(0, maxText), truncatedText: true };
    } else if (node.nodeType === 1) {
      const element = node as Element;
      if (!isLocallyExtractable(element)) continue;
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
    }
  }
  return { readableText: parts.join(" "), truncatedText: pending.length > 0 };
}

function trimText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Interactive node extraction
// ---------------------------------------------------------------------------

function extractInteractiveNodes(
  document: Document,
  registry: ElementRefRegistry,
  maxNodes: number,
  locator?: SemanticLocator,
): { nodes: PageNode[]; truncated: boolean } {
  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
  const nodes: PageNode[] = [];

  let scanned = 0;
  for (const element of candidates) {
    if (++scanned > 10_000) return { nodes, truncated: true };
    const role = computeRole(element);
    if (!role || !isExtractable(element)) continue;
    const name = computeAccessibleName(element);
    if (locator && (role !== locator.role || name !== locator.name)) continue;

    if (nodes.length >= maxNodes) {
      return { nodes, truncated: true };
    }

    const ref = `e${nodes.length + 1}`;
    const tag = element.tagName.toLowerCase();
    const inputType = readInputType(element);
    const isFormControl = tag === "input" || tag === "textarea" || tag === "select";
    const isSecret = inputType === "password" || inputType === "file";

    const node: PageNode = {
      ref,
      role,
      name,
      tag,
      state: {
        disabled: isDisabled(element),
        checked: readChecked(element),
        expanded: readAriaBool(element, "aria-expanded"),
        selected: readAriaBool(element, "aria-selected"),
      },
      bounds: readBounds(element),
      inViewport: isInViewport(element, document),
    };
    if (inputType) node.inputType = inputType;
    if (tag === "a") node.href = (element as HTMLAnchorElement).href;
    if (tag === "select") {
      const options = Array.from((element as HTMLSelectElement).options);
      node.options = options.slice(0, 100).map((option) => ({ label: option.getAttribute("label") || trimText(option.textContent ?? ""), value: option.value, disabled: option.disabled, selected: option.selected }));
      node.optionsTruncated = options.length > 100;
    }
    if (!isFormControl) {
      const text = trimText(element.textContent ?? "");
      if (text) node.text = text;
    } else if (!isSecret) {
      const value = readValue(element);
      if (value !== undefined) node.value = value;
    }

    nodes.push(node);
    registry.elements.set(ref, { element, role, name, inputType });
  }

  return { nodes, truncated: false };
}

function computeRole(element: Element): string | null {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return element.hasAttribute("href") ? "link" : null;
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    if (type === "file") return "button";
    if (type === "hidden") return null;
    return "textbox";
  }
  return null;
}

function readInputType(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (tag === "input") return (element.getAttribute("type") || "text").toLowerCase();
  if (tag === "textarea") return "textarea";
  return undefined;
}

function readValue(element: Element): string | undefined {
  if (element instanceof HTMLSelectElement) {
    const selected = Array.from(element.selectedOptions).map((o) => o.value);
    return selected.length > 0 ? selected.join(",") : undefined;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return undefined;
}

function readChecked(element: Element): boolean | undefined {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    return element.checked;
  }
  return undefined;
}

function readAriaBool(element: Element, attribute: string): boolean | undefined {
  const value = element.getAttribute(attribute);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function readBounds(element: Element): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isInViewport(element: Element, document: Document): boolean {
  const rect = element.getBoundingClientRect();
  const view = document.defaultView;
  const width = view?.innerWidth ?? Number.POSITIVE_INFINITY;
  const height = view?.innerHeight ?? Number.POSITIVE_INFINITY;
  return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

/** Element and every ancestor are connected, non-hidden, non-inert content. */
function isExtractable(element: Element): boolean {
  if (!element.isConnected) return false;
  let node: Element | null = element;
  while (node) {
    if (!isLocallyExtractable(node)) return false;
    node = node.parentElement;
  }
  return true;
}

function isLocallyExtractable(element: Element): boolean {
  if (NON_CONTENT_TAGS[element.tagName.toLowerCase()] || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || (element as HTMLElement).inert) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !style || (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse");
}

function isDisabled(element: Element): boolean {
  if ("disabled" in element && (element as HTMLInputElement).disabled) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  return element.closest("fieldset[disabled]") !== null;
}

function isRestrictedInput(element: Element): boolean {
  if (!(element instanceof HTMLInputElement)) return false;
  return element.type === "password" || element.type === "file";
}

function computeAccessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = element.ownerDocument;
    const text = labelledBy
      .split(/\s+/)
      .map((id) => trimText(doc.getElementById(id)?.textContent ?? ""))
      .filter((part) => part.length > 0)
      .join(" ");
    if (text) return text;
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && trimText(ariaLabel)) return trimText(ariaLabel);

  const label = findAssociatedLabel(element);
  if (label) {
    const text = trimText(label.textContent ?? "");
    if (text) return text;
  }

  const alt = element.getAttribute("alt");
  if (alt && trimText(alt)) return trimText(alt);

  return trimText(element.textContent ?? "");
}

function findAssociatedLabel(element: Element): Element | null {
  const id = element.getAttribute("id");
  if (id) {
    for (const label of Array.from(element.ownerDocument.querySelectorAll("label[for]"))) {
      if (label.getAttribute("for") === id) return label;
    }
  }
  return element.closest("label");
}

function describeTarget(element: Element): string {
  const name = computeAccessibleName(element);
  const tag = element.tagName.toLowerCase();
  return name ? `${tag} "${name}"` : tag;
}

// ---------------------------------------------------------------------------
// Mutation handlers
// ---------------------------------------------------------------------------

function invalidArgs(): ToolResult {
  return { ok: false, code: "INVALID_TOOL_ARGUMENTS", summary: "Invalid or missing arguments for this tool call." };
}

type ResolvedTarget = { ok: true; element: Element } | { ok: false; result: ToolResult };

function resolveTarget(registry: ElementRefRegistry, ref: string, revision: string): ResolvedTarget {
  if (revision !== registry.revision) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "STALE_SNAPSHOT",
        summary: "Snapshot revision is stale; request a fresh page_snapshot.",
      },
    };
  }
  const entry = registry.elements.get(ref);
  if (!entry) {
    return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Unknown element reference: ${ref}` } };
  }
  if (!isExtractable(entry.element)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: entry.element.isConnected ? "NOT_INTERACTABLE" : "TARGET_MISSING",
        summary: entry.element.isConnected
          ? "Element is hidden or not interactable."
          : "Element is no longer attached to the page.",
      },
    };
  }
  if (isDisabled(entry.element)) {
    return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: "Element is disabled." } };
  }
  return { ok: true, element: entry.element };
}

function handleClick(registry: ElementRefRegistry, rawArgs: DomToolCall["arguments"]): ToolResult {
  const args = validateClickArgs(rawArgs);
  if (!args) return invalidArgs();
  const resolved = resolveTarget(registry, args.ref, args.revision);
  if (!resolved.ok) return resolved.result;
  const { element } = resolved;

  if (element instanceof HTMLAnchorElement && (element.target === "_blank" || element.hasAttribute("download"))) {
    return {
      ok: false,
      code: "NOT_INTERACTABLE",
      summary: "Links that open a new tab or trigger a download are not supported.",
    };
  }
  if (isRestrictedInput(element)) {
    return { ok: false, code: "NOT_INTERACTABLE", summary: "This control type is not supported." };
  }

  (element as HTMLElement).click();
  return { ok: true, summary: `Clicked ${describeTarget(element)}.` };
}

function handleFill(registry: ElementRefRegistry, rawArgs: DomToolCall["arguments"]): ToolResult {
  const args = validateFillArgs(rawArgs);
  if (!args) return invalidArgs();
  const resolved = resolveTarget(registry, args.ref, args.revision);
  if (!resolved.ok) return resolved.result;
  const { element } = resolved;

  if (isRestrictedInput(element)) {
    return { ok: false, code: "NOT_INTERACTABLE", summary: "This control type is not supported." };
  }
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    return { ok: false, code: "NOT_INTERACTABLE", summary: "Element does not accept text input." };
  }

  element.value = args.text;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, summary: `Filled ${describeTarget(element)}.` };
}

function handleSelectOption(registry: ElementRefRegistry, rawArgs: DomToolCall["arguments"]): ToolResult {
  const args = validateSelectOptionArgs(rawArgs);
  if (!args) return invalidArgs();
  const resolved = resolveTarget(registry, args.ref, args.revision);
  if (!resolved.ok) return resolved.result;
  const { element } = resolved;

  if (!(element instanceof HTMLSelectElement)) {
    return { ok: false, code: "NOT_INTERACTABLE", summary: "Element is not a select control." };
  }
  const validValues = new Set(Array.from(element.options).map((option) => option.value));
  for (const value of args.values) {
    if (!validValues.has(value)) {
      return { ok: false, code: "TARGET_MISSING", summary: `Unknown option value: ${value}` };
    }
  }
  for (const option of Array.from(element.options)) {
    option.selected = args.values.includes(option.value);
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, summary: `Selected ${args.values.join(", ")} on ${describeTarget(element)}.` };
}

function handleSetChecked(registry: ElementRefRegistry, rawArgs: DomToolCall["arguments"]): ToolResult {
  const args = validateSetCheckedArgs(rawArgs);
  if (!args) return invalidArgs();
  const resolved = resolveTarget(registry, args.ref, args.revision);
  if (!resolved.ok) return resolved.result;
  const { element } = resolved;

  if (!(element instanceof HTMLInputElement) || (element.type !== "checkbox" && element.type !== "radio")) {
    return { ok: false, code: "NOT_INTERACTABLE", summary: "Element is not a checkbox or radio control." };
  }
  element.checked = args.checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, summary: `Set ${describeTarget(element)} ${args.checked ? "checked" : "unchecked"}.` };
}

function handleScroll(document: Document, registry: ElementRefRegistry, rawArgs: DomToolCall["arguments"]): ToolResult {
  const args = validateScrollArgs(rawArgs);
  if (!args) return invalidArgs();
  if (args.revision !== registry.revision) {
    return { ok: false, code: "STALE_SNAPSHOT", summary: "Snapshot revision is stale; request a fresh page_snapshot." };
  }

  const step = args.amount === "page" ? 800 : 120;
  const dx = args.direction === "left" ? -step : args.direction === "right" ? step : 0;
  const dy = args.direction === "up" ? -step : args.direction === "down" ? step : 0;

  if (args.ref === null) {
    document.defaultView?.scrollBy?.(dx, dy);
    return { ok: true, summary: "Scrolled the page." };
  }

  const entry = registry.elements.get(args.ref);
  if (!entry) {
    return { ok: false, code: "TARGET_MISSING", summary: `Unknown element reference: ${args.ref}` };
  }
  if (!isExtractable(entry.element)) {
    return {
      ok: false,
      code: entry.element.isConnected ? "NOT_INTERACTABLE" : "TARGET_MISSING",
      summary: "Element is not interactable.",
    };
  }
  entry.element.scrollBy?.(dx, dy);
  return { ok: true, summary: `Scrolled ${describeTarget(entry.element)}.` };
}
