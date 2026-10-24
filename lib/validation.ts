/**
 * Strict, `additionalProperties:false`-equivalent argument validators for the
 * page tool vocabulary. Every tool call's raw `JsonValue` arguments are
 * revalidated here — both by the content-script executor and, from Slice 4
 * on, by the agent loop after the provider returns complete arguments.
 */

import type { DomAction, ElementTarget, JsonValue, PressKey, UploadFile } from "@/lib/domain/tools";

const MAX_REF_LEN = 32;
const MAX_DOCUMENT_ID_LEN = 64;
const MAX_ROLE_LEN = 64;
const MAX_NAME_LEN = 1000;
const MAX_FILL_TEXT_LEN = 16_000;
const MAX_URL_LEN = 2048;
const MAX_SELECT_VALUES = 20;
const MAX_SELECT_VALUE_LEN = 256;
export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_FILE_CHARS = 32_000;
export const PRESS_KEYS: readonly PressKey[] = ["Enter", "Tab", "Escape", "Space", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

export function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

export function validateElementTarget(raw: unknown): ElementTarget | null {
  if (!isObject(raw)) return null;
  if (raw.kind === "ref") {
    if (!hasExactKeys(raw, ["kind", "ref", "documentId"])) return null;
    if (typeof raw.ref !== "string" || !/^e[1-9]\d{0,8}$/.test(raw.ref) || raw.ref.length > MAX_REF_LEN) return null;
    if (!isBoundedString(raw.documentId, MAX_DOCUMENT_ID_LEN)) return null;
    return { kind: "ref", ref: raw.ref, documentId: raw.documentId };
  }
  if (raw.kind === "role") {
    if (!hasExactKeys(raw, ["kind", "role", "name", "exact"])) return null;
    if (!isBoundedString(raw.role, MAX_ROLE_LEN) || typeof raw.exact !== "boolean") return null;
    if (raw.name !== null && (typeof raw.name !== "string" || raw.name.length > MAX_NAME_LEN)) return null;
    return { kind: "role", role: raw.role, name: raw.name, exact: raw.exact };
  }
  return null;
}

function validateUploadFile(raw: unknown): UploadFile | null {
  if (!isObject(raw)) return null;
  if (!isBoundedString(raw.name, 255) || /[\\/\x00-\x1f]/.test(raw.name)) return null;
  if (hasExactKeys(raw, ["name", "mimeType", "base64"])) {
    if (!isBinaryFile(raw.name, raw.mimeType, raw.base64)) return null;
    return { name: raw.name, mimeType: raw.mimeType as string, base64: raw.base64 as string };
  }
  if (!hasExactKeys(raw, ["name", "mimeType", "text"])) return null;
  if (typeof raw.mimeType !== "string" || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(raw.mimeType)) return null;
  if (typeof raw.text !== "string" || raw.text.length > MAX_UPLOAD_FILE_CHARS) return null;
  return { name: raw.name, mimeType: raw.mimeType, text: raw.text };
}

/** Strict, `additionalProperties:false`-equivalent validation of the closed DOM action union. */
export function validateDomAction(raw: unknown): DomAction | null {
  if (!isObject(raw)) return null;
  const target = () => validateElementTarget(raw.target);
  switch (raw.kind) {
    case "click": {
      const t = target();
      return t && hasExactKeys(raw, ["kind", "target"]) ? { kind: "click", target: t } : null;
    }
    case "fill": {
      const t = target();
      if (!t || !hasExactKeys(raw, ["kind", "target", "text"])) return null;
      if (typeof raw.text !== "string" || raw.text.length > MAX_FILL_TEXT_LEN) return null;
      return { kind: "fill", target: t, text: raw.text };
    }
    case "select": {
      const t = target();
      if (!t || !hasExactKeys(raw, ["kind", "target", "values"])) return null;
      if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > MAX_SELECT_VALUES) return null;
      if (!raw.values.every((value) => typeof value === "string" && value.length <= MAX_SELECT_VALUE_LEN)) return null;
      return { kind: "select", target: t, values: raw.values as string[] };
    }
    case "check": {
      const t = target();
      if (!t || !hasExactKeys(raw, ["kind", "target", "checked"]) || typeof raw.checked !== "boolean") return null;
      return { kind: "check", target: t, checked: raw.checked };
    }
    case "press": {
      const t = target();
      if (!t || !hasExactKeys(raw, ["kind", "target", "key"])) return null;
      if (!(PRESS_KEYS as readonly unknown[]).includes(raw.key)) return null;
      return { kind: "press", target: t, key: raw.key as PressKey };
    }
    case "upload": {
      const t = target();
      if (!t || !hasExactKeys(raw, ["kind", "target", "files"])) return null;
      if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > MAX_UPLOAD_FILES) return null;
      const files = raw.files.map(validateUploadFile);
      if (files.some((file) => file === null)) return null;
      return { kind: "upload", target: t, files: files as UploadFile[] };
    }
    case "scroll": {
      if (!hasExactKeys(raw, ["kind", "target", "direction", "amount"])) return null;
      const t = raw.target === null ? null : target();
      if (raw.target !== null && !t) return null;
      if (raw.direction !== "up" && raw.direction !== "down" && raw.direction !== "left" && raw.direction !== "right") return null;
      if (raw.amount !== "line" && raw.amount !== "page") return null;
      return { kind: "scroll", target: t, direction: raw.direction, amount: raw.amount };
    }
    default:
      return null;
  }
}

