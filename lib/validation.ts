/**
 * Strict, `additionalProperties:false`-equivalent argument validators for the
 * page tool vocabulary. Every tool call's raw `JsonValue` arguments are
 * revalidated here — both by the content-script executor and, from Slice 4
 * on, by the agent loop after the provider returns complete arguments.
 */

import type { JsonValue } from "@/lib/domain/tools";

const MAX_REF_LEN = 128;
const MAX_REVISION_LEN = 128;
const MAX_FILL_TEXT_LEN = 8000;
const MAX_URL_LEN = 2048;
const MAX_SELECT_VALUES = 20;
const MAX_SELECT_VALUE_LEN = 256;

export function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: JsonValue | undefined, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export interface ClickArgs {
  ref: string;
  revision: string;
}

export function validateClickArgs(args: JsonValue): ClickArgs | null {
  if (!isRecord(args)) return null;
  const { ref, revision, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (!isBoundedString(ref, MAX_REF_LEN) || !isBoundedString(revision, MAX_REVISION_LEN)) return null;
  return { ref, revision };
}

export interface FillArgs {
  ref: string;
  revision: string;
  text: string;
}

export function validateFillArgs(args: JsonValue): FillArgs | null {
  if (!isRecord(args)) return null;
  const { ref, revision, text, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (!isBoundedString(ref, MAX_REF_LEN) || !isBoundedString(revision, MAX_REVISION_LEN)) return null;
  if (typeof text !== "string" || text.length > MAX_FILL_TEXT_LEN) return null;
  return { ref, revision, text };
}

export interface SelectOptionArgs {
  ref: string;
  revision: string;
  values: string[];
}

export function validateSelectOptionArgs(args: JsonValue): SelectOptionArgs | null {
  if (!isRecord(args)) return null;
  const { ref, revision, values, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (!isBoundedString(ref, MAX_REF_LEN) || !isBoundedString(revision, MAX_REVISION_LEN)) return null;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SELECT_VALUES) return null;
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_SELECT_VALUE_LEN) return null;
  }
  return { ref, revision, values: values as string[] };
}

export interface SetCheckedArgs {
  ref: string;
  revision: string;
  checked: boolean;
}

export function validateSetCheckedArgs(args: JsonValue): SetCheckedArgs | null {
  if (!isRecord(args)) return null;
  const { ref, revision, checked, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (!isBoundedString(ref, MAX_REF_LEN) || !isBoundedString(revision, MAX_REVISION_LEN)) return null;
  if (typeof checked !== "boolean") return null;
  return { ref, revision, checked };
}

export interface ScrollArgs {
  ref: string | null;
  revision: string;
  direction: "up" | "down" | "left" | "right";
  amount: "line" | "page";
}

export function validateScrollArgs(args: JsonValue): ScrollArgs | null {
  if (!isRecord(args)) return null;
  const { ref, revision, direction, amount, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (ref !== null && !isBoundedString(ref, MAX_REF_LEN)) return null;
  if (!isBoundedString(revision, MAX_REVISION_LEN)) return null;
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") return null;
  if (amount !== "line" && amount !== "page") return null;
  return { ref: ref === null ? null : ref, revision, direction, amount };
}

export interface NavigateArgs {
  url: string;
}

export function validateNavigateArgs(args: JsonValue): NavigateArgs | null {
  if (!isRecord(args)) return null;
  const { url, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (!isBoundedString(url, MAX_URL_LEN)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return { url };
}

export function validateGoBackArgs(args: JsonValue): Record<string, never> | null {
  if (!isRecord(args)) return null;
  if (Object.keys(args).length > 0) return null;
  return {};
}

export interface SnapshotArgs {
  mode: "readable" | "interactive";
}

export function validateSnapshotArgs(args: JsonValue): SnapshotArgs | null {
  if (!isRecord(args)) return null;
  const { mode, ...rest } = args;
  if (Object.keys(rest).length > 0) return null;
  if (mode !== "readable" && mode !== "interactive") return null;
  return { mode };
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
