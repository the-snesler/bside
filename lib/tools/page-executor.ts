/**
 * Pure, testable DOM semantics for the page tool vocabulary. Given a live
 * `Document` and a per-document ref registry, this module renders a bounded
 * page outline and executes the closed `DomAction` union against it.
 *
 * The outline walks the composed tree in document order: open and closed
 * shadow roots, slot assignments, and same-origin frames. Interactive
 * elements are inlined as `[e12 button "Save"]` tokens whose refs stay bound
 * to the same element for the document's lifetime. Hidden radios, checkboxes,
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

import type { DomAction, ElementTarget, PageFindResult, PageSnapshot, SearchResult, ToolResult } from "@/lib/domain/tools";

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
  "option", "treeitem", "clickable",
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
  | { t: "control"; control: OutlineControl };

export interface Outline {
  lines: string[];
  /** Character offset of each line within `lines.join("\n")`. */
  offsets: number[];
  controls: OutlineControl[];
  byElement: Map<Element, OutlineControl>;
  byRef: Map<string, OutlineControl>;
  scanLimited: boolean;
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
  visited = 0;
  scanLimited = false;
  #lastText = "";

  constructor(private registry: ElementRefRegistry, private pageUrl: string) {}

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
      // Tracking pixels and ad beacons are 0–1 px frames.
      const tiny = [style?.width, style?.height].some((size) => size?.endsWith("px") && parseFloat(size) < 2);
      if (visible && !tiny) this.#frame(element as HTMLIFrameElement, context);
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

    const control: OutlineControl = { ref: refFor(this.registry, element), role, name, element, proxy, disabled, details, ...(href ? { href } : {}) };
    this.controls.push(control);
    this.byElement.set(element, control);
    this.segments.push({ t: "control", control });
    return descend;
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
      this.text(`[frame${label} cross-origin → ${clip(src, 200)}]`);
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

function renderControl(control: OutlineControl): string {
  const parts = [control.ref, control.role];
  if (control.name) parts.push(JSON.stringify(control.name));
  if (control.href) parts.push(`→ ${control.href}`);
  parts.push(...control.details);
  return `[${parts.join(" ")}]`;
}

