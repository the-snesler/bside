/**
 * Pure, testable DOM semantics for the page tool vocabulary. Given a live
 * `Document` and a per-document ref registry, this module renders a bounded
 * page outline and executes the closed `DomAction` union against it.
 *
 * The outline walks the composed tree in document order: open and closed
 * shadow roots, slot assignments, and same-origin frames. Interactive
 * elements are inlined as `[e12 button "Save"]` tokens whose refs stay bound
 * to the same element for the document's lifetime. A cross-origin frame is a
 * placeholder line (`ChildFrame`) for the background to fill in with that
 * frame's own outline, whose refs carry a frame prefix (`f3:e12`). Data tables
 * and ARIA grids get a ref and a size line (`[table e12 "Caption" 340 rows ×
 * 6 cols]`) for `extractTable` to read them as JSON. Hidden radios, checkboxes,
 * and file inputs with a visible label are exposed and operated through that
 * label; other hidden elements are never targetable.
 *
 * Elements registered with `excludeFromOutline` (bside's own page shield) are
 * skipped entirely. Effects are dispatched straight to the resolved element;
 * nothing here hit-tests by coordinates (no `elementFromPoint`), so an overlay
 * never redirects or blocks an agent action.
 *
 * This file never touches `browser.*` APIs and never receives credentials or
 * generated JavaScript — it only ever sees a `Document`, opaque refs, and
 * validated actions. Element checks use tag names rather than `instanceof` so
 * they also hold for elements from same-origin frames (other realms).
 */

import { TABLE_LIMITS } from "@/lib/domain/tools";
import type {
  CaptureGeometry, ChildFrame, DomAction, ElementTarget, FrameOutline, KeyModifier, PageFindResult, PageRect, PageSnapshot, PageTable, PressKey, SearchResult,
  TableRole, ToolResult, UploadFile,
} from "@/lib/domain/tools";
import { formatKeyChord } from "@/lib/validation";
import { boundOutline, findInOutline, sliceOutline } from "@/lib/domain/outline";

// ---------------------------------------------------------------------------
// Ref registry
// ---------------------------------------------------------------------------

export interface ElementRefRegistry {
  /** Stable for this document's lifetime; a navigation gets a new registry. */
  documentId: string;
  next: number;
  byRef: Map<string, Element>;
  byElement: WeakMap<Element, string>;
}

export function createElementRefRegistry(documentId = randomId()): ElementRefRegistry {
  return { documentId, next: 0, byRef: new Map(), byElement: new WeakMap() };
}

function randomId(): string {
  // crypto.randomUUID is unavailable in insecure (http:) contexts.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const MAX_REGISTERED_REFS = 20_000;

/** Extension-owned elements left out of every outline, find, and change diff. */
const OUTLINE_EXCLUDED = new WeakSet<Element>();

/** Keeps an element bside itself put on the page (the page shield) out of what the agent observes. */
export function excludeFromOutline(element: Element): void {
  OUTLINE_EXCLUDED.add(element);
}

function refFor(registry: ElementRefRegistry, element: Element): string {
  const existing = registry.byElement.get(element);
  if (existing) return existing;
  if (registry.byRef.size >= MAX_REGISTERED_REFS) {
    for (const [ref, candidate] of registry.byRef) if (!candidate.isConnected) registry.byRef.delete(ref);
  }
  const ref = `e${++registry.next}`;
  registry.byRef.set(ref, element);
  registry.byElement.set(element, ref);
  return ref;
}

// ---------------------------------------------------------------------------
// Element helpers (realm-independent)
// ---------------------------------------------------------------------------

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SKIPPED_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "base", "datalist", "object", "embed", "param", "source", "track", "map"]);
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch",
  "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);
const NAME_FROM_CONTENT_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "treeitem", "clickable", "draggable",
]);
const CONTEXT_NAMED_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "file", "slider", "spinbutton", "checkbox", "radio", "switch"]);
const TEXT_INPUT_TYPES = new Set(["text", "email", "search", "tel", "url", "number", "password", "date", "datetime-local", "month", "week", "time", "color"]);
const LEAF_TEXT_LIMIT = 160;
const NAME_LIMIT = 160;
const VALUE_LIMIT = 300;
const MAX_VISITED_NODES = 60_000;
const MAX_OUTLINE_CHARS = 2_000_000;
const MAX_OPTIONS_SHOWN = 40;

function tagOf(element: Element): string {
  return element.namespaceURI === HTML_NS ? element.localName : `svg:${element.localName}`;
}

function isInput(element: Element): element is HTMLInputElement {
  return tagOf(element) === "input";
}

function isSelect(element: Element): element is HTMLSelectElement {
  return tagOf(element) === "select";
}

function isTextArea(element: Element): element is HTMLTextAreaElement {
  return tagOf(element) === "textarea";
}

function isAnchor(element: Element): element is HTMLAnchorElement {
  return (tagOf(element) === "a" || tagOf(element) === "area") && element.hasAttribute("href");
}

function inputType(element: HTMLInputElement): string {
  return (element.getAttribute("type") || "text").toLowerCase();
}

function styleOf(element: Element): CSSStyleDeclaration | null {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
  } catch {
    return null;
  }
}

function shadowRootOf(element: Element): ShadowRoot | null {
  // Firefox exposes closed roots to extension content scripts.
  const closed = (element as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
  return closed ?? element.shadowRoot ?? null;
}

/** Children in the flat (rendered) tree: shadow content, slot assignments, then light children. */
function composedChildren(node: Node): readonly Node[] {
  if (node.nodeType === 1) {
    const element = node as Element;
    const shadow = shadowRootOf(element);
    if (shadow) return Array.from(shadow.childNodes);
    if (tagOf(element) === "slot") {
      const assigned = (element as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
      if (assigned.length) return assigned;
    }
  }
  return Array.from(node.childNodes);
}

/** Parent in the flat tree, crossing shadow roots and frame boundaries. */
function composedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  if ((root as ShadowRoot).host) return (root as ShadowRoot).host;
  try {
    return (element.ownerDocument.defaultView?.frameElement as Element | null) ?? null;
  } catch {
    return null;
  }
}

function trimText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isLocallyHidden(element: Element, style: CSSStyleDeclaration | null): boolean {
  if (SKIPPED_TAGS.has(tagOf(element))) return true;
  if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden") || (element as HTMLElement).inert) return true;
  return !!style && style.display === "none";
}

/** Whether the element is rendered: it and every flat-tree ancestor are displayed and not aria-hidden. */
function isRendered(element: Element): boolean {
  if (!element.isConnected) return false;
  const style = styleOf(element);
  if (style && (style.visibility === "hidden" || style.visibility === "collapse")) return false;
  for (let node: Element | null = element; node; node = composedParent(node)) {
    if (tagOf(node) === "slot") continue;
    if (isLocallyHidden(node, styleOf(node))) return false;
    if (tagOf(node) === "details" && !(node as HTMLDetailsElement).open && node !== element) {
      const summary = Array.from(node.children).find((child) => tagOf(child) === "summary");
      if (!summary || !summary.contains(element)) return false;
    }
  }
  return true;
}

function isDisabled(element: Element): boolean {
  if ((element as HTMLButtonElement).disabled === true) return true;
  if (element.getAttribute("aria-disabled") === "true") return true;
  return element.closest("fieldset[disabled]") !== null;
}

function rootLookup(element: Element, id: string): Element | null {
  const root = element.getRootNode() as Document | ShadowRoot;
  return root.getElementById?.(id) ?? element.ownerDocument.getElementById(id);
}

/** Visible text of a subtree in the flat tree, including image alt text, bounded. */
function composedText(element: Element, limit: number, exclude?: Element): string {
  const parts: string[] = [];
  let size = 0;
  let budget = 600;
  const visit = (node: Node): void => {
    if (size > limit || budget-- <= 0) return;
    if (node.nodeType === 3) {
      const text = trimText(node.textContent ?? "");
      if (text) { parts.push(text); size += text.length + 1; }
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (child === exclude) return;
    if (child !== element && (isInput(child) || isSelect(child) || isTextArea(child))) return;
    if (isLocallyHidden(child, styleOf(child))) return;
    const tag = tagOf(child);
    if (tag === "img" || tag === "svg:svg" || tag === "svg:image") {
      const alt = trimText(child.getAttribute("alt") ?? child.getAttribute("aria-label") ?? "");
      if (alt) { parts.push(alt); size += alt.length + 1; }
      return;
    }
    for (const grandchild of composedChildren(child)) visit(grandchild);
  };
  visit(element);
  return clip(parts.join(" "), limit);
}

function labelsOf(element: Element): Element[] {
  const native = (element as HTMLInputElement).labels;
  if (native && native.length) return Array.from(native);
  const labels: Element[] = [];
  const id = element.getAttribute("id");
  const root = element.getRootNode() as Document | ShadowRoot;
  if (id && root.querySelectorAll) {
    for (const label of Array.from(root.querySelectorAll("label[for]"))) if (label.getAttribute("for") === id) labels.push(label);
  }
  const wrapping = element.closest("label");
  if (wrapping && !labels.includes(wrapping)) labels.push(wrapping);
  return labels;
}

function labelText(label: Element, control: Element): string {
  return composedText(label, NAME_LIMIT, control) || trimText(label.getAttribute("title") ?? label.getAttribute("aria-label") ?? "");
}

function accessibleName(element: Element, role: string): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => {
      const target = rootLookup(element, id);
      return target ? composedText(target, NAME_LIMIT) : "";
    }).filter(Boolean).join(" ");
    if (text) return clip(text, NAME_LIMIT);
  }
  const ariaLabel = trimText(element.getAttribute("aria-label") ?? "");
  if (ariaLabel) return clip(ariaLabel, NAME_LIMIT);

  const tag = tagOf(element);
  if (tag === "input" || tag === "select" || tag === "textarea" || tag === "meter" || tag === "progress") {
    for (const label of labelsOf(element)) {
      const text = labelText(label, element);
      if (text) return clip(text, NAME_LIMIT);
    }
    if (isInput(element)) {
      const type = inputType(element);
      if (type === "submit" || type === "reset" || type === "button") {
        const value = trimText(element.value || element.getAttribute("value") || "");
        return value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      }
      if (type === "image") return trimText(element.getAttribute("alt") ?? "") || "Submit";
    }
  }
  if (tag === "img") return trimText(element.getAttribute("alt") ?? "");
  if (NAME_FROM_CONTENT_ROLES.has(role) && !isInput(element) && !isSelect(element) && !isTextArea(element)) {
    const text = composedText(element, NAME_LIMIT);
    if (text) return text;
  }
  const fallback = element.getAttribute("title") ?? element.getAttribute("placeholder") ??
    element.getAttribute("aria-placeholder") ?? element.getAttribute("data-placeholder") ?? "";
  return clip(trimText(fallback), NAME_LIMIT);
}

function isContentEditableRoot(element: Element): boolean {
  const html = element as HTMLElement;
  if (!html.isContentEditable) return false;
  const parent = composedParent(element);
  return !parent || !(parent as HTMLElement).isContentEditable;
}

