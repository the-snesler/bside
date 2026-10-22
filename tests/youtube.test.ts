import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@/lib/domain/tools";
import { registerSiteRequestHeaders, type SiteRequestApi } from "@/lib/sites";
import { SiteError, type SiteEnv } from "@/lib/sites/site-api";
import { parseTimedText, parseVideoId, youtube } from "@/lib/sites/youtube";

const ID = "hS1YqcewH0c";
const NOW = 1_700_000_000_000;
type Call = { url: string; init: RequestInit; body: Record<string, any> | null };

/** A fake YouTube backend: `route` answers each request with JSON, text, or a Response. */
function backend(route: (call: Call) => unknown, cookies: Record<string, string> = {}) {
  const calls: Call[] = [];
  const env: SiteEnv = {
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
      calls.push(call);
      const answer = route(call);
      return answer instanceof Response ? answer : new Response(typeof answer === "string" ? answer : JSON.stringify(answer));
    }),
    cookie: vi.fn(async (_url: string, name: string) => cookies[name] ?? null),
    now: () => NOW,
  };
  const visited: string[] = [];
  const call = (method: string, ...args: JsonValue[]) => youtube.methods[method]!(env, args, { signal: new AbortController().signal, visit: (url) => visited.push(url) });
  return { env, calls, visited, call };
}

const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

// Shapes below mirror live InnerTube responses (October 2026), trimmed to the fields read.
const video = (videoId: string, title: string) => ({ videoRenderer: {
  videoId, title: { runs: [{ text: title }] },
  ownerText: { runs: [{ text: "OpenAI", navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: "/@OpenAI" } } }] },
  lengthText: { simpleText: "53:35" }, viewCountText: { simpleText: "683,466 views" }, publishedTimeText: { simpleText: "Streamed 3 weeks ago" },
  detailedMetadataSnippets: [{ snippetText: { runs: [{ text: "Watch the " }, { text: "DevDay", bold: true }, { text: " keynote" }] } }],
  thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/x/hq720.jpg?sqp=token" }] },
} });
const more = (token: string) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
const searchPage = (videos: unknown[], token?: string) => ({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: {
  contents: [{ itemSectionRenderer: { contents: videos } }, ...(token ? [more(token)] : [])],
} } } } });
const searchContinuation = (videos: unknown[], token?: string) => ({ onResponseReceivedCommands: [{ appendContinuationItemsAction: {
  continuationItems: [{ itemSectionRenderer: { contents: videos } }, ...(token ? [more(token)] : [])],
} }] });

const webPlayer = {
  playabilityStatus: { status: "UNPLAYABLE", reason: "Video unavailable" },
  videoDetails: { videoId: ID, title: "OpenAI DevDay 2025: Opening Keynote", lengthSeconds: "3159", channelId: "UCXZ", viewCount: "807396", author: "OpenAI", shortDescription: "Keynote.", isLiveContent: true, keywords: ["openai", "devday"] },
  microformat: { playerMicroformatRenderer: { publishDate: "2025-10-06T11:27:04-07:00", category: "Science & Technology", ownerProfileUrl: "http://www.youtube.com/@OpenAI", liveBroadcastDetails: { isLiveNow: false } } },
};
const track = (languageCode: string, name: string, asr = false, origin = "https://www.youtube.com") => ({
  baseUrl: `${origin}/api/timedtext?v=${ID}&lang=${languageCode}${asr ? "&kind=asr" : ""}&fmt=srv3`,
  languageCode, name: { runs: [{ text: name }] }, ...(asr ? { kind: "asr" } : {}), isTranslatable: true,
});
const androidPlayer = (tracks: unknown[], defaultIndex?: number) => ({
  playabilityStatus: { status: "OK" }, videoDetails: { videoId: ID, title: "Keynote" },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks, ...(defaultIndex === undefined ? {} : { audioTracks: [{ defaultCaptionTrackIndex: defaultIndex }] }) } },
});
const TIMED_TEXT = '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="3.2">Hello there&amp;#39;s a &amp;lt;3 moment.</text>'
  + '<text start="3.7" dur="2">Second\nline</text><text start="3725" dur="4"><font color="#fff">Late</font> words!</text></transcript>';

