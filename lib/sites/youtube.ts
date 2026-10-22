import type { JsonValue } from "@/lib/domain/tools";
import { compact, fetchText, options, SiteError, type SiteApi, type SiteCallContext, type SiteEnv } from "./site-api";

const ORIGIN = "https://www.youtube.com";
// InnerTube client identities. When YouTube starts rejecting requests, bump these versions first.
const WEB_CLIENT = { clientName: "WEB", clientVersion: "2.20251020.00.00" };
// The web player withholds caption tracks without a proof-of-origin token; the Android client still lists them.
const ANDROID_CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, osName: "Android", osVersion: "14" };
/** The search filter for videos only. */
const VIDEOS_ONLY = "EgIQAQ%3D%3D";
const DEFAULT_TRANSCRIPT_CHARS = 20_000;
const MAX_TRANSCRIPT_CHARS = 40_000;
const MAX_PAGES = 5;

type Locale = { hl: string; gl: string };
type Client = "web" | "android";

function dig(value: unknown, ...path: (string | number)[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** InnerTube text: `{simpleText}` or `{runs: [{text}]}`. */
function text(value: unknown): string | undefined {
  return str(dig(value, "simpleText")) ?? str(list(dig(value, "runs")).map((run) => str(dig(run, "text")) ?? "").join(""));
}

/** Every value stored under `key`, in document order; matches are not searched further. */
function findAll(value: unknown, key: string, found: unknown[] = [], depth = 0): unknown[] {
  if (depth > 64 || !value || typeof value !== "object") return found;
  for (const [name, child] of Object.entries(value)) {
    if (name === key) found.push(child);
    else findAll(child, key, found, depth + 1);
  }
  return found;
}

const watchUrl = (videoId: string) => `${ORIGIN}/watch?v=${videoId}`;
const channelUrl = (path: string | undefined) => path ? new URL(path, ORIGIN).href : undefined;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** A video ID from a raw ID or a watch, Shorts, live, embed, or youtu.be URL. */
export function parseVideoId(input: JsonValue | undefined): string {
  if (typeof input !== "string") throw new SiteError("Expected a YouTube video ID or URL string.", "INVALID_TOOL_ARGUMENTS");
  const value = input.trim();
  if (VIDEO_ID.test(value)) return value;
  let candidate: string | null | undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.replace(/^(?:www|m|music)\./, "");
    if (host === "youtu.be") candidate = url.pathname.split("/")[1];
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      candidate = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|live|embed|v|e)\/([^/]+)/.exec(url.pathname)?.[1];
    }
  } catch { /* reported below */ }
  if (candidate && VIDEO_ID.test(candidate)) return candidate;
  throw new SiteError(`Not a YouTube video ID or URL: ${JSON.stringify(value.slice(0, 200))}.`, "INVALID_TOOL_ARGUMENTS");
}

function locale(opts: Record<string, JsonValue>): Locale {
  const hl = opts.lang ?? "en";
  const gl = opts.region ?? "US";
  if (typeof hl !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(hl)) throw new SiteError("lang must be a language code such as \"en\" or \"pt-BR\".", "INVALID_TOOL_ARGUMENTS");
  if (typeof gl !== "string" || !/^[A-Z]{2}$/.test(gl)) throw new SiteError("region must be a two-letter country code such as \"US\".", "INVALID_TOOL_ARGUMENTS");
  return { hl, gl };
}