/** The interactive role of an element, or null for structure/text. */
function roleOf(element: Element, style: CSSStyleDeclaration | null, parentStyle: CSSStyleDeclaration | null): string | null {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit && INTERACTIVE_ROLES.has(explicit)) return explicit;
  const tag = tagOf(element);
  if (isAnchor(element)) return "link";
  if (tag === "button") return "button";
  if (tag === "summary") return "button";
  if (isSelect(element)) return element.multiple || (element.size ?? 0) > 1 ? "listbox" : "combobox";
  if (isTextArea(element)) return "textbox";
  if (isInput(element)) {
    const type = inputType(element);
    if (type === "hidden") return null;
    if (type === "checkbox" || type === "radio") return type;
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    if (type === "file") return "file";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    return element.getAttribute("list") ? "combobox" : "textbox";
  }
  if (isContentEditableRoot(element)) return "textbox";
  if (explicit === "none" || explicit === "presentation" || tag === "label" || tag === "body" || tag === "html") return null;
  // Items made draggable for HTML drag and drop (sortable lists, boards) are targets for dragTo.
  if (element.getAttribute("draggable") === "true" && !explicit) return "draggable";
  // Generic clickables: explicit handlers, keyboard focusability, or the outermost pointer cursor.
  const tabIndex = element.getAttribute("tabindex");
  if (element.hasAttribute("onclick") || (tabIndex !== null && Number(tabIndex) >= 0 && !explicit)) return "clickable";
  if (style?.cursor === "pointer" && parentStyle?.cursor !== "pointer") return "clickable";
  return null;
}

function validityMessage(element: Element): string | null {
  const control = element as HTMLInputElement;
  const validity = control.validity;
  if (!validity || validity.valid) return null;
  if (control.validationMessage) return control.validationMessage;
  const flags = ["valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort", "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError"] as const;
  const failed = flags.filter((flag) => validity[flag]);
  return failed.length ? `invalid (${failed.join(", ")})` : "invalid";
}

function controlValue(element: Element): string {
  if (isInput(element) || isTextArea(element)) return element.value ?? "";
  if (isContentEditableRoot(element)) return composedText(element, VALUE_LIMIT);
  return "";
}

// ---------------------------------------------------------------------------
// Outline extraction
// ---------------------------------------------------------------------------

export interface OutlineControl {
  ref: string;
  /** The ref as the model sees it: `e12`, or `f3:e12` in a cross-origin frame. */
  label: string;
  role: string;
  name: string;
  element: Element;
  /** Visible label operated on behalf of a hidden native radio/checkbox/file input. */
  proxy: Element | null;
  disabled: boolean;
  details: string[];
  href?: string;
}

type Segment =
  | { t: "text"; text: string }
  | { t: "break" }
  | { t: "prefix"; text: string }
  | { t: "cell" }
  | { t: "control"; control: OutlineControl }
  | { t: "frame"; frame: Omit<ChildFrame, "line"> };

export interface Outline {
  lines: string[];
  /** Character offset of each line within `lines.join("\n")`. */
  offsets: number[];
  controls: OutlineControl[];
  byElement: Map<Element, OutlineControl>;
  byRef: Map<string, OutlineControl>;
  /** Data tables and ARIA grids by ref, for `extractTable`; they are read, never operated. */
  tables: Map<string, OutlineControl>;
  /** Cross-origin frames whose placeholder lines are in `lines`. */
  frames: ChildFrame[];
  /** Prefix of this frame's ref labels. */
  refPrefix: string;
  scanLimited: boolean;
}

/** How a content script renders its frame's outline. */
export interface OutlineOptions {
  /** Prefix for this frame's ref labels: "" in the top frame, `f3:` in the frame the background calls f3. */
  refPrefix?: string;
  /** Firefox's frame id for a frame element (`runtime.getFrameId`), or -1. Without it, cross-origin frames stay opaque. */
  frameIdOf?: (frame: Element) => number;
}

interface WalkContext {
  visible: boolean;
  pre: boolean;
  inControl: boolean;
  parentStyle: CSSStyleDeclaration | null;
}

class OutlineBuilder {
  readonly segments: Segment[] = [];
  readonly controls: OutlineControl[] = [];
  readonly byElement = new Map<Element, OutlineControl>();
  readonly tables = new Map<string, OutlineControl>();
  visited = 0;
  scanLimited = false;
  #lastText = "";

  constructor(private registry: ElementRefRegistry, private pageUrl: string, private options: OutlineOptions) {}

  text(text: string): void {
    if (!text) return;
    this.segments.push({ t: "text", text });
    this.#lastText = text;
  }

  break(): void {
    if (this.segments.at(-1)?.t !== "break") this.segments.push({ t: "break" });
  }

  walk(node: Node, context: WalkContext): void {
    if (++this.visited > MAX_VISITED_NODES) { this.scanLimited = true; return; }
    if (node.nodeType === 3) {
      if (!context.visible) return;
      const raw = node.textContent ?? "";
      if (context.pre) {
        raw.split("\n").forEach((line, index) => {
          if (index > 0) this.break();
          this.text(line.replace(/\s+$/, ""));
        });
      } else this.text(trimText(raw));
      return;
    }
    if (node.nodeType === 11) {
      for (const child of composedChildren(node)) this.walk(child, context);
      return;
    }
    if (node.nodeType !== 1) return;
    this.#element(node as Element, context);
  }

  #element(element: Element, context: WalkContext): void {
    if (OUTLINE_EXCLUDED.has(element)) return;
    const tag = tagOf(element);
    if (tag === "slot") {
      for (const child of composedChildren(element)) this.walk(child, context);
      return;
    }
    const style = styleOf(element);
    if (isLocallyHidden(element, style)) {
      this.#hiddenControl(element);
      return;
    }
    const visible = !style || (style.visibility !== "hidden" && style.visibility !== "collapse");
    const display = style?.display ?? "";

    if (tag === "iframe" || tag === "frame") {
      if (visible && !isTrackerFrame(element, style)) this.#frame(element as HTMLIFrameElement, context);
      return;
    }
    if (tag.startsWith("svg:")) {
      if (visible && tag === "svg:svg") {
        const label = trimText(element.getAttribute("aria-label") ?? element.querySelector("title")?.textContent ?? "");
        if (label) this.text(`[image: ${clip(label, 100)}]`);
      }
      return;
    }
    if (tag === "img") {
      const alt = trimText(element.getAttribute("alt") ?? "");
      if (visible && alt && !context.inControl) this.text(`[image: ${clip(alt, 100)}]`);
      return;
    }
    if (tag === "br") { this.break(); return; }
    if (tag === "hr") { this.break(); return; }

    const role = context.inControl && !element.getAttribute("role") && !isInput(element) && !isSelect(element) && !isTextArea(element) && !isAnchor(element) && tag !== "button"
      ? null
      : roleOf(element, style, context.parentStyle);
    const childContext: WalkContext = {
      visible,
      pre: context.pre || (style?.whiteSpace ?? "").startsWith("pre"),
      inControl: context.inControl,
      parentStyle: style,
    };

    const heading = /^h[1-6]$/.test(tag) ? Number(tag[1]) : element.getAttribute("role") === "heading" ? Number(element.getAttribute("aria-level") ?? 2) : 0;
    const cell = display === "table-cell" || tag === "td" || tag === "th";
    // Table cells stay on their row's line; every other non-inline box starts a line.
    const block = !cell && (heading > 0 || tag === "p" || tag === "div" || tag === "li" || tag === "tr" ||
      (!display.startsWith("inline") && display !== "contents" && display !== ""));
    if (heading) this.segments.push({ t: "prefix", text: `${"#".repeat(Math.min(Math.max(heading, 1), 6))} ` });
    else if (display === "list-item" || tag === "li") this.segments.push({ t: "prefix", text: "- " });
    else if (display === "table-row" || tag === "tr") this.segments.push({ t: "prefix", text: "| " });
    else if (cell) this.segments.push({ t: "cell" });
    else if (block) this.break();

    const ariaRole = element.getAttribute("role");
    if (visible && (ariaRole === "dialog" || ariaRole === "alertdialog" || (tag === "dialog" && (element as HTMLDialogElement).open))) {
      const name = accessibleName(element, "dialog");
      this.text(`[dialog${name ? ` ${JSON.stringify(name)}` : ""}]`);
      this.break();
    } else if (visible && (ariaRole === "alert" || ariaRole === "status") && composedText(element, 10)) {
      this.text(`[${ariaRole}]`);
    }

    if (visible) this.#dataValue(element);
    if (visible) this.#table(element);

    if (role && visible) {
      const descend = this.#control(element, role);
      if (!descend) {
        if (block) this.break();
        return;
      }
      childContext.inControl = true;
    } else if (role && !visible) {
      // Hidden by visibility; children may override it, but this control is not targetable.
    }

