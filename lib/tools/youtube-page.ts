import { isYouTubeRequest, normalizeYouTubeVideo, type YouTubeRequest, type YouTubeResult } from "../domain/youtube";
import type { JsonValue } from "../domain/tools";

const identities = new WeakMap<Document, string>();
const MAX_NODES = 20000;
const MAX_JSON = 1500000;

function text(node: Element | null, cap = 1000): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function field(value: unknown, cap: number): string {
  return typeof value === "string" ? value.slice(0, cap) : "";
}

function playerJson(nodes: Element[], id: string): Record<string, unknown> {
  let budget = MAX_JSON;
  for (const node of nodes) {
    if (node.tagName !== "SCRIPT") continue;
    const source = node.textContent ?? "";
    if (source.length > budget) continue;
    budget -= source.length;
    const match = /^(?:\s*)(?:var\s+ytInitialPlayerResponse\s*=|window\["ytInitialPlayerResponse"\]\s*=)\s*/.exec(source);
    if (!match) continue;
    const json = source.slice(match[0].length).trim().replace(/;\s*$/, "");
    try {
      const data = object(JSON.parse(json));
      if (object(data.videoDetails).videoId === id) return data;
    } catch {}
  }
  return {};
}

function seconds(node: Element): number | null {
  for (const name of ["data-start-ms", "start-ms", "data-start", "data-start-time"]) {
    const raw = node.getAttribute(name);
    if (raw !== null && /^\d+(?:\.\d+)?$/.test(raw)) {
      const value = Number(raw) / (name.endsWith("ms") ? 1000 : 1);
      if (value <= 604800) return value;
    }
  }
  const stamp = node.querySelector(".segment-timestamp, #segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp");
  const raw = text(stamp, 30);
  if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(raw)) return null;
  const parts = raw.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return null;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function result(data: JsonValue): YouTubeResult {
  if (JSON.stringify(data).length > 15000) return { status: "unavailable", message: "YouTube result exceeded the bounded output limit." };
  return { status: "ready", data };
}