const watchNext = (token: string | null) => ({ contents: { twoColumnWatchNextResults: { results: { results: { contents: [
  { videoPrimaryInfoRenderer: {} },
  { itemSectionRenderer: { sectionIdentifier: "comment-item-section", contents: token ? [more(token)] : [] } },
] } } } } });
function commentsPage(ids: string[], next?: string, withHeader = false) {
  const thread = (id: string) => ({ commentThreadRenderer: { commentViewModel: { commentViewModel: { commentKey: `key-${id}`, commentId: id } } } });
  return {
    onResponseReceivedEndpoints: [
      ...(withHeader ? [{ reloadContinuationItemsCommand: { slot: "RELOAD_CONTINUATION_SLOT_HEADER", continuationItems: [{ commentsHeaderRenderer: {
        countText: { runs: [{ text: "956" }, { text: " Comments" }] },
        sortMenu: { sortFilterSubMenuRenderer: { subMenuItems: [{ title: "Top", serviceEndpoint: { continuationCommand: { token: "TOP" } } }, { title: "Newest", serviceEndpoint: { continuationCommand: { token: "NEWEST" } } }] } },
      } }] } }] : []),
      { [withHeader ? "reloadContinuationItemsCommand" : "appendContinuationItemsAction"]: { continuationItems: [...ids.map(thread), ...(next ? [more(next)] : [])] } },
    ],
    frameworkUpdates: { entityBatchUpdate: { mutations: ids.map((id) => ({ entityKey: `key-${id}`, payload: { commentEntityPayload: {
      properties: { commentId: id, content: { content: `Comment ${id}` }, publishedTime: "3 weeks ago", replyLevel: 0 },
      author: { displayName: `@user-${id}`, channelId: "UCuser", isCreator: id === "c1", channelCommand: { innertubeCommand: { browseEndpoint: { canonicalBaseUrl: `/@user-${id}` } } } },
      toolbar: { likeCountNotliked: "11", replyCount: id === "c1" ? "3" : "" },
    } } })) } },
  };
}