    if (tag === "details" && !(element as HTMLDetailsElement).open) {
      const summary = Array.from(element.children).find((child) => tagOf(child) === "summary");
      if (summary) this.walk(summary, childContext);
      if (block) this.break();
      return;
    }
    for (const child of composedChildren(element)) this.walk(child, childContext);
    if (block) this.break();
  }

  /** Emits a control token; returns whether its children should also be walked. */
  #control(element: Element, role: string, proxy: Element | null = null): boolean {
    let name = accessibleName(element, role);
    const content = !isInput(element) && !isSelect(element) && !isTextArea(element) && !isContentEditableRoot(element)
      ? composedText(element, LEAF_TEXT_LIMIT + 1)
      : "";
    const descend = content.length > LEAF_TEXT_LIMIT;
    if (descend && !element.getAttribute("aria-label") && !element.getAttribute("aria-labelledby")) name = clip(content, 80);
    // Unlabelled form fields (common with shadow-DOM slots) take the short text just before them.
    const context = this.#lastText.replace(/[\s*:]+$/, "");
    if (!name && CONTEXT_NAMED_ROLES.has(role) && context && context.length <= 80) name = context;
    this.#lastText = "";

    const details: string[] = [];
    let optionsDetail: string | null = null;
    let href: string | undefined;
    if (isAnchor(element)) {
      href = displayHref(element.href, this.pageUrl);
      if (element.target === "_blank") details.push("new-tab");
    }
    if (isInput(element)) {
      const type = inputType(element);
      if (role === "textbox" && type !== "text") details.push(`type=${type}`);
      if (type === "file") {
        const files = Array.from(element.files ?? []).map((file) => file.name);
        if (files.length) details.push(`files=${JSON.stringify(files.join(", "))}`);
        if (element.accept) details.push(`accept=${JSON.stringify(element.accept)}`);
        if (element.multiple) details.push("multiple");
      } else if (type === "checkbox" || type === "radio") {
        if (element.checked) details.push("checked");
      } else if (TEXT_INPUT_TYPES.has(type) || role === "slider" || role === "spinbutton" || role === "searchbox" || role === "combobox") {
        if (element.value) details.push(type === "password" ? "value=\"••••\"" : `value=${JSON.stringify(clip(element.value, VALUE_LIMIT))}`);
      }
    } else if (isTextArea(element) || (role === "textbox" && isContentEditableRoot(element))) {
      if (!isTextArea(element)) details.push("editable");
      const value = controlValue(element);
      if (value) details.push(`value=${JSON.stringify(clip(value, VALUE_LIMIT))}`);
    } else if (isSelect(element)) {
      const options = Array.from(element.options);
      const selected = options.filter((option) => option.selected).map(optionLabel);
      if (selected.length) details.push(`selected=${JSON.stringify(selected.join(", "))}`);
      const shown = options.slice(0, MAX_OPTIONS_SHOWN).map((option) => {
        const label = optionLabel(option);
        const value = option.value;
        return `${label}${value && value !== label ? ` (${value})` : ""}${option.disabled ? " (disabled)" : ""}`;
      });
      optionsDetail = `options: ${shown.join(" | ")}${options.length > MAX_OPTIONS_SHOWN ? ` | …+${options.length - MAX_OPTIONS_SHOWN} more` : ""}`;
    } else {
      const checked = element.getAttribute("aria-checked");
      if (checked === "true") details.push("checked");
      if (checked === "mixed") details.push("mixed");
      const valueText = element.getAttribute("aria-valuetext") ?? element.getAttribute("aria-valuenow");
      if (valueText) details.push(`value=${JSON.stringify(clip(valueText, 80))}`);
      if (role === "combobox" || role === "textbox" || role === "searchbox") {
        const value = composedText(element, VALUE_LIMIT);
        if (value && value !== name) details.push(`value=${JSON.stringify(value)}`);
      }
    }
    const expanded = element.getAttribute("aria-expanded");
    if (expanded === "true") details.push("expanded");
    if (expanded === "false") details.push("collapsed");
    if (element.getAttribute("aria-selected") === "true") details.push("selected");
    if (element.getAttribute("aria-pressed") === "true") details.push("pressed");
    if (element.getAttribute("aria-current") && element.getAttribute("aria-current") !== "false") details.push("current");
    const disabled = isDisabled(element);
    if (disabled) details.push("disabled");
    if ((element as HTMLInputElement).required || element.getAttribute("aria-required") === "true") details.push("required");
    if ((element as HTMLInputElement).readOnly || element.getAttribute("aria-readonly") === "true") details.push("readonly");
    const message = element.getAttribute("aria-invalid") === "true" ? "invalid" : null;
    const nativeMessage = isInput(element) || isSelect(element) || isTextArea(element) ? validityMessage(element) : null;
    const hasValue = isSelect(element) ? element.value !== "" : !!controlValue(element) || !!(isInput(element) && element.files?.length);
    if (message || (nativeMessage && (hasValue || (element as HTMLInputElement).validity?.customError))) {
      details.push(`invalid=${JSON.stringify(clip(nativeMessage ?? message ?? "invalid", 160))}`);
    }
    if (proxy) details.push("via-label");
    if (optionsDetail) details.push(optionsDetail);

    const ref = refFor(this.registry, element);
    const control: OutlineControl = { ref, label: `${this.options.refPrefix ?? ""}${ref}`, role, name, element, proxy, disabled, details, ...(href ? { href } : {}) };
    this.controls.push(control);
    this.byElement.set(element, control);
    this.segments.push({ t: "control", control });
    return descend;
  }

  /** A data table or ARIA grid gets a ref and a size line before its rows, so the model can read it with `page.table`. */
  #table(element: Element): void {
    const role = tableRole(element);
    if (!role) return;
    const rows = tableRows(element);
    if (!rows) return;
    const ref = refFor(this.registry, element);
    const name = tableName(element);
    const table: OutlineControl = { ref, label: `${this.options.refPrefix ?? ""}${ref}`, role, name, element, proxy: null, disabled: false, details: [] };
    this.tables.set(ref, table);
    const count = Math.min(rows.body.length, TABLE_LIMITS.maxScanRows);
    const columns = Math.max(0, ...[...rows.head, ...rows.body.slice(0, 5)].map((row) => cellsOf(row, tagOf(element) !== "table").reduce((sum, cell) => sum + cell.colSpan, 0)));
    this.break();
    this.segments.push({ t: "text", text: `[${role} ${table.label}${name ? ` ${JSON.stringify(name)}` : ""} ${count}${rows.body.length > count ? "+" : ""} row${count === 1 ? "" : "s"} × ${columns} col${columns === 1 ? "" : "s"}]` });
    this.break();
  }

  /** Hidden native radios/checkboxes/file inputs stay operable through a visible label. */
  #hiddenControl(element: Element): void {
    if (!isInput(element)) return;
    const type = inputType(element);
    if (type !== "checkbox" && type !== "radio" && type !== "file") return;
    if (this.byElement.has(element)) return;
    const proxy = labelsOf(element).find((label) => isRendered(label));
    if (!proxy) return;
    this.#control(element, type === "file" ? "file" : type, proxy);
  }

  #frame(frame: HTMLIFrameElement, context: WalkContext): void {
    const title = trimText(frame.getAttribute("title") ?? frame.getAttribute("name") ?? "");
    const src = frame.getAttribute("srcdoc") !== null ? "(inline)" : frame.src || frame.getAttribute("src") || "about:blank";
    let frameDocument: Document | null = null;
    try {
      frameDocument = frame.contentDocument;
    } catch {
      frameDocument = null;
    }
    this.break();
    const label = `${title ? ` ${JSON.stringify(title)}` : ""}`;
    if (!frameDocument?.body) {
      // Its own content script reads it; the background splices that outline in here.
      const frameId = this.options.frameIdOf?.(frame) ?? -1;
      if (frameId > 0) this.segments.push({ t: "frame", frame: { frameId, title, url: clip(src, 500) } });
      else this.text(`[frame${label} (${clip(src, 200)}) not readable: its content is not available to bside]`);
      this.break();
      return;
    }
    this.text(`[frame${label} ${src}]`);
    this.break();
    this.walk(frameDocument.body, { ...context, inControl: false, parentStyle: null });
    this.break();
    this.text("[/frame]");
    this.break();
  }

  /** Numeric data-* values on textless widgets (e.g. score charts) are otherwise only painted. */
  #dataValue(element: Element): void {
    if (!element.attributes.length) return;
    for (const name of ["data-percent", "data-rating", "data-score", "data-value", "data-stars"]) {
      const value = element.getAttribute(name);
      if (value && /^-?\d+(?:\.\d+)?%?$/.test(value.trim()) && !trimText(element.textContent ?? "")) {
        this.text(`[${name.slice(5)}: ${value.trim()}]`);
        return;
      }
    }
    const tag = tagOf(element);
    const role = element.getAttribute("role");
    if (tag === "meter" || tag === "progress" || role === "progressbar" || role === "meter") {
      const value = element.getAttribute("aria-valuetext") ?? element.getAttribute("aria-valuenow") ?? (element as HTMLMeterElement).value?.toString();
      const name = accessibleName(element, "meter");
      if (value) this.text(`[${role ?? tag}${name ? ` ${JSON.stringify(name)}` : ""}: ${value}]`);
    }
  }
}

function optionLabel(option: HTMLOptionElement): string {
  return trimText(option.getAttribute("label") || option.textContent || "") || option.value;
}

function displayHref(href: string, pageUrl: string): string {
  if (/^javascript:/i.test(href)) return "javascript:";
  try {
    const url = new URL(href);
    const page = new URL(pageUrl);
    const text = url.origin === page.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
    return clip(text, 160);
  } catch {
    return clip(href, 160);
  }
}

/**
 * Tracking pixels, ad beacons, and parked frames: 0–1 px, or laid out
 * entirely above or left of the page. Left out of the outline.
 */
function isTrackerFrame(frame: Element, style: CSSStyleDeclaration | null): boolean {
  if ([style?.width, style?.height].some((size) => size?.endsWith("px") && parseFloat(size) < 2)) return true;
  const box = frame.getBoundingClientRect();
  // A box with no size at all means no layout ran (or the frame is display: contents); judge by style alone.
  if (!box.width && !box.height) return false;
  if (box.width < 2 || box.height < 2) return true;
  const view = frame.ownerDocument.defaultView;
  return box.right + (view?.scrollX ?? 0) <= 0 || box.bottom + (view?.scrollY ?? 0) <= 0;
}

/** A cross-origin frame's placeholder line; the background replaces it with the frame's outline. */
function renderFrame(frame: Omit<ChildFrame, "line">): string {
  return `[frame${frame.title ? ` ${JSON.stringify(frame.title)}` : ""} → ${clip(frame.url, 200)}]`;
}

function renderControl(control: OutlineControl): string {
  const parts = [control.label, control.role];
  if (control.name) parts.push(JSON.stringify(control.name));
  if (control.href) parts.push(`→ ${control.href}`);
  parts.push(...control.details);
  return `[${parts.join(" ")}]`;
}

function render(segments: Segment[], frames: ChildFrame[]): string[] {
  const lines: string[] = [];
  let current = "";
  let prefixOnly = false;
  const flush = () => {
    if (current.trim() && !prefixOnly) lines.push(current.trimEnd());
    current = "";
    prefixOnly = false;
  };
  const append = (text: string) => {
    if (current && !/[\s(]$/.test(current) && !/^[,.;:!?)]/.test(text)) current += " ";
    current += text;
    prefixOnly = false;
  };
  for (const segment of segments) {
    if (segment.t === "text") append(segment.text);
    else if (segment.t === "control") append(renderControl(segment.control));
    else if (segment.t === "break") flush();
    else if (segment.t === "frame") {
      flush();
      frames.push({ ...segment.frame, line: lines.length });
      lines.push(renderFrame(segment.frame));
    } else if (segment.t === "prefix") {
      flush();
      current = segment.text;
      prefixOnly = true;
    } else if (segment.t === "cell" && current && !prefixOnly && !current.endsWith("| ")) current += " | ";
  }
  flush();
  return lines;
}

/** Drops unnamed image links that duplicate an adjacent named link to the same destination. */
function dropRedundantLinks(segments: Segment[]): Segment[] {
  const controls = segments.flatMap((segment, index) => (segment.t === "control" ? [{ segment, index }] : []));
  const drop = new Set<number>();
  controls.forEach(({ segment, index }, position) => {
    const control = (segment as { control: OutlineControl }).control;
    if (control.role !== "link" || control.name || !control.href) return;
    const neighbours = [controls[position - 1], controls[position + 1]];
    if (neighbours.some((neighbour) => {
      const other = (neighbour?.segment as { control?: OutlineControl } | undefined)?.control;
      return other?.role === "link" && other.href === control.href && !!other.name;
    })) drop.add(index);
  });
  return drop.size ? segments.filter((_, index) => !drop.has(index)) : segments;
}

export function buildOutline(document: Document, registry: ElementRefRegistry, options: OutlineOptions = {}): Outline {
  const builder = new OutlineBuilder(registry, document.location?.href ?? "", options);
  if (document.body) builder.walk(document.body, { visible: true, pre: false, inControl: false, parentStyle: null });
  const segments = dropRedundantLinks(builder.segments);
  const kept = new Set(segments.flatMap((segment) => (segment.t === "control" ? [segment.control] : [])));
  const controls = builder.controls.filter((control) => kept.has(control));
  const rendered: ChildFrame[] = [];
  const lines = render(segments, rendered);
  if (builder.scanLimited) lines.push("[Page too large: outline scan stopped early. Use page.find() for specific content.]");
  const { lines: bounded, offsets } = boundOutline(lines, MAX_OUTLINE_CHARS, "[Outline truncated: page exceeds the outline size limit]");
  const frames = rendered.filter((frame) => frame.line < bounded.length && bounded[frame.line] === lines[frame.line]);
  const byElement = new Map(controls.map((control) => [control.element, control]));
  const byRef = new Map(controls.map((control) => [control.ref, control]));
  return { lines: bounded, offsets, controls, byElement, byRef, tables: builder.tables, frames, refPrefix: options.refPrefix ?? "", scanLimited: builder.scanLimited };
}

// ---------------------------------------------------------------------------
// Snapshot, find, and search-result extraction
// ---------------------------------------------------------------------------

/** One slice of the outline. Pass `outline` when it is already built. */
export function extractSnapshot(
  document: Document,
  tabId: number,
  registry: ElementRefRegistry,
  options: { offset: number; maxChars: number } = { offset: 0, maxChars: 16_000 },
  outline: Outline = buildOutline(document, registry),
): PageSnapshot {
  const text = outline.lines.join("\n");
  const { start, end } = sliceOutline(text, options.offset, options.maxChars);
  return {
    version: 2,
    tabId,
    documentId: registry.documentId,
    url: document.location?.href ?? "",
    title: document.title ?? "",
    text: text.slice(start, end),
    offset: start,
    end,
    totalChars: text.length,
    selectionText: selectionText(document),
  };
}

function selectionText(document: Document): string {
  return trimText(document.getSelection?.()?.toString() ?? "").slice(0, 2000);
}

