import type { JsonValue } from "./tools";

export type YouTubeOperation = "search" | "metadata" | "languages" | "transcript" | "comments";
export type YouTubeAction = "read" | "expand" | "open-transcript" | "load-comments";
export interface YouTubeRequest {
  operation: YouTubeOperation;
  url: string;
  offset: number;
  limit: number;
  action: YouTubeAction;
}
export interface YouTubeResult {
  status: "ready" | "pending" | "unavailable" | "blocked";
  data?: JsonValue;
  message?: string;
  action?: Exclude<YouTubeAction, "read">;
  performed?: Exclude<YouTubeAction, "read">;
}

export function normalizeYouTubeVideo(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 2048) return null;
  if (/^[\w-]{11}$/.test(input)) return `https://www.youtube.com/watch?v=${input}`;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let id: string | null = null;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    if (url.hostname === "www.youtube.com" || url.hostname === "youtube.com") {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else id = /^\/(?:shorts|embed|live)\/([\w-]{11})$/.exec(url.pathname)?.[1] ?? null;
    }
    return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch { return null; }
}

export function isYouTubeRequest(value: unknown): value is YouTubeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["operation", "url", "offset", "limit", "action"].includes(key))) return false;
  if (typeof v.operation !== "string" || typeof v.action !== "string" ||
      !["search", "metadata", "languages", "transcript", "comments"].includes(v.operation) ||
      !["read", "expand", "open-transcript", "load-comments"].includes(v.action)) return false;
  if (!Number.isInteger(v.offset) || (v.offset as number) < 0 || (v.offset as number) > 10000 ||
      !Number.isInteger(v.limit) || (v.limit as number) < 1) return false;
  const cap = v.operation === "search" ? 10 : v.operation === "comments" ? 20 : 100;
  if ((v.limit as number) > cap || typeof v.url !== "string" || v.url.length > (v.operation === "search" ? 4096 : 2048)) return false;
  if (v.action !== "read" && !(v.operation === "transcript" && ["expand", "open-transcript"].includes(String(v.action))) &&
      !(v.operation === "comments" && v.action === "load-comments")) return false;
  if (v.operation !== "search") return normalizeYouTubeVideo(v.url) === v.url;
  try {
    const url = new URL(v.url);
    const query = url.searchParams.get("search_query");
    return url.origin === "https://www.youtube.com" && !url.username && !url.password && url.pathname === "/results" &&
      !!query?.trim() && query.length <= 400 && v.url === `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  } catch { return false; }
}

export function isYouTubeResult(value: unknown): value is YouTubeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["status", "data", "message", "action", "performed"].includes(key)) ||
      typeof v.status !== "string" || !["ready", "pending", "unavailable", "blocked"].includes(v.status)) return false;
  if (v.message !== undefined && (typeof v.message !== "string" || v.message.length > 500)) return false;
  if (v.status === "ready" ? v.data === undefined : typeof v.message !== "string") return false;
  if (v.action !== undefined && (v.status !== "pending" || typeof v.action !== "string" || !["expand", "open-transcript", "load-comments"].includes(v.action))) return false;
  if (v.performed !== undefined && (v.status !== "pending" || typeof v.performed !== "string" || !["expand", "open-transcript", "load-comments"].includes(v.performed))) return false;
  let remaining = 16000;
  const seen = new Set<object>();
  function valid(item: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 20) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") { remaining -= item.length; return remaining >= 0; }
    if (!item || typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    return Object.entries(item).every(([key, entry]) => { remaining -= key.length; return remaining >= 0 && valid(entry, depth + 1); });
  }
  try { return valid(value, 0) && JSON.stringify(value).length <= 16000; } catch { return false; }
}