async function sha1(input: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("YouTube video references", () => {
  it.each([
    ID, ` ${ID} `, `https://www.youtube.com/watch?v=${ID}&t=42s`, `youtube.com/watch?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`, `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}?si=x`,
    `https://www.youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`, `https://youtu.be/${ID}?t=10`,
  ])("accepts %s", (input) => {
    expect(parseVideoId(input)).toBe(ID);
  });

  it.each(["", "short", `https://evil.example/watch?v=${ID}`, `https://www.youtube.com/@OpenAI`, `https://www.youtube.com/watch?v=${ID}x`, "javascript:alert(1)"])("rejects %j", (input) => {
    expect(() => parseVideoId(input)).toThrow(SiteError);
  });
});

describe("YouTube search", () => {
  it("posts a videos-only InnerTube search and returns compact summaries", async () => {
    const { call, calls, visited } = backend(() => searchPage([video(ID, "Keynote"), video("Fls_onRviPM", "Recap")]));
    const results = await call("search", "OpenAI DevDay", { limit: 5, lang: "ko", region: "KR" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://www.youtube.com/youtubei/v1/search?prettyPrint=false");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "include" });
    expect(calls[0]!.body).toEqual({ context: { client: { clientName: "WEB", clientVersion: expect.any(String), hl: "ko", gl: "KR" } }, query: "OpenAI DevDay", params: "EgIQAQ%3D%3D" });
    expect(results).toEqual([
      {
        videoId: ID, url: `https://www.youtube.com/watch?v=${ID}`, title: "Keynote", channelName: "OpenAI", channelUrl: "https://www.youtube.com/@OpenAI",
        durationText: "53:35", viewCountText: "683,466 views", publishedAtText: "Streamed 3 weeks ago", snippet: "Watch the DevDay keynote",
        thumbnailUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
      },
      expect.objectContaining({ videoId: "Fls_onRviPM", title: "Recap" }),
    ]);
    expect(visited).toEqual(["https://www.youtube.com/results?search_query=OpenAI%20DevDay"]);
  });

  it("follows continuations up to the limit and drops duplicates", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `video${String(i).padStart(6, "0")}`);
    const { call, calls } = backend(({ body }) => body!.continuation === "PAGE2"
      ? searchContinuation(ids.slice(5).map((id) => video(id, id)), "PAGE3")
      : searchPage([...ids.slice(0, 5), ids[0]!].map((id) => video(id, id)), "PAGE2"));
    const results = await call("search", "q", { limit: 8 }) as { videoId: string }[];
    expect(results.map((result) => result.videoId)).toEqual(ids.slice(0, 8));
    expect(calls.map((request) => request.body!.continuation ?? null)).toEqual([null, "PAGE2"]);
  });

  it("validates arguments before any request", async () => {
    const { call, calls } = backend(() => searchPage([]));
    for (const args of [[""], ["q", { limit: 0 }], ["q", { limit: 51 }], ["q", { region: "usa" }], ["q", { lang: "english" }], ["q", { page: 2 }], ["q", "opts"]] as JsonValue[][]) {
      await expect(call("search", ...args)).rejects.toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
    }
    expect(calls).toHaveLength(0);
  });

  it("reports HTTP failures without the response body", async () => {
    const { call } = backend(() => new Response("secret upstream detail", { status: 429 }));
    const error = await call("search", "q").catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(SiteError);
    expect((error as Error).message).toBe("YouTube search failed (HTTP 429). YouTube is rate-limiting requests; wait before retrying.");
  });
});

describe("YouTube sign-in", () => {
  it("signs web requests with SAPISIDHASH headers derived from the user's cookies", async () => {
    const { call, calls, env } = backend(() => searchPage([]), { SAPISID: "sap", "__Secure-1PAPISID": "one", "__Secure-3PAPISID": "three" });
    await call("search", "q");
    const seconds = NOW / 1000;
    const hash = async (secret: string) => `${seconds}_${await sha1(`${seconds} ${secret} https://www.youtube.com`)}`;
    expect(header(calls[0]!, "authorization")).toBe(`SAPISIDHASH ${await hash("sap")} SAPISID1PHASH ${await hash("one")} SAPISID3PHASH ${await hash("three")}`);
    expect(header(calls[0]!, "x-origin")).toBe("https://www.youtube.com");
    expect(env.cookie).toHaveBeenCalledWith("https://www.youtube.com", "SAPISID");
  });

  it("sends no authorization when signed out, and retries a rejected signed-in request anonymously", async () => {
    const signedOut = backend(() => searchPage([]));
    await signedOut.call("search", "q");
    expect(header(signedOut.calls[0]!, "authorization")).toBeUndefined();

    const rejected = backend((request) => header(request, "authorization") ? new Response("", { status: 401 }) : searchPage([video(ID, "Public")]), { SAPISID: "stale" });
    expect(await rejected.call("search", "q")).toEqual([expect.objectContaining({ title: "Public" })]);
    expect(rejected.calls.map((request) => [request.init.credentials, Boolean(header(request, "authorization"))])).toEqual([["include", true], ["omit", false]]);
  });
});

describe("YouTube metadata", () => {
  it("reads details from the web player even when playback itself is refused", async () => {
    const { call, calls, visited } = backend(() => webPlayer);
    expect(await call("getMetadata", `https://youtu.be/${ID}`)).toEqual({
      videoId: ID, url: `https://www.youtube.com/watch?v=${ID}`, title: "OpenAI DevDay 2025: Opening Keynote", channelName: "OpenAI", channelId: "UCXZ",
      channelUrl: "https://www.youtube.com/@OpenAI", thumbnailUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, durationSeconds: 3159, viewCount: 807396,
      description: "Keynote.", publishDate: "2025-10-06", category: "Science & Technology", keywords: ["openai", "devday"], isLiveContent: true,
    });
    expect(calls[0]!.url).toContain("/youtubei/v1/player");
    expect(calls[0]!.body).toMatchObject({ videoId: ID, context: { client: { clientName: "WEB" } } });
    expect(visited).toEqual([`https://www.youtube.com/watch?v=${ID}`]);
  });

  it("reports an unavailable video with YouTube's reason", async () => {
    const { call } = backend(() => ({ playabilityStatus: { status: "ERROR", reason: "This video is private." } }));
    await expect(call("getMetadata", ID)).rejects.toMatchObject({ code: "TARGET_MISSING", message: `YouTube video ${ID} is unavailable: This video is private.` });
  });
});

describe("YouTube transcripts", () => {
  const tracks = [track("en", "English"), track("en", "English (auto-generated)", true), track("ko", "Korean")];

  it("lists caption tracks from the Android player without credentials", async () => {
    const { call, calls } = backend(() => androidPlayer(tracks, 0));
    expect(await call("listTranscriptLanguages", ID)).toEqual([
      { languageCode: "en", name: "English", autoGenerated: false },
      { languageCode: "en", name: "English (auto-generated)", autoGenerated: true },
      { languageCode: "ko", name: "Korean", autoGenerated: false },
    ]);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(header(calls[0]!, "authorization")).toBeUndefined();
    expect(calls[0]!.body!.context.client.clientName).toBe("ANDROID");
  });

  it("fetches the default track as plain text, decoding escaped caption markup", async () => {
    const { call, calls } = backend(({ url }) => url.includes("/api/timedtext") ? TIMED_TEXT : androidPlayer(tracks, 0));
    expect(await call("getTranscript", ID)).toBe(`Transcript of https://www.youtube.com/watch?v=${ID} · English\nHello there's a <3 moment.\nSecond line Late words!`);
    const captions = new URL(calls[1]!.url);
    expect(captions.origin + captions.pathname).toBe("https://www.youtube.com/api/timedtext");
    expect(captions.searchParams.get("lang")).toBe("en");
    expect(captions.searchParams.has("fmt")).toBe(false);
    expect(calls[1]!.init).toMatchObject({ method: "GET", credentials: "omit" });
  });

  it("formats timestamps and picks requested languages, preferring human captions", async () => {
    const { call, calls } = backend(({ url }) => url.includes("/api/timedtext") ? TIMED_TEXT : androidPlayer(tracks, 0));
    const stamped = await call("getTranscript", ID, { includeTimestamp: true, lang: "en-US" }) as string;
    expect(stamped.split("\n").slice(1)).toEqual(["[00:00 - 00:03] Hello there's a <3 moment.", "[00:03 - 00:05] Second line", "[1:02:05 - 1:02:09] Late words!"]);
    expect(new URL(calls[1]!.url).searchParams.get("kind")).toBeNull();
    await call("getTranscript", ID, { lang: "ko" });
    expect(new URL(calls[3]!.url).searchParams.get("lang")).toBe("ko");
    await expect(call("getTranscript", ID, { lang: "fr" })).rejects.toThrow("No fr transcript for YouTube video hS1YqcewH0c. Available: en, ko.");
    expect(calls).toHaveLength(5);
  });

  it("pages long transcripts and states exactly how to continue", async () => {
    const long = `<transcript>${Array.from({ length: 300 }, (_, i) => `<text start="${i}" dur="1">Sentence number ${i}.</text>`).join("")}</transcript>`;
    const { call } = backend(({ url }) => url.includes("/api/timedtext") ? long : androidPlayer(tracks, 0));
    const first = await call("getTranscript", ID, { maxChars: 1000, lang: "ko" }) as string;
    expect(first).toMatch(/\[Transcript characters 0–1000 of \d+\. Continue with youtube\.getTranscript\("hS1YqcewH0c", \{lang: "ko", offset: 1000\}\)\.\]$/);
    const last = await call("getTranscript", ID, { offset: 5000, maxChars: 40_000 }) as string;
    expect(last).toMatch(/; end of transcript\.\]$/);
    expect(await call("getTranscript", ID, { offset: 1_000_000 })).toMatch(/^\[End of transcript: \d+ characters\.\]$/);
  });

  it("refuses caption URLs on other origins and explains missing transcripts", async () => {
    const offOrigin = backend(() => androidPlayer([track("en", "English", false, "https://evil.example")]));
    await expect(offOrigin.call("getTranscript", ID)).rejects.toMatchObject({ code: "TARGET_MISSING", message: `YouTube video ${ID} has no transcript.` });
    expect(offOrigin.calls).toHaveLength(1);
  });

  it("parses srv3 timed text as a fallback", () => {
    expect(parseTimedText('<timedtext><body><p t="1500" d="2000"><s>Hi</s><s> there</s></p></body></timedtext>')).toEqual([{ start: 1.5, end: 3.5, text: "Hi there" }]);
  });
});