function render(segments: Segment[]): string[] {
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
    else if (segment.t === "prefix") {
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

export function buildOutline(document: Document, registry: ElementRefRegistry): Outline {
  const builder = new OutlineBuilder(registry, document.location?.href ?? "");
  if (document.body) builder.walk(document.body, { visible: true, pre: false, inControl: false, parentStyle: null });
  const segments = dropRedundantLinks(builder.segments);
  const kept = new Set(segments.flatMap((segment) => (segment.t === "control" ? [segment.control] : [])));
  const controls = builder.controls.filter((control) => kept.has(control));
  let lines = render(segments);
  if (builder.scanLimited) lines.push("[Page too large: outline scan stopped early. Use page.find() for specific content.]");
  const offsets: number[] = [];
  let total = 0;
  const bounded: string[] = [];
  for (const line of lines) {
    if (total + line.length > MAX_OUTLINE_CHARS) { bounded.push("[Outline truncated: page exceeds the outline size limit]"); offsets.push(total); break; }
    offsets.push(total);
    bounded.push(line);
    total += line.length + 1;
  }
  lines = bounded;
  const byElement = new Map(controls.map((control) => [control.element, control]));
  const byRef = new Map(controls.map((control) => [control.ref, control]));
  return { lines, offsets, controls, byElement, byRef, scanLimited: builder.scanLimited };
}

// ---------------------------------------------------------------------------
// Snapshot, find, and search-result extraction
// ---------------------------------------------------------------------------

export function extractSnapshot(
  document: Document,
  tabId: number,
  registry: ElementRefRegistry,
  options: { offset: number; maxChars: number } = { offset: 0, maxChars: 16_000 },
): PageSnapshot {
  const outline = buildOutline(document, registry);
  const text = outline.lines.join("\n");
  let start = Math.min(Math.max(options.offset, 0), text.length);
  if (start > 0 && text[start - 1] !== "\n") start = text.lastIndexOf("\n", start - 1) + 1;
  let end = Math.min(text.length, start + options.maxChars);
  if (end < text.length) {
    const cut = text.lastIndexOf("\n", end);
    if (cut > start) end = cut;
  }
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
    selectionText: trimText(document.getSelection?.()?.toString() ?? "").slice(0, 2000),
  };
}

const MAX_FIND_MATCHES = 30;
const FIND_LINE_LIMIT = 400;

export function findInPage(document: Document, registry: ElementRefRegistry, query: string): PageFindResult {
  const outline = buildOutline(document, registry);
  const needle = trimText(query).toLowerCase();
  const matches: PageFindResult["matches"] = [];
  let count = 0;
  outline.lines.forEach((line, index) => {
    const position = line.toLowerCase().indexOf(needle);
    if (position < 0) return;
    count++;
    if (matches.length >= MAX_FIND_MATCHES) return;
    let text = line;
    if (line.length > FIND_LINE_LIMIT) {
      const from = Math.max(0, position - 180);
      text = `${from > 0 ? "…" : ""}${line.slice(from, from + FIND_LINE_LIMIT)}${from + FIND_LINE_LIMIT < line.length ? "…" : ""}`;
    }
    // A short preceding line (often a label or heading) gives the match context.
    const previous = outline.lines[index - 1];
    if (previous && previous.length <= 120 && !previous.toLowerCase().includes(needle)) text = `${previous}\n${text}`;
    matches.push({ offset: outline.offsets[index] ?? 0, text });
  });
  return { documentId: registry.documentId, url: document.location?.href ?? "", query, count, matches };
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
  return `[${[control.ref, control.role, ...(control.name ? [JSON.stringify(control.name)] : [])].join(" ")}]`;
}

function candidatesText(controls: OutlineControl[], limit = 8): string {
  const shown = controls.slice(0, limit).map(describe).join("; ");
  return controls.length > limit ? `${shown}; …+${controls.length - limit} more` : shown;
}

function resolveTarget(outline: Outline, registry: ElementRefRegistry, target: ElementTarget): Resolved {
  if (target.kind === "ref") {
    if (target.documentId !== registry.documentId) {
      return { ok: false, result: { ok: false, code: "STALE_SNAPSHOT", summary: `Ref ${target.ref} came from an earlier page load; this tab now shows a different document. Read a fresh snapshot.` } };
    }
    const control = outline.byRef.get(target.ref);
    if (control) {
      if (control.disabled) return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `${describe(control)} is disabled.` } };
      return { ok: true, control };
    }
    const element = registry.byRef.get(target.ref);
    if (element?.isConnected) return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `Ref ${target.ref} is currently hidden or not an interactive element.` } };
    return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Ref ${target.ref} is no longer on the page. Read a fresh snapshot.` } };
  }
  const wanted = target.name === null ? null : trimText(target.name);
  const sameRole = outline.controls.filter((control) => target.role === "*" || control.role === target.role ||
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
  if (matches.length === 1) {
    const control = matches[0]!;
    if (control.disabled) return { ok: false, result: { ok: false, code: "NOT_INTERACTABLE", summary: `${describe(control)} is disabled.` } };
    return { ok: true, control };
  }
  const label = `${target.role === "*" ? "element" : target.role}${wanted === null ? "" : ` ${target.exact ? "named exactly" : "with name containing"} ${JSON.stringify(wanted)}`}`;
  if (matches.length > 1) {
    return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Locator ${label} matched ${matches.length} elements: ${candidatesText(matches)}. Use page.ref("eN") for the intended one.` } };
  }
  const similar = wanted
    ? outline.controls.filter((control) => control.name.toLowerCase().includes(wanted.toLowerCase().slice(0, 24)))
    : [];
  const kind = target.role === "*" ? "Interactive" : target.role;
  const hint = similar.length ? ` Similar controls: ${candidatesText(similar)}.` : sameRole.length ? ` ${kind} controls on the page: ${candidatesText(sameRole)}.` : ` No ${kind} controls are visible.`;
  return { ok: false, result: { ok: false, code: "TARGET_MISSING", summary: `Locator ${label} matched 0 elements.${hint} Use page.ref("eN") from a snapshot.` } };
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
  Backspace: { code: "Backspace", keyCode: 8, key: "Backspace" }, ArrowUp: { code: "ArrowUp", keyCode: 38, key: "ArrowUp" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, key: "ArrowDown" }, ArrowLeft: { code: "ArrowLeft", keyCode: 37, key: "ArrowLeft" },
  ArrowRight: { code: "ArrowRight", keyCode: 39, key: "ArrowRight" },
};