export function readYouTubePage(doc: Document, request: YouTubeRequest): YouTubeResult {
  if (!isYouTubeRequest(request)) return { status: "blocked", message: "Invalid YouTube request." };
  let current: URL;
  try { current = new URL(doc.URL); } catch { return { status: "blocked", message: "Invalid document URL." }; }
  if (current.origin !== "https://www.youtube.com" || current.username || current.password) return { status: "blocked", message: "YouTube origin changed; consent or navigation may require the user." };
  const identity = request.operation === "search"
    ? `${current.origin}${current.pathname}?search_query=${encodeURIComponent(current.searchParams.get("search_query") ?? "")}`
    : normalizeYouTubeVideo(doc.URL);
  if (identity !== request.url || (identities.has(doc) && identities.get(doc) !== identity)) return { status: "blocked", message: "YouTube document changed. Open a fresh tab before reading." };
  identities.set(doc, identity);
  const nodes: Element[] = [];
  const walker = doc.createTreeWalker(doc.documentElement, 1);
  let next = walker.nextNode();
  while (next && nodes.length < MAX_NODES) { nodes.push(next as Element); next = walker.nextNode(); }
  if (next) return { status: "unavailable", message: "YouTube document exceeds the bounded DOM scan." };
  const find = (selector: string) => nodes.find((node) => node.matches(selector)) ?? null;
  if (find('ytd-consent-bump-v2-lightbox, ytd-enforcement-message-view-model, form[action*="consent.youtube"], iframe[src*="recaptcha"], #captcha-form')) {
    return { status: "blocked", message: "YouTube requires consent, sign-in, or challenge handling by the user." };
  }
  const id = new URL(request.url).searchParams.get("v")!;
  if (request.operation !== "search") {
    const watch = find("ytd-watch-flexy[video-id]");
    if (!watch || watch.getAttribute("video-id") !== id) return { status: "pending", message: "Waiting for the matching watch document." };
    const canonical = find('link[rel="canonical"]')?.getAttribute("href");
    if (canonical && normalizeYouTubeVideo(canonical) !== request.url) return { status: "pending", message: "Waiting for matching video canonical metadata." };
    if (find("ytd-player-error-message-renderer")) return { status: "unavailable", message: "YouTube reports this video cannot be played." };
  }
  if (request.operation === "metadata" || request.operation === "languages") {
    const player = playerJson(nodes, id);
    const details = object(player.videoDetails);
    if (!details.videoId) return { status: "unavailable", message: "Matching video metadata is not present in bounded document JSON." };
    if (request.operation === "metadata") return result({ videoId: id, url: request.url,
      title: field(details.title, 500), author: field(details.author, 200),
      description: field(details.shortDescription, 2000), descriptionTruncated: field(details.shortDescription, 2001).length > 2000,
      durationSeconds: /^\d{1,6}$/.test(field(details.lengthSeconds, 20)) ? Number(details.lengthSeconds) : null,
      viewCount: field(details.viewCount, 30), source: "document-json" });
    const tracks = object(object(player.captions).playerCaptionsTracklistRenderer).captionTracks;
    const languages = (Array.isArray(tracks) ? tracks.slice(0, 32) : []).map((track: unknown) => {
      const value = object(track);
      const name = object(value.name);
      const runs = Array.isArray(name.runs) ? name.runs.slice(0, 10).map((run) => field(object(run).text, 100)).join("") : "";
      return { code: field(value.languageCode, 40), name: field(name.simpleText ?? runs, 100), automatic: value.kind === "asr" };
    });
    return result({ videoId: id, languages, truncated: Array.isArray(tracks) && tracks.length > 32, source: "document-json" });
  }
  if (request.operation === "search") {
    const videos = nodes.filter((node) => node.matches("ytd-video-renderer")).slice(0, 200);
    if (!videos.length) return { status: "pending", message: "Waiting for rendered search results." };
    const items = videos.slice(request.offset, request.offset + request.limit).flatMap((node) => {
      const link = node.querySelector('a#video-title[href]');
      let url: string | null = null;
      try { url = normalizeYouTubeVideo(new URL(link?.getAttribute("href") ?? "", request.url).href); } catch {}
      return url ? [{ videoId: new URL(url).searchParams.get("v"), url, title: text(link, 500), channel: text(node.querySelector("ytd-channel-name"), 200), duration: text(node.querySelector("ytd-thumbnail-overlay-time-status-renderer"), 40) }] : [];
    });
    return result({ items, nextOffset: request.offset + request.limit < videos.length ? request.offset + request.limit : null, loadedOnly: true });
  }
  if (request.operation === "comments") {
    const threads = nodes.filter((node) => node.matches("ytd-comment-thread-renderer")).slice(0, 200);
    if (threads.length) {
      const items = threads.slice(request.offset, request.offset + request.limit).flatMap((node) => {
        const content = Array.from(node.querySelectorAll("#content-text")).find((element) => !element.closest("ytd-comment-replies-renderer")) ?? null;
        const author = Array.from(node.querySelectorAll("#author-text")).find((element) => !element.closest("ytd-comment-replies-renderer")) ?? null;
        return content ? [{ author: text(author, 100), text: text(content, 500), textTruncated: text(content, 501).length > 500 }] : [];
      });
      if (!items.length && request.offset < threads.length) return { status: "pending", message: "Waiting for top-level comment text." };
      return result({ items, nextOffset: request.offset + request.limit < threads.length ? request.offset + request.limit : null, loadedOnly: true, incomplete: true });
    }
    const comments = find("ytd-comments#comments, ytd-comments");
    if (request.action === "load-comments" && comments) {
      comments.scrollIntoView({ block: "start", behavior: "instant" });
      return { status: "pending", performed: "load-comments", message: "Waiting for the initial top-level comments." };
    }
    return { status: "pending", ...(comments ? { action: "load-comments" as const } : {}), message: "Initial comments are not loaded; disabled or unavailable comments may remain empty." };
  }
  const segments = nodes.filter((node) => node.matches("ytd-transcript-segment-renderer, transcript-segment-view-model"));
  if (segments.length) {
    const items: JsonValue[] = [];
    let chars = 0;
    let cursor = request.offset;
    for (; cursor < segments.length && items.length < request.limit; cursor++) {
      const node = segments[cursor]!;
      const start = seconds(node);
      const body = text(node.querySelector(".segment-text, #segment-text, .ytwTranscriptSegmentViewModelText"), 1000);
      if (!body) return { status: "pending", message: "Waiting for transcript segment text." };
      if (chars + body.length > 6000) break;
      chars += body.length;
      items.push({ startSeconds: start, text: body, textTruncated: text(node.querySelector(".segment-text, #segment-text, .ytwTranscriptSegmentViewModelText"), 1001).length > 1000 });
    }
    return result({ videoId: id, segments: items, nextOffset: cursor < segments.length ? cursor : null, loadedOnly: true });
  }
  const open = find('ytd-video-description-transcript-section-renderer button, ytd-video-description-transcript-section-renderer [role="button"]');
  const expand = find('ytd-watch-metadata #description-inline-expander #expand, ytd-text-inline-expander#description-inline-expander #expand');
  if (request.action === "open-transcript" && open) {
    (open as HTMLElement).click();
    return { status: "pending", performed: "open-transcript", message: "Waiting for timestamped transcript segments." };
  }
  if (request.action === "expand" && expand) {
    (expand as HTMLElement).click();
    return { status: "pending", performed: "expand", message: "Waiting for the description transcript control." };
  }
  if (open) return { status: "pending", action: "open-transcript", message: "Transcript panel is not loaded." };
  if (expand) return { status: "pending", action: "expand", message: "Description must be expanded." };
  return { status: "pending", message: "Transcript controls or segments are not available yet." };
}