function integer(value: JsonValue | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new SiteError(`${name} must be an integer from ${min} to ${max}.`, "INVALID_TOOL_ARGUMENTS");
  return value;
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * InnerTube treats a request as signed in only with a SAPISIDHASH header
 * derived from the user's SAPISID cookies; the cookies themselves ride along
 * with `credentials: "include"`. Null when the user is not signed in.
 */
async function authHeaders(env: SiteEnv): Promise<Record<string, string> | null> {
  const [sapisid, firstParty, thirdParty] = await Promise.all(["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"].map((name) => env.cookie(ORIGIN, name)));
  const primary = sapisid ?? thirdParty;
  if (!primary) return null;
  const seconds = Math.floor(env.now() / 1000);
  const hash = async (secret: string) => `${seconds}_${await sha1Hex(`${seconds} ${secret} ${ORIGIN}`)}`;
  const parts = [`SAPISIDHASH ${await hash(primary)}`];
  if (firstParty) parts.push(`SAPISID1PHASH ${await hash(firstParty)}`);
  if (thirdParty) parts.push(`SAPISID3PHASH ${await hash(thirdParty)}`);
  return { authorization: parts.join(" "), "x-origin": ORIGIN, "x-goog-authuser": "0" };
}

/** One InnerTube call. Web calls are signed in when the user is; a rejected signed-in call is retried anonymously once. */
async function innertube(env: SiteEnv, context: SiteCallContext, endpoint: "search" | "next" | "player", body: Record<string, JsonValue>, { hl, gl }: Locale, client: Client = "web"): Promise<unknown> {
  const label = `YouTube ${endpoint}`;
  const url = `${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`;
  const payload = JSON.stringify({ context: { client: { ...(client === "web" ? WEB_CLIENT : ANDROID_CLIENT), hl, gl } }, ...body });
  const auth = client === "web" ? await authHeaders(env) : null;
  const send = (signedIn: boolean) => fetchText(env, url, {
    method: "POST",
    credentials: client === "web" && signedIn ? "include" : "omit",
    headers: { "content-type": "application/json", ...(signedIn ? auth : null) },
    body: payload,
  }, context, label);
  let response = await send(true);
  if (auth && (response.status === 401 || response.status === 403)) response = await send(false);
  if (response.status < 200 || response.status >= 300) {
    throw new SiteError(`${label} failed (HTTP ${response.status}).${response.status === 429 ? " YouTube is rate-limiting requests; wait before retrying." : ""}`);
  }
  try { return JSON.parse(response.text); }
  catch { throw new SiteError(`${label} returned an unreadable response.`); }
}

function videoSummary(renderer: unknown): Record<string, JsonValue> | null {
  const videoId = str(dig(renderer, "videoId"));
  const title = text(dig(renderer, "title"));
  if (!videoId || !VIDEO_ID.test(videoId) || !title) return null;
  const owner = list(dig(renderer, "ownerText", "runs"))[0];
  const snippet = list(dig(renderer, "detailedMetadataSnippets"))[0];
  return compact({
    videoId,
    url: watchUrl(videoId),
    title,
    channelName: text(dig(renderer, "ownerText")),
    channelUrl: channelUrl(str(dig(owner, "navigationEndpoint", "browseEndpoint", "canonicalBaseUrl")) ?? str(dig(owner, "navigationEndpoint", "commandMetadata", "webCommandMetadata", "url"))),
    durationText: text(dig(renderer, "lengthText")),
    viewCountText: text(dig(renderer, "viewCountText")),
    publishedAtText: text(dig(renderer, "publishedTimeText")),
    snippet: text(dig(snippet, "snippetText")),
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  });
}

function lastContinuation(data: unknown): string | undefined {
  return findAll(data, "continuationItemRenderer").map((item) => str(dig(item, "continuationEndpoint", "continuationCommand", "token"))).filter(Boolean).at(-1);
}

async function search(env: SiteEnv, args: JsonValue[], context: SiteCallContext): Promise<JsonValue> {
  const [query, rawOptions] = args;
  if (typeof query !== "string" || !query.trim() || query.length > 400) throw new SiteError("youtube.search() expects a 1–400 character query.", "INVALID_TOOL_ARGUMENTS");
  const opts = options(rawOptions, ["limit", "lang", "region"], "youtube.search");
  const limit = integer(opts.limit, "limit", 10, 1, 50);
  const where = locale(opts);
  context.visit(`${ORIGIN}/results?search_query=${encodeURIComponent(query)}`);
  const results: JsonValue[] = [];
  const seen = new Set<string>();
  let data = await innertube(env, context, "search", { query, params: VIDEOS_ONLY }, where);
  for (let page = 1; ; page++) {
    for (const renderer of findAll(data, "videoRenderer")) {
      const summary = videoSummary(renderer);
      if (!summary || seen.has(summary.videoId as string)) continue;
      seen.add(summary.videoId as string);
      results.push(summary);
      if (results.length >= limit) return results;
    }
    const token = lastContinuation(data);
    if (!token || page >= MAX_PAGES) return results;
    data = await innertube(env, context, "search", { continuation: token }, where);
  }
}

function playable(data: unknown, videoId: string): void {
  if (dig(data, "videoDetails")) return;
  const reason = str(dig(data, "playabilityStatus", "reason")) ?? text(dig(data, "playabilityStatus", "errorScreen", "playerErrorMessageRenderer", "reason"));
  throw new SiteError(`YouTube video ${videoId} is unavailable${reason ? `: ${reason.replace(/\.$/, "")}` : ""}.`, "TARGET_MISSING");
}

async function getMetadata(env: SiteEnv, args: JsonValue[], context: SiteCallContext): Promise<JsonValue> {
  const videoId = parseVideoId(args[0]);
  const where = locale(options(args[1], ["lang", "region"], "youtube.getMetadata"));
  context.visit(watchUrl(videoId));
  const data = await innertube(env, context, "player", { videoId }, where);
  playable(data, videoId);
  const details = dig(data, "videoDetails");
  const micro = dig(data, "microformat", "playerMicroformatRenderer");
  const number = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
  const keywords = list(dig(details, "keywords")).filter((word): word is string => typeof word === "string").slice(0, 20);
  return compact({
    videoId,
    url: watchUrl(videoId),
    title: str(dig(details, "title")) ?? "",
    channelName: str(dig(details, "author")),
    channelId: str(dig(details, "channelId")),
    channelUrl: str(dig(micro, "ownerProfileUrl"))?.replace(/^http:/, "https:"),
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: number(dig(details, "lengthSeconds")),
    viewCount: number(dig(details, "viewCount")),
    description: str(dig(details, "shortDescription")),
    publishDate: str(dig(micro, "publishDate"))?.slice(0, 10),
    category: str(dig(micro, "category")),
    keywords: keywords.length ? keywords : undefined,
    isLiveContent: dig(details, "isLiveContent") === true,
    isLiveNow: dig(micro, "liveBroadcastDetails", "isLiveNow") === true ? true : undefined,
  });
}

interface CaptionTrack { baseUrl: string; languageCode: string; name: string; autoGenerated: boolean }

async function captionTracks(env: SiteEnv, context: SiteCallContext, videoId: string): Promise<{ tracks: CaptionTrack[]; defaultIndex: number | undefined }> {
  const data = await innertube(env, context, "player", { videoId }, { hl: "en", gl: "US" }, "android");
  playable(data, videoId);
  const renderer = dig(data, "captions", "playerCaptionsTracklistRenderer");
  const tracks = list(dig(renderer, "captionTracks")).flatMap((track): CaptionTrack[] => {
    const baseUrl = str(dig(track, "baseUrl"));
    const languageCode = str(dig(track, "languageCode"));
    // Caption files must come from the same origin as every other request.
    if (!baseUrl || !languageCode || !baseUrl.startsWith(`${ORIGIN}/api/timedtext?`)) return [];
    return [{ baseUrl, languageCode, name: text(dig(track, "name")) ?? languageCode, autoGenerated: dig(track, "kind") === "asr" }];
  });
  const defaultIndex = dig(renderer, "audioTracks", 0, "defaultCaptionTrackIndex");
  return { tracks, defaultIndex: typeof defaultIndex === "number" ? defaultIndex : undefined };
}

async function listTranscriptLanguages(env: SiteEnv, args: JsonValue[], context: SiteCallContext): Promise<JsonValue> {
  if (args.length !== 1) throw new SiteError("youtube.listTranscriptLanguages() takes one video ID or URL.", "INVALID_TOOL_ARGUMENTS");
  const videoId = parseVideoId(args[0]);
  context.visit(watchUrl(videoId));
  const { tracks } = await captionTracks(env, context, videoId);
  return tracks.map(({ languageCode, name, autoGenerated }) => ({ languageCode, name, autoGenerated }));
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const name = entity.toLowerCase();
    if (name[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[name]!;
    const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

/** Timed-text XML (`<text start dur>` seconds, or srv3 `<p t d>` milliseconds) as segments. Caption text is HTML-escaped inside XML. */
export function parseTimedText(xml: string): { start: number; end: number; text: string }[] {
  const segments: { start: number; end: number; text: string }[] = [];
  const clean = (raw: string) => decodeEntities(decodeEntities(raw).replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  for (const match of xml.matchAll(/<text\b[^>]*?\bstart="([\d.]+)"(?:[^>]*?\bdur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)) {
    const start = Number(match[1]);
    segments.push({ start, end: start + Number(match[2] ?? 0), text: clean(match[3]!) });
  }
  if (!segments.length) {
    for (const match of xml.matchAll(/<p\b[^>]*?\bt="(\d+)"(?:[^>]*?\bd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g)) {
      const start = Number(match[1]) / 1000;
      segments.push({ start, end: start + Number(match[2] ?? 0) / 1000, text: clean(match[3]!) });
    }
  }
  return segments.filter((segment) => segment.text);
}

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * The default track, or the best track in `lang` (exact code, then base
 * language), preferring human captions. YouTube's caption translation
 * (`tlang`) is refused to anonymous clients, so it is not offered.
 */
function chooseTrack(tracks: CaptionTrack[], defaultIndex: number | undefined, lang: string | undefined): CaptionTrack | undefined {
  const ranked = (match: (track: CaptionTrack) => boolean) => tracks.find((track) => match(track) && !track.autoGenerated) ?? tracks.find(match);
  if (!lang) return (defaultIndex === undefined ? undefined : tracks[defaultIndex]) ?? ranked(() => true);
  const base = lang.split("-")[0]!.toLowerCase();
  return ranked((track) => track.languageCode.toLowerCase() === lang.toLowerCase()) ??
    ranked((track) => track.languageCode.split("-")[0]!.toLowerCase() === base);
}

async function getTranscript(env: SiteEnv, args: JsonValue[], context: SiteCallContext): Promise<JsonValue> {
  const videoId = parseVideoId(args[0]);
  const opts = options(args[1], ["lang", "includeTimestamp", "offset", "maxChars"], "youtube.getTranscript");
  const lang = opts.lang;
  if (lang !== undefined && (typeof lang !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(lang))) throw new SiteError("lang must be a language code such as \"en\" or \"ko\".", "INVALID_TOOL_ARGUMENTS");
  if (opts.includeTimestamp !== undefined && typeof opts.includeTimestamp !== "boolean") throw new SiteError("includeTimestamp must be true or false.", "INVALID_TOOL_ARGUMENTS");
  const offset = integer(opts.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = integer(opts.maxChars, "maxChars", DEFAULT_TRANSCRIPT_CHARS, 500, MAX_TRANSCRIPT_CHARS);
  context.visit(watchUrl(videoId));
  const { tracks, defaultIndex } = await captionTracks(env, context, videoId);
  if (!tracks.length) throw new SiteError(`YouTube video ${videoId} has no transcript.`, "TARGET_MISSING");
  const chosen = chooseTrack(tracks, defaultIndex, lang as string | undefined);
  if (!chosen) throw new SiteError(`No ${lang} transcript for YouTube video ${videoId}. Available: ${[...new Set(tracks.map((track) => track.languageCode))].join(", ")}. Read one of those and translate it yourself.`, "TARGET_MISSING");
  const url = new URL(chosen.baseUrl);
  url.searchParams.delete("fmt");
  const response = await fetchText(env, url.href, { method: "GET", credentials: "omit" }, context, "YouTube captions");
  if (response.status < 200 || response.status >= 300) throw new SiteError(`YouTube captions failed (HTTP ${response.status}).`);
  const segments = parseTimedText(response.text);
  if (!segments.length) throw new SiteError(`YouTube returned an empty transcript for video ${videoId}.`, "TARGET_MISSING");
  const body = opts.includeTimestamp
    ? segments.map((segment) => `[${clock(segment.start)} - ${clock(segment.end)}] ${segment.text}`).join("\n")
    : segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").replace(/([.!?])\s+/g, "$1\n");
  if (offset >= body.length && offset > 0) return `[End of transcript: ${body.length} characters.]`;
  const end = Math.min(body.length, offset + maxChars);
  const continuation = { ...(lang ? { lang } : {}), ...(opts.includeTimestamp ? { includeTimestamp: true } : {}), offset: end };
  const rest = `{${Object.entries(continuation).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")}}`;
  return [
    `Transcript of ${watchUrl(videoId)} · ${chosen.name}`,
    body.slice(offset, end),
    ...(offset > 0 || end < body.length
      ? [end < body.length
        ? `[Transcript characters ${offset}–${end} of ${body.length}. Continue with youtube.getTranscript("${videoId}", ${rest}).]`
        : `[Transcript characters ${offset}–${end} of ${body.length}; end of transcript.]`]
      : []),
  ].join("\n");
}

function comment(payload: unknown, videoId: string): JsonValue {
  const properties = dig(payload, "properties");
  const author = dig(payload, "author");
  const toolbar = dig(payload, "toolbar");
  const commentId = str(dig(properties, "commentId"));
  const authorPath = str(dig(author, "channelCommand", "innertubeCommand", "browseEndpoint", "canonicalBaseUrl"));
  const channelId = str(dig(author, "channelId"));
  const replies = str(dig(toolbar, "replyCount"));
  return compact({
    url: commentId ? `${watchUrl(videoId)}&lc=${encodeURIComponent(commentId)}` : undefined,
    authorName: str(dig(author, "displayName")) ?? "",
    authorUrl: channelUrl(authorPath ?? (channelId ? `/channel/${channelId}` : undefined)),
    authorIsCreator: dig(author, "isCreator") === true ? true : undefined,
    text: str(dig(properties, "content", "content")) ?? "",
    publishedAtText: str(dig(properties, "publishedTime")),
    likeCountText: str(dig(toolbar, "likeCountNotliked")) ?? "0",
    replyCountText: replies && replies !== "0" ? `${replies} ${replies === "1" ? "reply" : "replies"}` : undefined,
  });
}

/** One page of a comments continuation: top-level comments in order, plus header details on the first page. */
function commentPage(data: unknown, videoId: string): { comments: JsonValue[]; next?: string; countText?: string; newest?: string } {
  const entities = new Map<string, unknown>();
  for (const mutation of list(dig(data, "frameworkUpdates", "entityBatchUpdate", "mutations"))) {
    const key = str(dig(mutation, "entityKey"));
    const payload = dig(mutation, "payload", "commentEntityPayload");
    if (key && payload) entities.set(key, payload);
  }
  const page: ReturnType<typeof commentPage> = { comments: [] };
  for (const endpoint of list(dig(data, "onResponseReceivedEndpoints"))) {
    const action = dig(endpoint, "reloadContinuationItemsCommand") ?? dig(endpoint, "appendContinuationItemsAction");
    for (const item of list(dig(action, "continuationItems"))) {
      const view = dig(item, "commentThreadRenderer", "commentViewModel", "commentViewModel");
      const header = dig(item, "commentsHeaderRenderer");
      const more = dig(item, "continuationItemRenderer");
      if (view) {
        const payload = entities.get(str(dig(view, "commentKey")) ?? "");
        if (payload && dig(payload, "properties", "replyLevel") !== 1) page.comments.push(comment(payload, videoId));
      } else if (header) {
        page.countText = text(dig(header, "countText"));
        page.newest = str(dig(header, "sortMenu", "sortFilterSubMenuRenderer", "subMenuItems", 1, "serviceEndpoint", "continuationCommand", "token"));
      } else if (more) {
        page.next = str(dig(more, "continuationEndpoint", "continuationCommand", "token")) ??
          str(dig(more, "button", "buttonRenderer", "command", "continuationCommand", "token"));
      }
    }
  }
  return page;
}

async function getComments(env: SiteEnv, args: JsonValue[], context: SiteCallContext): Promise<JsonValue> {
  const videoId = parseVideoId(args[0]);
  const opts = options(args[1], ["limit", "continuation", "sort", "lang", "region"], "youtube.getComments");
  const limit = integer(opts.limit, "limit", 20, 1, 100);
  const where = locale(opts);
  const { continuation, sort = "top" } = opts;
  if (continuation !== undefined && (typeof continuation !== "string" || !/^[A-Za-z0-9_%=-]{1,4000}$/.test(continuation))) throw new SiteError("continuation must be the token from a previous getComments() result.", "INVALID_TOOL_ARGUMENTS");
  if (sort !== "top" && sort !== "newest") throw new SiteError("sort must be \"top\" or \"newest\".", "INVALID_TOOL_ARGUMENTS");
  if (continuation !== undefined && opts.sort !== undefined) throw new SiteError("Pass either sort or continuation; a continuation keeps its original order.", "INVALID_TOOL_ARGUMENTS");
  context.visit(watchUrl(videoId));
  let token = continuation as string | undefined;
  if (!token) {
    const watch = await innertube(env, context, "next", { videoId }, where);
    const section = list(dig(watch, "contents", "twoColumnWatchNextResults", "results", "results", "contents"))
      .map((content) => dig(content, "itemSectionRenderer"))
      .find((renderer) => dig(renderer, "sectionIdentifier") === "comment-item-section");
    token = lastContinuation(section);
    if (!token) throw new SiteError(`Comments are turned off or unavailable for YouTube video ${videoId}.`, "TARGET_MISSING");
  }
  const comments: JsonValue[] = [];
  let countText: string | undefined;
  for (let page = 1; ; page++) {
    let result = commentPage(await innertube(env, context, "next", { continuation: token! }, where), videoId);
    if (sort === "newest" && !continuation && page === 1) {
      if (!result.newest) throw new SiteError("YouTube did not offer a newest-first order for these comments.", "TARGET_MISSING");
      countText = result.countText;
      result = commentPage(await innertube(env, context, "next", { continuation: result.newest }, where), videoId);
    }
    countText ??= result.countText;
    comments.push(...result.comments.slice(0, limit - comments.length));
    token = result.next;
    if (!token || comments.length >= limit || page >= MAX_PAGES) break;
  }
  return compact({ videoId, commentCountText: countText, comments, hasMore: Boolean(token), continuation: token });
}

export const youtube: SiteApi = {
  name: "youtube",
  origin: ORIGIN,
  methods: { search, getMetadata, listTranscriptLanguages, getTranscript, getComments },
};