/** Accepts only absolute HTTP(S) URLs within the length bound. */
export function validateHttpUrl(url: unknown): string | null {
  if (!isBoundedString(url, MAX_URL_LEN)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return url;
}

const MAX_API_KEY_LEN = 512;
const MAX_PROMPT_LEN = 16_000;

export function validateApiKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_API_KEY_LEN) return null;
  return trimmed;
}

export function validatePromptText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_LEN) return null;
  return trimmed;
}

/** Session ids are opaque: random UUIDs, or the migrated legacy conversation's id. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export const MAX_SESSION_TITLE_LEN = 120;

/** Normalizes a user-chosen session title: whitespace collapsed, non-empty, bounded. */
export function validateSessionTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length === 0 || title.length > MAX_SESSION_TITLE_LEN) return null;
  return title;
}

/** `/workspace` scratch-file limits, per session. */
export const WORKSPACE_MAX_FILES = 64;
export const WORKSPACE_MAX_FILE_CHARS = 32_000;
/** Most bytes (decoded) one binary `/workspace` file may hold. */
export const WORKSPACE_MAX_BINARY_BYTES = 1_500_000;
/** Most bytes (decoded) all of one session's binary files may hold together. */
export const WORKSPACE_MAX_BINARY_TOTAL_BYTES = 6_000_000;
/** The binary file types `/workspace` holds, by extension; the extension decides the type. */
export const WORKSPACE_BINARY_TYPES: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};
/** Binary types the model can look at with `fs.view`. */
export const VIEWABLE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The binary type a file name's extension stands for, or null for a text file. */
export function binaryTypeFor(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : WORKSPACE_BINARY_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Decoded size of canonical base64 text, or null if it is not base64. */
export function base64Bytes(data: unknown): number | null {
  if (typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/** A binary file: an allowed type its name's extension stands for, and 1 to `WORKSPACE_MAX_BINARY_BYTES` base64 bytes. */
export function isBinaryFile(name: string, mimeType: unknown, base64: unknown): boolean {
  const bytes = base64Bytes(base64);
  return binaryTypeFor(name) === mimeType && bytes !== null && bytes > 0 && bytes <= WORKSPACE_MAX_BINARY_BYTES;
}

/** A `/workspace/…` file path: segments of letters, digits, '.', '_' and '-', no traversal, at most 256 characters. */
export function isWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    /^\/workspace\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value);
}