/** Outline lines matching `query`, with context. Pass `outline` when it is already built. */
export function findInPage(document: Document, registry: ElementRefRegistry, query: string, outline: Outline = buildOutline(document, registry)): PageFindResult {
  return { documentId: registry.documentId, url: document.location?.href ?? "", query, ...findInOutline(outline.lines, outline.offsets, query) };
}

/**
 * This frame's whole outline, at most `maxChars`, for the background to
 * compose with its cross-origin frames' outlines.
 */
export function extractFrameOutline(document: Document, registry: ElementRefRegistry, maxChars: number, options: OutlineOptions): FrameOutline {
  const outline = buildOutline(document, registry, options);
  const { lines } = boundOutline(outline.lines, maxChars, "[Frame outline truncated: it exceeds the frame size limit]");
  const frames = outline.frames.filter((frame) => frame.line < lines.length && lines[frame.line] === outline.lines[frame.line]);
  return { documentId: registry.documentId, url: document.location?.href ?? "", title: document.title ?? "", lines, frames, selectionText: selectionText(document) };
}

const SEARCH_ENGINE_HOSTS = ["duckduckgo.com", "bing.com", "google.com", "search.yahoo.com", "startpage.com"];

function isSearchEngineHost(hostname: string): boolean {
  return SEARCH_ENGINE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** Unwraps a search engine's redirect link into its destination URL. */
function resultDestination(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isSearchEngineHost(url.hostname)) {
    const wrapped = url.searchParams.get("uddg") ?? (url.pathname === "/url" ? url.searchParams.get("q") ?? url.searchParams.get("url") : null);
    if (wrapped) return resultDestination(wrapped);
    const bing = url.searchParams.get("u");
    if (bing?.startsWith("a1")) {
      try {
        return resultDestination(atob(bing.slice(2).replace(/-/g, "+").replace(/_/g, "/")));
      } catch {
        return null;
      }
    }
    return null;
  }
  return url.href;
}

/** Generic organic-result extraction: external destinations with a title and nearby snippet text. */
export function extractSearchResults(document: Document, limit = 10): SearchResult[] {
  const results = new Map<string, SearchResult>();
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    if (results.size >= limit) break;
    const destination = resultDestination((anchor as HTMLAnchorElement).href);
    if (!destination || results.has(destination) || !isRendered(anchor)) continue;
    const title = composedText(anchor, 200);
    if (title.length < 3 || /^https?:\/\//.test(title)) continue;
    let snippet = "";
    let container: Element | null = anchor.parentElement;
    for (let depth = 0; container && depth < 5; depth++, container = container.parentElement) {
      if (container.querySelectorAll("a[href]").length > 8) break;
      const text = composedText(container, 600);
      if (text.length >= title.length + 40) {
        snippet = trimText(text.replace(title, ""));
        break;
      }
    }
    results.set(destination, { title, url: destination, snippet: clip(snippet, 300) });
  }
  return [...results.values()];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const TABLE_ROLES = new Set<string>(["table", "grid", "treegrid"]);
const ARIA_CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
/** Elements one ARIA grid's row or cell search visits at most. */
const MAX_TABLE_NODES = 200_000;
/** Rowspan/colspan beyond these are clamped, as browsers do. */
const MAX_ROW_SPAN = 65_534;
const MAX_COL_SPAN = 1_000;

function explicitRole(element: Element): string | null {
  return element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase() || null;
}

/**
 * The role of a data table: ARIA tables and grids, and native tables that
 * hold data (a caption, header cells, or at least two rows and columns
 * without a nested table). Layout tables and role=presentation are not.
 */
function tableRole(element: Element): TableRole | null {
  const role = explicitRole(element);
  if (role && TABLE_ROLES.has(role)) return role as TableRole;
  if (tagOf(element) !== "table" || role === "presentation" || role === "none") return null;
  if (element.hasAttribute("summary") || Array.from(element.children).some((child) => tagOf(child) === "caption" || tagOf(child) === "thead")) return "table";
  const rows = nativeRows(element);
  const all = [...rows.head, ...rows.body];
  if (all.some((row) => Array.from(row.children).some((cell) => tagOf(cell) === "th"))) return "table";
  return all.length >= 2 && all.some((row) => cellsOf(row, false).length >= 2) && !element.querySelector("table") ? "table" : null;
}

function tableName(element: Element): string {
  const named = element.getAttribute("aria-labelledby") || element.getAttribute("aria-label") ? accessibleName(element, "table") : "";
  if (named) return named;
  const caption = Array.from(element.children).find((child) => tagOf(child) === "caption");
  return caption ? composedText(caption, NAME_LIMIT) : trimText(element.getAttribute("title") ?? "");
}

function isHiddenRow(row: Element): boolean {
  return isLocallyHidden(row, styleOf(row));
}

/** A native table's own rows (not a nested table's): thead, then tbody and bare rows in order, then tfoot. */
function nativeRows(table: Element): { head: Element[]; body: Element[] } {
  const head: Element[] = [];
  const body: Element[] = [];
  const foot: Element[] = [];
  const rowsOf = (section: Element) => Array.from(section.children).filter((row) => tagOf(row) === "tr");
  for (const child of Array.from(table.children)) {
    const tag = tagOf(child);
    if (tag === "thead") head.push(...rowsOf(child));
    else if (tag === "tfoot") foot.push(...rowsOf(child));
    else if (tag === "tbody") body.push(...rowsOf(child));
    else if (tag === "tr") body.push(child);
  }
  return { head, body: [...body, ...foot] };
}

/** Elements under `root` in the flat tree matching `match`, not descending into matches or into elements `stop` accepts. */
function composedDescendants(root: Element, match: (element: Element) => boolean, stop: (element: Element) => boolean, budget: { nodes: number }): Element[] {
  const found: Element[] = [];
  const visit = (node: Node) => {
    for (const child of composedChildren(node)) {
      if (child.nodeType !== 1 || budget.nodes-- <= 0) continue;
      const element = child as Element;
      if (OUTLINE_EXCLUDED.has(element)) continue;
      if (match(element)) found.push(element);
      else if (!stop(element)) visit(element);
    }
  };
  visit(root);
  return found;
}

function isTableElement(element: Element): boolean {
  return tagOf(element) === "table" || TABLE_ROLES.has(explicitRole(element) ?? "");
}

/** An ARIA grid's own rows, header rows being the leading rows whose cells are all column headers. */
function ariaRows(grid: Element): { head: Element[]; body: Element[] } {
  const budget = { nodes: MAX_TABLE_NODES };
  const rows = composedDescendants(grid, (element) => explicitRole(element) === "row", isTableElement, budget);
  let headers = 0;
  while (headers < rows.length) {
    const cells = cellsOf(rows[headers]!, true);
    if (!cells.length || !cells.every((cell) => cell.header)) break;
    headers++;
  }
  return { head: rows.slice(0, headers), body: rows.slice(headers) };
}

/**
 * Rendered header and data rows. A native table without a thead takes its
 * leading all-`th` rows as headers. Null when it has no rows at all.
 */
function tableRows(table: Element): { head: Element[]; body: Element[] } | null {
  let rows: { head: Element[]; body: Element[] };
  if (tagOf(table) === "table") {
    rows = nativeRows(table);
    if (!rows.head.length) {
      let headers = 0;
      while (headers < rows.body.length - 1 || (headers < rows.body.length && rows.body.length === 1)) {
        const cells = Array.from(rows.body[headers]!.children).filter((cell) => tagOf(cell) === "td" || tagOf(cell) === "th");
        if (!cells.length || !cells.every((cell) => tagOf(cell) === "th")) break;
        headers++;
      }
      rows = { head: rows.body.slice(0, headers), body: rows.body.slice(headers) };
    }
  } else rows = ariaRows(table);
  const head = rows.head.filter((row) => !isHiddenRow(row));
  const body = rows.body.filter((row) => !isHiddenRow(row));
  return head.length || body.length ? { head, body } : null;
}

interface TableCell { element: Element; colSpan: number; rowSpan: number; header: boolean }

function span(element: Element, attribute: string, aria: string, fallback: number, max: number): number {
  const raw = element.getAttribute(attribute) ?? element.getAttribute(aria);
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Math.min(value, max);
}

/** One row's cells, native (`td`/`th`) or ARIA (cell, gridcell, columnheader, rowheader). A rowspan of 0 spans the rest of the rows. */
function cellsOf(row: Element, aria: boolean): TableCell[] {
  const elements = aria
    ? composedDescendants(row, (element) => ARIA_CELL_ROLES.has(explicitRole(element) ?? ""), (element) => explicitRole(element) === "row" || isTableElement(element), { nodes: 5_000 })
    : Array.from(row.children).filter((cell) => tagOf(cell) === "td" || tagOf(cell) === "th");
  return elements.filter((cell) => !isLocallyHidden(cell, styleOf(cell))).map((cell) => ({
    element: cell,
    colSpan: Math.max(1, span(cell, aria ? "aria-colspan" : "colspan", "aria-colspan", 1, MAX_COL_SPAN)),
    rowSpan: span(cell, aria ? "aria-rowspan" : "rowspan", "aria-rowspan", 1, MAX_ROW_SPAN),
    header: aria ? explicitRole(cell) === "columnheader" : tagOf(cell) === "th" && (cell.getAttribute("scope") ?? "").toLowerCase() !== "row",
  }));
}

/**
 * Lays out rows into columns, expanding row and column spans: each grid row
 * lists, per column, the cell element covering it. Only the first `count`
 * rows are laid out; spans never cross from `rows` into another group.
 */
function layoutRows(rows: Element[], count: number, aria: boolean): Element[][] {
  const grid: Element[][] = [];
  const carry: { element: Element; remaining: number }[] = [];
  for (let index = 0; index < Math.min(count, rows.length); index++) {
    const line: Element[] = [];
    let column = 0;
    const fillCarried = () => {
      while (column < TABLE_LIMITS.maxColumns + 1 && (carry[column]?.remaining ?? 0) > 0) {
        line[column] = carry[column]!.element;
        carry[column]!.remaining--;
        column++;
      }
    };
    for (const cell of cellsOf(rows[index]!, aria)) {
      fillCarried();
      const rowSpan = cell.rowSpan === 0 ? rows.length - index : cell.rowSpan;
      for (let k = 0; k < cell.colSpan && column + k <= TABLE_LIMITS.maxColumns; k++) {
        line[column + k] = cell.element;
        if (rowSpan > 1) carry[column + k] = { element: cell.element, remaining: rowSpan - 1 };
        else delete carry[column + k];
      }
      column += cell.colSpan;
    }
    for (; column < carry.length; column++) {
      if ((carry[column]?.remaining ?? 0) > 0) {
        line[column] = carry[column]!.element;
        carry[column]!.remaining--;
      }
    }
    grid.push(line);
  }
  return grid;
}

/** A cell's visible text, bounded, followed by the refs of up to three controls inside it (`Alice [e14 link]`). */
function cellText(cell: Element, outline: Outline): string {
  const text = composedText(cell, TABLE_LIMITS.cellChars);
  const controls: string[] = [];
  const own = outline.byElement.get(cell);
  if (own) controls.push(`[${own.label} ${own.role}]`);
  for (const element of composedDescendants(cell, (candidate) => outline.byElement.has(candidate), () => false, { nodes: 500 })) {
    if (controls.length >= 3) break;
    const control = outline.byElement.get(element)!;
    controls.push(`[${control.label} ${control.role}]`);
  }
  return clip([text, ...controls].filter(Boolean).join(" "), TABLE_LIMITS.cellChars + 120);
}

/**
 * Reads one page of a table's data rows as JSON. The target is resolved like
 * an action's against a fresh outline, so a ref from an earlier document is
 * stale; it must name a table or grid from the outline.
 */
export function extractTable(
  document: Document,
  registry: ElementRefRegistry,
  target: ElementTarget,
  page: { offset: number; limit: number },
  options: OutlineOptions = {},
): { ok: true; table: PageTable } | { ok: false; result: ToolResult } {
  const outline = buildOutline(document, registry, options);
  const resolved = resolveTarget(outline, registry, target, { allowDisabled: true, accept: "tables" });
  if (!resolved.ok) return resolved;
  const { control } = resolved;
  const role = control.role as TableRole;
  const aria = tagOf(control.element) !== "table";
  const rows = tableRows(control.element) ?? { head: [], body: [] };
  const notes: string[] = [];
  let body = rows.body;
  if (body.length > TABLE_LIMITS.maxScanRows) {
    notes.push(`Only the first ${TABLE_LIMITS.maxScanRows} rows are counted and readable.`);
    body = body.slice(0, TABLE_LIMITS.maxScanRows);
  }
  const offset = Math.min(page.offset, body.length);
  const limit = Math.min(Math.max(1, page.limit), TABLE_LIMITS.maxRows);
  const headerGrid = layoutRows(rows.head, rows.head.length, aria);
  const bodyGrid = layoutRows(body, offset + limit, aria).slice(offset);
  const fullWidth = Math.max(0, ...[...headerGrid, ...bodyGrid].map((line) => line.length));
  const width = Math.min(fullWidth, TABLE_LIMITS.maxColumns);
  if (fullWidth > width) notes.push(`Only the first ${TABLE_LIMITS.maxColumns} columns are shown.`);

  const texts = new Map<Element, string>();
  const textOf = (cell: Element | undefined) => {
    if (!cell) return "";
    let text = texts.get(cell);
    if (text === undefined) texts.set(cell, text = cellText(cell, outline));
    return text;
  };
  const headers = headerGrid.length
    ? Array.from({ length: width }, (_, column) => {
      const parts: string[] = [];
      let previous: Element | undefined;
      for (const line of headerGrid) {
        const cell = line[column];
        if (!cell || cell === previous) continue;
        previous = cell;
        const text = textOf(cell);
        if (text && parts.at(-1) !== text) parts.push(text);
      }
      return parts.join(" / ");
    })
    : [];
  const out: string[][] = [];
  let chars = 0;
  for (const line of bodyGrid) {
    const row = Array.from({ length: width }, (_, column) => textOf(line[column]));
    const size = row.reduce((sum, cell) => sum + cell.length + 4, 0);
    if (out.length && chars + size > TABLE_LIMITS.maxChars) break;
    chars += size;
    out.push(row);
  }
  const end = offset + out.length;
  const declared = Number(control.element.getAttribute("aria-rowcount"));
  if (aria && Number.isSafeInteger(declared) && declared > rows.head.length + rows.body.length) {
    notes.push(`The grid reports ${declared} rows, but only ${rows.head.length + rows.body.length} are on the page; it loads the others as you scroll.`);
  }
  return {
    ok: true,
    table: {
      documentId: registry.documentId,
      url: document.location?.href ?? "",
      ref: control.label,
      role,
      caption: control.name,
      headers,
      rows: out,
      totalRows: body.length,
      offset,
      nextOffset: end < body.length ? end : null,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Settle = (document: Document) => Promise<void>;

/** Waits for DOM mutations to go quiet (150 ms) within 50–2000 ms. Background tabs may throttle timers. */
export function settleDom(document: Document): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(deadline);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, 150);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    quiet = setTimeout(finish, 150);
    const deadline = setTimeout(finish, 2000);
  });
}