describe("YouTube comments", () => {
  it("opens the comment section from the watch page and maps comment entities", async () => {
    const { call, calls } = backend(({ body }) => body!.continuation === "SECTION" ? commentsPage(["c1", "c2"], "NEXT", true) : watchNext("SECTION"));
    expect(await call("getComments", ID, { limit: 2 })).toEqual({
      videoId: ID, commentCountText: "956 Comments", hasMore: true, continuation: "NEXT",
      comments: [
        { url: `https://www.youtube.com/watch?v=${ID}&lc=c1`, authorName: "@user-c1", authorUrl: "https://www.youtube.com/@user-c1", authorIsCreator: true, text: "Comment c1", publishedAtText: "3 weeks ago", likeCountText: "11", replyCountText: "3 replies" },
        expect.objectContaining({ text: "Comment c2", authorName: "@user-c2" }),
      ],
    });
    expect(calls.map((request) => request.body!.continuation ?? request.body!.videoId)).toEqual([ID, "SECTION"]);
  });

  it("stops at the limit, resumes from a continuation, and supports newest-first", async () => {
    const pages: Record<string, unknown> = {
      SECTION: commentsPage(["c1", "c2"], "P2", true), P2: commentsPage(["c3", "c4"], "P3"), P3: commentsPage(["c5"]),
      NEWEST: commentsPage(["n1"], undefined, true),
    };
    const { call, calls } = backend(({ body }) => body!.continuation ? pages[body!.continuation] : watchNext("SECTION"));
    const limited = await call("getComments", ID, { limit: 3 }) as { comments: { text: string }[]; continuation: string };
    expect(limited.comments.map((item) => item.text)).toEqual(["Comment c1", "Comment c2", "Comment c3"]);
    expect(limited.continuation).toBe("P3");
    const resumed = await call("getComments", ID, { continuation: "P3" });
    expect(resumed).toEqual({ videoId: ID, comments: [expect.objectContaining({ text: "Comment c5" })], hasMore: false });
    calls.length = 0;
    const newest = await call("getComments", ID, { sort: "newest" }) as { comments: { text: string }[]; commentCountText: string };
    expect(newest.comments.map((item) => item.text)).toEqual(["Comment n1"]);
    expect(newest.commentCountText).toBe("956 Comments");
    expect(calls.map((request) => request.body!.continuation ?? null)).toEqual([null, "SECTION", "NEWEST"]);
  });

  it("explains disabled comments and validates continuation tokens", async () => {
    const { call } = backend(() => watchNext(null));
    await expect(call("getComments", ID)).rejects.toMatchObject({ code: "TARGET_MISSING", message: `Comments are turned off or unavailable for YouTube video ${ID}.` });
    await expect(call("getComments", ID, { continuation: "bad token!" })).rejects.toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
    await expect(call("getComments", ID, { continuation: "P2", sort: "newest" })).rejects.toMatchObject({ code: "INVALID_TOOL_ARGUMENTS" });
  });
});