function press(control: OutlineControl, key: string, outline: Outline): Effect {
  const element = control.element;
  const info = KEY_CODES[key]!;
  (element as HTMLElement).focus?.();
  const init = { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true, composed: true };
  const proceed = element.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key === "Enter" || key === "Space") element.dispatchEvent(new KeyboardEvent("keypress", init));
  const notes: string[] = [];
  if (proceed && key === "Enter") {
    if ((isInput(element) && TEXT_INPUT_TYPES.has(inputType(element))) && element.form) {
      const invalid = invalidFormControls(element.form, outline);
      if (invalid.length) notes.push(`Native validation blocked submission: ${invalid.join("; ")}`);
      else if (typeof element.form.requestSubmit === "function") element.form.requestSubmit();
      else dispatch(element.form, "submit");
    } else if (tagOf(element) === "button" || isAnchor(element) || control.role === "button" || control.role === "link") {
      (element as HTMLElement).click();
    }
  }
  element.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true, message: `Pressed ${key} on ${describe(control)}.`, notes };
}

function upload(control: OutlineControl, files: { name: string; mimeType: string; text: string }[]): Effect {
  const element = control.element;
  if (!isInput(element) || inputType(element) !== "file") return { ok: false, code: "NOT_INTERACTABLE", message: `${describe(control)} is not a file input.` };
  if (files.length > 1 && !element.multiple) return { ok: false, code: "INVALID_TOOL_ARGUMENTS", message: "This file input accepts a single file." };
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(new File([file.text], file.name, { type: file.mimeType }));
  element.files = transfer.files;
  if ((element.files?.length ?? 0) !== files.length) return { ok: false, code: "NOT_INTERACTABLE", message: "The browser did not accept the file assignment." };
  dispatch(element, "input");
  dispatch(element, "change");
  return { ok: true, message: `Attached ${files.map((file) => JSON.stringify(file.name)).join(", ")} to ${describe(control)}.` };
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
  if (!added.length && !removed.length) return "Page outline unchanged.";
  const lines = [`Page changes (+${added.length} −${removed.length} lines):`];
  lines.push(...added.slice(0, MAX_DIFF_ADDED).map((line) => `+ ${clip(line, MAX_DIFF_LINE)}`));
  if (added.length > MAX_DIFF_ADDED) lines.push(`+ …${added.length - MAX_DIFF_ADDED} more added lines; read a snapshot to see them.`);
  lines.push(...removed.slice(0, MAX_DIFF_REMOVED).map((line) => `- ${clip(line, MAX_DIFF_LINE)}`));
  if (removed.length > MAX_DIFF_REMOVED) lines.push(`- …${removed.length - MAX_DIFF_REMOVED} more removed lines.`);
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
): Promise<ToolResult> {
  const before = buildOutline(document, registry);
  const urlBefore = document.location?.href;
  let control: OutlineControl | null = null;
  if (action.target) {
    const resolved = resolveTarget(before, registry, action.target);
    if (!resolved.ok) return resolved.result;
    control = resolved.control;
  }
  let effect: Effect;
  switch (action.kind) {
    case "click": effect = click(control!, before); break;
    case "fill": effect = fill(control!, action.text); break;
    case "select": effect = select(control!, action.values); break;
    case "check": effect = check(control!, action.checked); break;
    case "press": effect = press(control!, action.key, before); break;
    case "upload": effect = upload(control!, action.files); break;
    case "scroll": effect = scroll(document, control, action.direction, action.amount); break;
  }
  if (!effect.ok) return { ok: false, code: effect.code ?? "NOT_INTERACTABLE", summary: effect.message };
  await settle(document);
  const after = buildOutline(document, registry);
  const location = document.location?.href;
  const parts = [effect.message, ...(effect.notes ?? [])];
  if (action.kind !== "scroll") parts.push(describeChanges(before.lines, after.lines));
  if (location && location !== urlBefore) parts.push(`URL changed to ${location}`);
  return { ok: true, summary: parts.join("\n") };
}