type Resolved = { ok: true; control: OutlineControl } | { ok: false; result: ToolResult };

function describe(control: OutlineControl): string {
  return `[${[control.label, control.role, ...(control.name ? [JSON.stringify(control.name)] : [])].join(" ")}]`;
}

function candidatesText(controls: OutlineControl[], limit = 8): string {
  const shown = controls.slice(0, limit).map(describe).join("; ");
  return controls.length > limit ? `${shown}; …+${controls.length - limit} more` : shown;
}

interface ResolveOptions {
  /** Resolves a disabled control too (looking at one is fine; operating it is not). */
  allowDisabled?: boolean;
  /** What the target may be: an operable control (default), a table or grid to read, or either (a screenshot). */
  accept?: "controls" | "tables" | "any";
}

function resolveTarget(outline: Outline, registry: ElementRefRegistry, target: ElementTarget, options: ResolveOptions = {}): Resolved {
  const accept = options.accept ?? "controls";
  const checked = (control: OutlineControl): Resolved => {
    const table = TABLE_ROLES.has(control.role) && outline.tables.get(control.ref) === control;
    if (table && accept === "controls") {
      return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `${describe(control)} is a table; read it with page.table(${JSON.stringify(control.label)}), and act on the refs inside it.` } };
    }
    if (!table && accept === "tables") {
      return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `${describe(control)} is not a table. Tables and grids appear in the outline as [table eN …] or [grid eN …].` } };
    }
    if (control.disabled && !options.allowDisabled) return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `${describe(control)} is disabled.` } };
    return { ok: true, control };
  };
  if (target.kind === "ref") {
    const ref = `${outline.refPrefix}${target.ref}`;
    if (target.documentId !== registry.documentId) {
      const where = outline.refPrefix ? `frame ${outline.refPrefix.slice(0, -1)}` : "this tab";
      return { ok: false, result: { ok: false, code: "STALE_SNAPSHOT", summary: `Ref ${ref} came from an earlier page load; ${where} now shows a different document. Read a fresh snapshot.` } };
    }
    const control = outline.byRef.get(target.ref) ?? outline.tables.get(target.ref);
    if (control) return checked(control);
    const element = registry.byRef.get(target.ref);
    if (element?.isConnected) return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `Ref ${ref} is currently hidden or not an interactive element.` } };
    return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Ref ${ref} is no longer on the page. Read a fresh snapshot.` } };
  }
  const wanted = target.name === null ? null : trimText(target.name);
  // Tables are found by their own roles; every other locator searches the controls.
  const pool = TABLE_ROLES.has(target.role) ? [...outline.tables.values()] : outline.controls;
  const sameRole = pool.filter((control) => target.role === "*" || control.role === target.role ||
    (target.role === "textbox" && control.role === "searchbox"));
  let matches = sameRole.filter((control) => {
    if (wanted === null) return true;
    return target.exact ? control.name === wanted : control.name.toLowerCase().includes(wanted.toLowerCase());
  });
  if (matches.length > 1 && wanted !== null && !target.exact) {
    // A substring locator that is also the full name of exactly one candidate means that candidate.
    const whole = matches.filter((control) => control.name.toLowerCase() === wanted.toLowerCase());
    if (whole.length === 1) matches = whole;
  }
  if (matches.length === 1) return checked(matches[0]!);
  const label = `${target.role === "*" ? "element" : target.role}${wanted === null ? "" : ` ${target.exact ? "named exactly" : "with name containing"} ${JSON.stringify(wanted)}`}`;
  // Locators search this document only; another frame's elements are reached by their refs.
  const inFrames = outline.frames.length ? ` Elements inside cross-origin frames are reached only by ref, like page.ref("f1:e3").` : "";
  if (matches.length > 1) {
    return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Locator ${label} matched ${matches.length} elements: ${candidatesText(matches)}. Use page.ref("eN") for the intended one.${inFrames}` } };
  }
  const similar = wanted
    ? pool.filter((control) => control.name.toLowerCase().includes(wanted.toLowerCase().slice(0, 24)))
    : [];
  const kind = target.role === "*" ? "Interactive" : target.role;
  const hint = similar.length ? ` Similar controls: ${candidatesText(similar)}.` : sameRole.length ? ` ${kind} controls on the page: ${candidatesText(sameRole)}.` : ` No ${kind} controls are visible.`;
  return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Locator ${label} matched 0 elements.${hint} Use page.ref("eN") from a snapshot.${inFrames}` } };
}

function dispatch(element: Element, type: string, init: EventInit = {}): boolean {
  return element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true, ...init }));
}

function pointerClick(element: Element): void {
  const html = element as HTMLElement;
  try { html.scrollIntoView?.({ block: "center", inline: "nearest" }); } catch { /* detached or unsupported */ }
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
  if (typeof PointerEvent === "function") element.dispatchEvent(new PointerEvent("pointerdown", init));
  element.dispatchEvent(new MouseEvent("mousedown", init));
  html.focus?.();
  if (typeof PointerEvent === "function") element.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  element.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
  html.click();
}

/** Where a pointer at the element's center is, in its viewport. */
function centerOf(element: Element): { clientX: number; clientY: number } {
  const box = element.getBoundingClientRect();
  return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
}

/** Dispatches a pointer event (a `PointerEvent` for `pointer*` types where supported) or mouse event. Enter/leave events do not bubble. */
function pointerEvent(element: Element, type: string, init: MouseEventInit): boolean {
  const bubbles = !type.endsWith("enter") && !type.endsWith("leave");
  const options = { bubbles, cancelable: bubbles, composed: true, view: element.ownerDocument.defaultView, ...init };
  if (type.startsWith("pointer")) {
    if (typeof PointerEvent !== "function") return true;
    return element.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...options }));
  }
  return element.dispatchEvent(new MouseEvent(type, options));
}

/** The element and its ancestors in its own document's flat tree, innermost first. */
function hoverChain(element: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && node.ownerDocument === element.ownerDocument; node = composedParent(node)) chain.push(node);
  return chain;
}

/** The element the agent's pointer is over in each document, so the next hover (or drag) leaves it first. */
const HOVERED = new WeakMap<Document, Element>();

/** Mouse buttons held while the pointer moves: none for a hover, the primary one during a drag. */
type Buttons = 0 | 1;

/**
 * Moves the agent's pointer onto `element` the way a real pointer would:
 * out of and leaving the element hovered before (if any), then over and
 * entering the new one (enter/leave on each ancestor crossed), then a move.
 */
function movePointerTo(element: Element, buttons: Buttons = 0): void {
  const document = element.ownerDocument;
  const previous = HOVERED.get(document);
  const point = { ...centerOf(element), buttons };
  const entered = hoverChain(element);
  if (previous && previous !== element && previous.isConnected) {
    const left = hoverChain(previous).filter((node) => !entered.includes(node));
    const exit = { ...centerOf(previous), buttons, relatedTarget: element };
    pointerEvent(previous, "pointerout", exit);
    pointerEvent(previous, "mouseout", exit);
    for (const node of left) {
      pointerEvent(node, "pointerleave", exit);
      pointerEvent(node, "mouseleave", exit);
    }
  }
  if (previous !== element) {
    const before = previous?.isConnected ? hoverChain(previous) : [];
    const enter = { ...point, relatedTarget: previous ?? null };
    pointerEvent(element, "pointerover", enter);
    pointerEvent(element, "mouseover", enter);
    for (const node of entered.filter((candidate) => !before.includes(candidate)).reverse()) {
      pointerEvent(node, "pointerenter", enter);
      pointerEvent(node, "mouseenter", enter);
    }
  }
  pointerEvent(element, "pointermove", point);
  pointerEvent(element, "mousemove", point);
  HOVERED.set(document, element);
}

/** A drag event carrying `transfer`; where `DragEvent` cannot be constructed, a mouse event with it attached. */
function dragEvent(element: Element, type: string, transfer: DataTransfer, point: { clientX: number; clientY: number }): boolean {
  const cancelable = type !== "dragleave" && type !== "dragend";
  const init = { bubbles: true, cancelable, composed: true, buttons: type === "dragend" || type === "drop" ? 0 : 1, ...point };
  let event: Event;
  try {
    event = new DragEvent(type, { ...init, dataTransfer: transfer });
  } catch {
    event = new MouseEvent(type, init);
  }
  if ((event as DragEvent).dataTransfer !== transfer) Object.defineProperty(event, "dataTransfer", { value: transfer });
  return element.dispatchEvent(event);
}

/** Lets the page's handlers run (animation frames, debounced listeners) between the steps of a drag. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16));
}

/** Steps a pointer move takes from the source to the target, so libraries that need a minimum distance or several moves start dragging. */
const DRAG_STEPS = 5;

/**
 * Drags one element onto another in the same document. A draggable source
 * (`draggable="true"` or a native draggable) gets HTML drag and drop with a
 * shared `DataTransfer`: dragstart, drag, dragenter and dragover on the
 * target, then drop only if the target accepted it (cancelled dragover), and
 * dragend. Any other source gets pointer and mouse events: down on the
 * source, moves toward the target, and up on the target, which is what
 * pointer-based sortable and board libraries listen for.
 */
async function drag(control: OutlineControl, to: OutlineControl): Promise<Effect> {
  const source = control.proxy ?? control.element;
  const target = to.proxy ?? to.element;
  if (source === target || source.contains(target)) return { ok: false, code: "INVALID_TOOL_ARGUMENTS", message: `Drag ${describe(control)} onto a different element outside it.` };
  try { (source as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest" }); } catch { /* detached or unsupported */ }
  const from = centerOf(source);
  const end = centerOf(target);
  const label = `${describe(control)} onto ${describe(to)}`;
  movePointerTo(source);
  pointerEvent(source, "pointerdown", { ...from, button: 0, buttons: 1 });
  pointerEvent(source, "mousedown", { ...from, button: 0, buttons: 1 });

  if ((source as HTMLElement).draggable === true || source.getAttribute("draggable") === "true") {
    const transfer = new DataTransfer();
    if (!dragEvent(source, "dragstart", transfer, from)) {
      return { ok: false, code: "NOT_INTERACTABLE", message: `The page cancelled dragging ${describe(control)} (its dragstart handler refused it).` };
    }
    dragEvent(source, "drag", transfer, from);
    await nextFrame();
    dragEvent(target, "dragenter", transfer, end);
    if (!source.contains(target) && !target.contains(source)) dragEvent(source, "dragleave", transfer, end);
    // dragover repeats while the pointer rests on the target; the last one decides whether it accepts the drop.
    dragEvent(source, "drag", transfer, end);
    dragEvent(target, "dragover", transfer, end);
    await nextFrame();
    dragEvent(source, "drag", transfer, end);
    const accepted = !dragEvent(target, "dragover", transfer, end);
    if (!accepted) {
      dragEvent(target, "dragleave", transfer, end);
      dragEvent(source, "dragend", transfer, end);
      return { ok: false, code: "NOT_INTERACTABLE", message: `Dragged ${label}, but it does not accept drops (its dragover handler did not allow one); nothing was dropped.` };
    }
    dragEvent(target, "drop", transfer, end);
    dragEvent(source, "dragend", transfer, end);
    HOVERED.set(target.ownerDocument, target);
    return { ok: true, message: `Dragged ${label} (HTML drag and drop).` };
  }

  for (let step = 1; step < DRAG_STEPS; step++) {
    const point = {
      clientX: from.clientX + ((end.clientX - from.clientX) * step) / DRAG_STEPS + (step === 1 ? 10 : 0),
      clientY: from.clientY + ((end.clientY - from.clientY) * step) / DRAG_STEPS + (step === 1 ? 10 : 0),
    };
    pointerEvent(source, "pointermove", { ...point, buttons: 1 });
    pointerEvent(source, "mousemove", { ...point, buttons: 1 });
    await nextFrame();
  }
  movePointerTo(target, 1);
  await nextFrame();
  pointerEvent(target, "pointerup", { ...end, button: 0, buttons: 0 });
  pointerEvent(target, "mouseup", { ...end, button: 0, buttons: 0 });
  return { ok: true, message: `Dragged ${label} (pointer events).` };
}

function hover(control: OutlineControl): Effect {
  const element = control.proxy ?? control.element;
  try { (element as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest" }); } catch { /* detached or unsupported */ }
  movePointerTo(element);
  return { ok: true, message: `Hovered over ${describe(control)}.` };
}

/** Controls a submit would leave invalid under native constraint validation. */
function invalidFormControls(form: HTMLFormElement, outline: Outline): string[] {
  if (form.noValidate) return [];
  return Array.from(form.elements).flatMap((element) => {
    const control = element as HTMLInputElement;
    if (!control.willValidate || control.validity?.valid !== false) return [];
    const known = outline.byElement.get(element);
    const label = known ? describe(known) : `${tagOf(element)}${control.name ? ` name=${control.name}` : ""}`;
    return [`${label}: ${validityMessage(element) ?? "invalid"}`];
  });
}

function submitterForm(element: Element): HTMLFormElement | null {
  const tag = tagOf(element);
  if (tag === "button") {
    const button = element as HTMLButtonElement;
    return (button.getAttribute("type") ?? "submit").toLowerCase() === "submit" && !button.formNoValidate ? button.form : null;
  }
  if (isInput(element)) {
    const type = inputType(element);
    return (type === "submit" || type === "image") && !element.formNoValidate ? element.form : null;
  }
  return null;
}

interface Effect { ok: boolean; code?: ToolResult["code"]; message: string; notes?: string[] }

function fill(control: OutlineControl, text: string): Effect {
  const element = control.element;
  if (isSelect(element)) return select(control, [text]);
  if (isInput(element)) {
    const type = inputType(element);
    if (type === "password") return { ok: false, code: "NOT_INTERACTABLE", message: "Password fields cannot be filled by the agent." };
    if (type === "file") return { ok: false, code: "NOT_INTERACTABLE", message: "Use setInputFiles(\"/workspace/<file>\") for file inputs." };
    if (type === "checkbox" || type === "radio") return { ok: false, code: "NOT_INTERACTABLE", message: "Use setChecked(true|false) for checkboxes and radios." };
    if (!TEXT_INPUT_TYPES.has(type) && type !== "range") return { ok: false, code: "NOT_INTERACTABLE", message: `An input of type ${type} does not accept text; use click().` };
  }
  if (isInput(element) || isTextArea(element)) {
    if (element.readOnly) return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} is read-only.` };
    element.focus?.();
    element.value = text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    dispatch(element, "change");
    const notes: string[] = [];
    if (element.value !== text) {
      const format = isInput(element) ? ({ date: "YYYY-MM-DD", time: "HH:MM", "datetime-local": "YYYY-MM-DDTHH:MM", month: "YYYY-MM", week: "YYYY-Www", number: "a number", color: "#rrggbb" } as Record<string, string>)[inputType(element)] : undefined;
      return { ok: false, code: "NOT_INTERACTABLE", message: `The field rejected the text; its value is now ${JSON.stringify(element.value)}.${format ? ` This input expects ${format}.` : ""}` };
    }
    const invalid = validityMessage(element);
    if (invalid) notes.push(`Field reports invalid: ${invalid}`);
    return { ok: true, message: `Filled ${describe(control)}.`, notes };
  }
  if (isContentEditableRoot(element)) {
    const html = element as HTMLElement;
    html.focus?.();
    const selection = element.ownerDocument.getSelection?.();
    selection?.selectAllChildren(element);
    let inserted = false;
    try {
      inserted = typeof element.ownerDocument.execCommand === "function" && element.ownerDocument.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || trimText(html.textContent ?? "") !== trimText(text)) {
      html.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    }
    return { ok: true, message: `Filled editor ${describe(control)}.` };
  }
  return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} does not accept text. Click it to open it, or fill its text input.` };
}

function select(control: OutlineControl, values: string[]): Effect {
  const element = control.element;
  if (!isSelect(element)) {
    return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} is not a native select. Click it to open the list, then click the option.` };
  }
  const options = Array.from(element.options);
  const chosen: HTMLOptionElement[] = [];
  for (const value of values) {
    const wanted = trimText(value);
    const option = options.find((candidate) => candidate.value === value) ??
      options.find((candidate) => optionLabel(candidate) === wanted) ??
      options.find((candidate) => optionLabel(candidate).toLowerCase() === wanted.toLowerCase());
    if (!option) return { ok: false, code: "TARGET_MISSING", message: `No option ${JSON.stringify(value)} in ${describe(control)}. Options: ${options.slice(0, 30).map(optionLabel).join(" | ")}` };
    if (option.disabled) return { ok: false, code: "NOT_INTERACTABLE", message: `Option ${JSON.stringify(optionLabel(option))} is disabled.` };
    chosen.push(option);
  }
  if (chosen.length > 1 && !element.multiple) return { ok: false, code: "INVALID_TOOL_ARGUMENTS", message: "This select accepts a single option." };
  element.focus?.();
  for (const option of options) option.selected = chosen.includes(option);
  dispatch(element, "input");
  dispatch(element, "change");
  return { ok: true, message: `Selected ${chosen.map((option) => JSON.stringify(optionLabel(option))).join(", ")} in ${describe(control)}.` };
}