describe("site request headers", () => {
  it("presents the site's origin only for this extension's background requests", () => {
    let listener!: Parameters<SiteRequestApi["webRequest"]["onBeforeSendHeaders"]["addListener"]>[0];
    const addListener = vi.fn((registered: typeof listener) => { listener = registered; });
    registerSiteRequestHeaders({ runtime: { getURL: () => "moz-extension://abc/" }, webRequest: { onBeforeSendHeaders: { addListener } } });
    expect(addListener).toHaveBeenCalledWith(expect.any(Function), { urls: ["https://www.youtube.com/*"], types: ["xmlhttprequest"] }, ["blocking", "requestHeaders"]);
    const ours = [{ name: "Origin", value: "moz-extension://abc" }, { name: "Referer", value: "moz-extension://abc/background.html" }, { name: "Accept", value: "*/*" }];
    expect(listener({ tabId: -1, requestHeaders: ours })).toEqual({ requestHeaders: [{ name: "Origin", value: "https://www.youtube.com" }, { name: "Accept", value: "*/*" }] });
    expect(listener({ tabId: 7, requestHeaders: ours })).toEqual({});
    expect(listener({ tabId: -1, requestHeaders: [{ name: "Origin", value: "moz-extension://other" }] })).toEqual({});
  });
});