/** Types `text` into an editable combobox to filter its options, as keystrokes would: keydown, the new value with an input event, keyup. Never a change event, which some widgets take as a commit. */
function typeFilter(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  element.focus?.();
  const last = text.at(-1) ?? "";
  const key = { key: last, bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new KeyboardEvent("keydown", key));
  element.value = text;
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  element.dispatchEvent(new KeyboardEvent("keyup", key));
}

/** The listboxes a combobox controls (`aria-controls`, `aria-owns`, its active descendant's), or failing that every rendered listbox in its document. */
function listboxesFor(control: OutlineControl): Element[] {
  const element = control.element;
  if (control.role === "listbox") return [element];
  const named = ["aria-controls", "aria-owns"].flatMap((attribute) => (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean))
    .map((id) => rootLookup(element, id)).filter((found): found is Element => !!found);
  const active = element.getAttribute("aria-activedescendant");
  const activeOption = active ? rootLookup(element, active) : null;
  const isListbox = (candidate: Element) => explicitRole(candidate) === "listbox";
  const found = new Set<Element>();
  for (const candidate of named) {
    if (isListbox(candidate)) found.add(candidate);
    else for (const inner of composedDescendants(candidate, isListbox, () => false, { nodes: 20_000 })) found.add(inner);
    if (!found.size && composedDescendants(candidate, (inner) => explicitRole(inner) === "option", () => false, { nodes: 20_000 }).length) found.add(candidate);
  }
  for (let node: Element | null = activeOption; node; node = composedParent(node)) if (isListbox(node)) { found.add(node); break; }
  const rendered = [...found].filter(isRendered);
  if (rendered.length) return rendered;
  const body = element.ownerDocument.body;
  return body ? composedDescendants(body, isListbox, () => false, { nodes: MAX_VISITED_NODES }).filter(isRendered) : [];
}

interface ShownOption { element: Element; label: string }

function shownOptions(control: OutlineControl): ShownOption[] {
  return listboxesFor(control).flatMap((listbox) => composedDescendants(listbox, (candidate) => explicitRole(candidate) === "option", () => false, { nodes: 20_000 }))
    .filter(isRendered)
    .map((element) => ({ element, label: accessibleName(element, "option") || composedText(element, NAME_LIMIT) }));
}

/** The one option whose text is `wanted` (case-insensitive), else the one containing it. */
function matchOption(options: ShownOption[], wanted: string): { option: ShownOption } | { matches: ShownOption[] } {
  const lower = wanted.toLowerCase();
  const exact = options.filter((option) => option.label.toLowerCase() === lower);
  if (exact.length === 1) return { option: exact[0]! };
  if (exact.length > 1) return { matches: exact };
  const partial = options.filter((option) => option.label.toLowerCase().includes(lower));
  return partial.length === 1 ? { option: partial[0]! } : { matches: partial };
}

/** What a combobox shows as its value: an input's value, or the text of a button-like one. */
function shownValue(element: Element): string {
  return isInput(element) || isTextArea(element) ? trimText(element.value ?? "") : composedText(element, VALUE_LIMIT);
}

/** How long `choose` waits for a combobox's options to appear and settle. */
const CHOOSE_WAIT_MS = 5_000;
const CHOOSE_MAX_WAITS = 20;

/**
 * Picks one option of a select or combobox. A native select selects it; an
 * input with a datalist takes the option's value. An ARIA combobox (or
 * listbox, or element with aria-haspopup=listbox) is opened with a click if
 * collapsed, typed into when it is a text field (so filtering widgets load
 * matching options), and then waited on until exactly one shown option
 * matches; that option is clicked and the combobox's shown value checked.
 * Never picks among ambiguous matches.
 */
async function choose(document: Document, control: OutlineControl, option: string, settle: Settle): Promise<Effect> {
  const element = control.element;
  const wanted = trimText(option);
  if (isSelect(element)) return select(control, [option]);
  const listId = isInput(element) ? element.getAttribute("list") : null;
  if (isInput(element) && listId) {
    const list = rootLookup(element, listId);
    const values = list ? Array.from(list.querySelectorAll("option")).map((candidate) => ({ element: candidate as Element, label: trimText(candidate.getAttribute("label") || candidate.textContent || "") || (candidate as HTMLOptionElement).value })) : [];
    const matched = matchOption(values, wanted);
    if (!("option" in matched)) return { ok: false, code: "TARGET_MISSING", message: `${matched.matches.length ? `${matched.matches.length} suggestions match` : "No suggestion matches"} ${JSON.stringify(wanted)} in ${describe(control)}. Suggestions: ${values.slice(0, 30).map((value) => value.label).join(" | ") || "(none)"}` };
    return fill(control, (matched.option.element as HTMLOptionElement).value || matched.option.label);
  }
  const popup = element.getAttribute("aria-haspopup");
  if (control.role !== "combobox" && control.role !== "listbox" && popup !== "listbox") {
    return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} is not a select or combobox. Click it to open its list and click the option; for a date field that accepts typed dates, use fill(text, {commit: true}).` };
  }
  try { (element as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest" }); } catch { /* detached or unsupported */ }
  if (control.role !== "listbox" && (element.getAttribute("aria-expanded") !== "true" || !shownOptions(control).length)) pointerClick(element);
  const editable = (isInput(element) && TEXT_INPUT_TYPES.has(inputType(element))) || isTextArea(element);
  const typed = editable && !(element as HTMLInputElement).readOnly;
  if (typed) typeFilter(element as HTMLInputElement, wanted);

  const deadline = Date.now() + CHOOSE_WAIT_MS;
  let options: ShownOption[] = [];
  let matched: ReturnType<typeof matchOption> = { matches: [] };
  for (let wait = 0; wait < CHOOSE_MAX_WAITS && Date.now() < deadline; wait++) {
    await settle(document);
    options = shownOptions(control);
    matched = matchOption(options, wanted);
    if ("option" in matched) break;
  }
  if (!("option" in matched)) {
    const listed = options.slice(0, 20).map((shown) => JSON.stringify(shown.label)).join(", ");
    if (matched.matches.length > 1) return { ok: false, code: "TARGET_MISSING", message: `${matched.matches.length} options match ${JSON.stringify(wanted)} in ${describe(control)}: ${matched.matches.slice(0, 20).map((shown) => JSON.stringify(shown.label)).join(", ")}. Choose with the full option text.` };
    return {
      ok: false, code: "TARGET_MISSING",
      message: options.length
        ? `No option matching ${JSON.stringify(wanted)} in ${describe(control)}. Options shown: ${listed}${options.length > 20 ? ", …" : ""}.`
        : `No options appeared for ${describe(control)} within ${CHOOSE_WAIT_MS / 1000} s (it shows no role=listbox with role=option items). Read a snapshot and click its options; for a date field that accepts typed dates, use fill(text, {commit: true}).`,
    };
  }
  const picked = matched.option;
  if (isDisabled(picked.element)) return { ok: false, code: "NOT_INTERACTABLE", message: `Option ${JSON.stringify(picked.label)} is disabled.` };
  movePointerTo(picked.element);
  pointerClick(picked.element);
  await settle(document);
  const shown = shownValue(element);
  const label = picked.label.toLowerCase();
  // Text typed to filter proves nothing: an input that still shows just that, with its list open, may have ignored the click.
  const closed = element.getAttribute("aria-expanded") === "false" || !isRendered(picked.element);
  const confirmed = (picked.element.isConnected && picked.element.getAttribute("aria-selected") === "true") ||
    (!!shown && (shown.toLowerCase().includes(label) || label.includes(shown.toLowerCase())) && (!typed || closed || shown !== wanted));
  return confirmed
    ? { ok: true, message: `Chose ${JSON.stringify(picked.label)} in ${describe(control)}${shown ? `; it shows ${JSON.stringify(clip(shown, 120))}` : ""}.` }
    : { ok: true, message: `Clicked option ${JSON.stringify(picked.label)} in ${describe(control)}, but could not confirm it: the field shows ${JSON.stringify(clip(shown, 120))}. Check the changes below or read a snapshot.` };
}

/**
 * Fills a field, then commits it as a typed-date picker expects: Enter
 * (keydown/keyup only; no form submit), then blur. Reports the value the
 * field kept, which a picker may have reformatted; an emptied field failed.
 */
async function fillAndCommit(document: Document, control: OutlineControl, text: string, settle: Settle): Promise<Effect> {
  const filled = fill(control, text);
  if (!filled.ok) return filled;
  const element = control.element as HTMLElement;
  const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new KeyboardEvent("keydown", enter));
  element.dispatchEvent(new KeyboardEvent("keyup", enter));
  if (document.activeElement === element) element.blur();
  else {
    element.dispatchEvent(new FocusEvent("blur", { composed: true }));
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  }
  await settle(document);
  const kept = shownValue(control.element);
  if (!kept) {
    const placeholder = control.element.getAttribute("placeholder");
    return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} did not keep ${JSON.stringify(text)}; it is empty after Enter and blur.${placeholder ? ` Its placeholder suggests the format ${JSON.stringify(placeholder)}.` : ""} If it needs its calendar, click it and pick the day.` };
  }
  return { ok: true, message: `Filled and committed ${describe(control)}; it shows ${JSON.stringify(clip(kept, 120))}${kept === trimText(text) ? "" : " (the field reformatted it)"}.`, notes: filled.notes };
}

function check(control: OutlineControl, checked: boolean): Effect {
  const element = control.element;
  const read = (): boolean | null => isInput(element) ? element.checked : element.getAttribute("aria-checked") === "true" ? true : element.getAttribute("aria-checked") === "false" ? false : null;
  const before = read();
  if (before === null) return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} is not a checkbox, radio, or switch.` };
  if (before === checked) return { ok: true, message: `${describe(control)} was already ${checked ? "checked" : "unchecked"}.` };
  if (!checked && isInput(element) && inputType(element) === "radio") {
    return { ok: false, code: "NOT_INTERACTABLE", message: "A radio cannot be unchecked directly; select another option in its group." };
  }
  pointerClick(control.proxy ?? element);
  if (read() !== checked) return { ok: false, code: "NOT_INTERACTABLE", message: `Clicking ${describe(control)} did not change its state.` };
  return { ok: true, message: `${checked ? "Checked" : "Unchecked"} ${describe(control)}.` };
}

const KEY_CODES: Record<string, { code: string; keyCode: number; key: string }> = {
  Enter: { code: "Enter", keyCode: 13, key: "Enter" }, Tab: { code: "Tab", keyCode: 9, key: "Tab" },
  Escape: { code: "Escape", keyCode: 27, key: "Escape" }, Space: { code: "Space", keyCode: 32, key: " " },
  Backspace: { code: "Backspace", keyCode: 8, key: "Backspace" }, Delete: { code: "Delete", keyCode: 46, key: "Delete" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, key: "ArrowUp" }, ArrowDown: { code: "ArrowDown", keyCode: 40, key: "ArrowDown" },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37, key: "ArrowLeft" }, ArrowRight: { code: "ArrowRight", keyCode: 39, key: "ArrowRight" },
  Home: { code: "Home", keyCode: 36, key: "Home" }, End: { code: "End", keyCode: 35, key: "End" },
  PageUp: { code: "PageUp", keyCode: 33, key: "PageUp" }, PageDown: { code: "PageDown", keyCode: 34, key: "PageDown" },
};

const MODIFIER_KEYS: Record<KeyModifier, { code: string; keyCode: number; flag: "ctrlKey" | "altKey" | "shiftKey" | "metaKey" }> = {
  Control: { code: "ControlLeft", keyCode: 17, flag: "ctrlKey" }, Alt: { code: "AltLeft", keyCode: 18, flag: "altKey" },
  Shift: { code: "ShiftLeft", keyCode: 16, flag: "shiftKey" }, Meta: { code: "MetaLeft", keyCode: 91, flag: "metaKey" },
};

/** A named key's codes, or a letter's or digit's (`KeyK`, `Digit7`); Shift makes a letter's `key` uppercase. */
function keyInfo(key: PressKey, shift: boolean): { code: string; keyCode: number; key: string } {
  const named = KEY_CODES[key];
  if (named) return named;
  const upper = key.toUpperCase();
  return /\d/.test(key)
    ? { code: `Digit${key}`, keyCode: upper.charCodeAt(0), key }
    : { code: `Key${upper}`, keyCode: upper.charCodeAt(0), key: shift ? upper : key };
}

/**
 * Presses a key on the element: each modifier goes down in order, then the
 * key (keydown, keypress for an unmodified Enter or Space, keyup) with the
 * modifier flags set, then the modifiers come up in reverse. Only an
 * unmodified Enter has a default here (submitting a text field's form, or
 * activating a button or link); everything else is the page's own handlers.
 */
function press(control: OutlineControl, key: PressKey, modifiers: readonly KeyModifier[], outline: Outline): Effect {
  const element = control.element;
  (element as HTMLElement).focus?.();
  const flags = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  const keyboard = (type: string, info: { code: string; keyCode: number; key: string }) =>
    element.dispatchEvent(new KeyboardEvent(type, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true, composed: true, ...flags }));
  for (const modifier of modifiers) {
    const { flag, ...info } = MODIFIER_KEYS[modifier];
    flags[flag] = true;
    keyboard("keydown", { ...info, key: modifier });
  }
  const info = keyInfo(key, flags.shiftKey);
  const proceed = keyboard("keydown", info);
  if ((key === "Enter" || key === "Space") && !modifiers.length) keyboard("keypress", info);
  const notes: string[] = [];
  if (proceed && key === "Enter" && !modifiers.length) {
    if ((isInput(element) && TEXT_INPUT_TYPES.has(inputType(element))) && element.form) {
      const invalid = invalidFormControls(element.form, outline);
      if (invalid.length) notes.push(`Native validation blocked submission: ${invalid.join("; ")}`);
      else if (typeof element.form.requestSubmit === "function") element.form.requestSubmit();
      else dispatch(element.form, "submit");
    } else if (tagOf(element) === "button" || isAnchor(element) || control.role === "button" || control.role === "link") {
      (element as HTMLElement).click();
    }
  }
  keyboard("keyup", info);
  for (const modifier of [...modifiers].reverse()) {
    const { flag, ...info } = MODIFIER_KEYS[modifier];
    flags[flag] = false;
    keyboard("keyup", { ...info, key: modifier });
  }
  return { ok: true, message: `Pressed ${formatKeyChord(key, modifiers)} on ${describe(control)}.`, notes };
}

function upload(control: OutlineControl, files: UploadFile[]): Effect {
  const element = control.element;
  if (!isInput(element) || inputType(element) !== "file") return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} is not a file input.` };
  if (files.length > 1 && !element.multiple) return { ok: false, code: "INVALID_TOOL_ARGUMENTS", message: "This file input accepts a single file." };
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(new File(["text" in file ? file.text : decodeBase64(file.base64)], file.name, { type: file.mimeType }));
  element.files = transfer.files;
  if ((element.files?.length ?? 0) !== files.length) return { ok: false, code: "NOT_INTERACTABLE", message: "The browser did not accept the file assignment." };
  dispatch(element, "input");
  dispatch(element, "change");
  return { ok: true, message: `Attached ${files.map((file) => JSON.stringify(file.name)).join(", ")} to ${describe(control)}.` };
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function click(control: OutlineControl, outline: Outline): Effect {
  const element = control.element;
  if (isAnchor(element) && element.hasAttribute("download")) {
    return { ok: false, code: "NOT_INTERACTABLE", message: "Download links are not supported." };
  }
  if (isAnchor(element) && element.target === "_blank") {
    return { ok: false, code: "NOT_INTERACTABLE", message: `This link opens a new tab. Use page.navigate(${JSON.stringify(element.href)}) or browser.open(${JSON.stringify(element.href)}) instead.` };
  }
  if (isInput(element) && inputType(element) === "file") {
    return { ok: false, code: "NOT_INTERACTABLE", message: "File pickers cannot be opened; use setInputFiles(\"/workspace/<file>\")." };
  }
  const notes: string[] = [];
  const form = submitterForm(element);
  if (form) {
    const invalid = invalidFormControls(form, outline);
    if (invalid.length) notes.push(`Native validation will block this submission: ${invalid.join("; ")}`);
  }
  pointerClick(control.proxy ?? element);
  return { ok: true, message: `Clicked ${describe(control)}.`, notes };
}

function scroll(document: Document, control: OutlineControl | null, direction: string, amount: string): Effect {
  const view = document.defaultView;
  const step = amount === "page" ? Math.max(200, Math.round((view?.innerHeight ?? 1000) * 0.85)) : 120;
  const dx = direction === "left" ? -step : direction === "right" ? step : 0;
  const dy = direction === "up" ? -step : direction === "down" ? step : 0;
  if (!control) {
    view?.scrollBy?.(dx, dy);
    return { ok: true, message: `Scrolled the page ${direction}; position y=${Math.round(view?.scrollY ?? 0)}.` };
  }
  control.element.scrollBy?.(dx, dy);
  return { ok: true, message: `Scrolled ${describe(control)} ${direction}.` };
}

const MAX_DIFF_ADDED = 25;
const MAX_DIFF_REMOVED = 8;
const MAX_DIFF_LINE = 300;

/** Multiset line diff: what appeared and disappeared in the outline. */
export function describeChanges(before: readonly string[], after: readonly string[]): string {
  const remaining = new Map<string, number>();
  for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  const removed = [...remaining.entries()].flatMap(([line, count]) => Array<string>(count).fill(line));
  if (!added.length && !removed.length) return describeReorder(before, after);
  const lines = [`Page changes (+${added.length} −${removed.length} lines):`];
  lines.push(...added.slice(0, MAX_DIFF_ADDED).map((line) => `+ ${clip(line, MAX_DIFF_LINE)}`));
  if (added.length > MAX_DIFF_ADDED) lines.push(`+ …${added.length - MAX_DIFF_ADDED} more added lines; read a snapshot to see them.`);
  lines.push(...removed.slice(0, MAX_DIFF_REMOVED).map((line) => `- ${clip(line, MAX_DIFF_LINE)}`));
  if (removed.length > MAX_DIFF_REMOVED) lines.push(`- …${removed.length - MAX_DIFF_REMOVED} more removed lines.`);
  return lines.join("\n");
}

/** The same lines in a new order (a sorted table, a dragged list item): the span that changed, as it reads now. */
function describeReorder(before: readonly string[], after: readonly string[]): string {
  let start = 0;
  while (start < after.length && before[start] === after[start]) start++;
  if (start === after.length) return "Page outline unchanged.";
  let end = after.length - 1;
  while (end > start && before[end] === after[end]) end--;
  const span = after.slice(start, end + 1);
  const lines = [`Page outline reordered (${span.length} lines moved); that part now reads:`];
  lines.push(...span.slice(0, MAX_DIFF_ADDED).map((line) => `~ ${clip(line, MAX_DIFF_LINE)}`));
  if (span.length > MAX_DIFF_ADDED) lines.push(`~ …${span.length - MAX_DIFF_ADDED} more lines; read a snapshot to see them.`);
  return lines.join("\n");
}

/**
 * Resolves the target against a fresh outline, performs one effect, waits for
 * the DOM to settle, and reports the effect, validation feedback, and outline
 * changes. Never retries, and never guesses an alternative target.
 */
export async function executeDomAction(
  document: Document,
  registry: ElementRefRegistry,
  action: DomAction,
  settle: Settle = settleDom,
  options: OutlineOptions = {},
): Promise<ToolResult> {
  const before = buildOutline(document, registry, options);
  const urlBefore = document.location?.href;
  let control: OutlineControl | null = null;
  if (action.target) {
    const resolved = resolveTarget(before, registry, action.target);
    if (!resolved.ok) return resolved.result;
    control = resolved.control;
  }
  let to: OutlineControl | null = null;
  if (action.kind === "drag") {
    const resolved = resolveTarget(before, registry, action.to);
    if (!resolved.ok) return { ...resolved.result, summary: `Drop target: ${resolved.result.summary}` };
    to = resolved.control;
  }
  let effect: Effect;
  switch (action.kind) {
    case "click": effect = click(control!, before); break;
    case "hover": effect = hover(control!); break;
    case "drag": effect = await drag(control!, to!); break;
    case "fill": effect = action.commit ? await fillAndCommit(document, control!, action.text, settle) : fill(control!, action.text); break;
    case "select": effect = select(control!, action.values); break;
    case "choose": effect = await choose(document, control!, action.option, settle); break;
    case "check": effect = check(control!, action.checked); break;
    case "press": effect = press(control!, action.key, action.modifiers ?? [], before); break;
    case "upload": effect = upload(control!, action.files); break;
    case "scroll": effect = scroll(document, control, action.direction, action.amount); break;
  }
  if (!effect.ok) return { ok: false, code: effect.code ?? "NOT_INTERACTABLE", summary: effect.message };
  await settle(document);
  const after = buildOutline(document, registry, options);
  const location = document.location?.href;
  const parts = [effect.message, ...(effect.notes ?? [])];
  if (action.kind !== "scroll") {
    const changes = describeChanges(before.lines, after.lines);
    parts.push(changes);
    if (action.kind === "hover" && changes === "Page outline unchanged.") {
      parts.push("Nothing opened. A menu that opens only by CSS :hover does not respond to the agent's pointer; try click(), or focus it and press(\"ArrowDown\").");
    }
  }
  if (location && location !== urlBefore) parts.push(`URL changed to ${location}`);
  return { ok: true, summary: parts.join("\n") };
}

/**
 * Measures the page for a screenshot, in document coordinates: the scrolled
 * viewport, the page's full size, and the target element's border box
 * (resolved like an action's target against a fresh outline, so a ref from an
 * earlier document is stale). Same-origin frames add their offsets.
 */
export function measureForCapture(document: Document, registry: ElementRefRegistry, target: ElementTarget | null, options: OutlineOptions = {}):
  { ok: true; geometry: CaptureGeometry } | { ok: false; result: ToolResult } {
  const view = document.defaultView;
  const root = document.documentElement;
  const viewport: PageRect = {
    x: view?.scrollX ?? 0,
    y: view?.scrollY ?? 0,
    width: root?.clientWidth || view?.innerWidth || 0,
    height: root?.clientHeight || view?.innerHeight || 0,
  };
  const page = {
    width: Math.max(viewport.width, root?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0),
    height: Math.max(viewport.height, root?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0),
  };
  let element: PageRect | null = null;
  if (target) {
    const resolved = resolveTarget(buildOutline(document, registry, options), registry, target, { allowDisabled: true, accept: "any" });
    if (!resolved.ok) return resolved;
    const { control } = resolved;
    element = documentRect(control.element, view);
    if ((!element.width || !element.height) && control.proxy) element = documentRect(control.proxy, view);
    if (!element.width || !element.height) {
      return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `${describe(control)} has no visible box to capture.` } };
    }
  }
  return {
    ok: true,
    geometry: { documentId: registry.documentId, url: document.location?.href ?? "", title: document.title, viewport, page, element },
  };
}

/**
 * Measures a cross-origin child frame for a screenshot of an element inside
 * it: the frame element's content box (where the frame's own viewport is
 * drawn) in document coordinates, found by Firefox's frame id among the
 * frames in this document, its shadow roots, and its same-origin frames.
 */
export function measureFrameForCapture(document: Document, registry: ElementRefRegistry, frameId: number, frameIdOf: (frame: Element) => number):
  { ok: true; geometry: CaptureGeometry } | { ok: false; result: ToolResult } {
  const measured = measureForCapture(document, registry, null);
  if (!measured.ok) return measured;
  const frame = frameElements(document).find((candidate) => frameIdOf(candidate) === frameId);
  if (!frame) return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: "The frame is no longer on the page. Read a fresh snapshot." } };
  const border = documentRect(frame, document.defaultView);
  const style = styleOf(frame);
  const x = border.x + frame.clientLeft + (parseFloat(style?.paddingLeft ?? "") || 0);
  const y = border.y + frame.clientTop + (parseFloat(style?.paddingTop ?? "") || 0);
  const width = frame.clientWidth - (parseFloat(style?.paddingLeft ?? "") || 0) - (parseFloat(style?.paddingRight ?? "") || 0);
  const height = frame.clientHeight - (parseFloat(style?.paddingTop ?? "") || 0) - (parseFloat(style?.paddingBottom ?? "") || 0);
  return { ok: true, geometry: { ...measured.geometry, element: { x, y, width: Math.max(0, width), height: Math.max(0, height) } } };
}

/** Every iframe/frame element in a document, its shadow roots, and its same-origin frames. */
function frameElements(root: Document | ShadowRoot): Element[] {
  const found: Element[] = [];
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tag = tagOf(element);
    if (tag === "iframe" || tag === "frame") {
      found.push(element);
      let inner: Document | null = null;
      try { inner = (element as HTMLIFrameElement).contentDocument; } catch { inner = null; }
      if (inner) found.push(...frameElements(inner));
    }
    const shadow = shadowRootOf(element);
    if (shadow) found.push(...frameElements(shadow));
  }
  return found;
}

/** An element's border box relative to the top document, adding the offsets of the same-origin frames it is in. */
function documentRect(element: Element, top: Window | null): PageRect {
  const box = element.getBoundingClientRect();
  let x = box.left;
  let y = box.top;
  let view = element.ownerDocument.defaultView;
  while (view && view !== top && view.frameElement) {
    const frame = view.frameElement;
    const outer = frame.getBoundingClientRect();
    x += outer.left + frame.clientLeft;
    y += outer.top + frame.clientTop;
    view = frame.ownerDocument.defaultView;
  }
  return { x: x + (top?.scrollX ?? 0), y: y + (top?.scrollY ?? 0), width: box.width, height: box.height };
}
