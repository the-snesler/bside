// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { isYouTubeRequest, isYouTubeResult, normalizeYouTubeVideo, type YouTubeRequest } from "@/lib/domain/youtube";
import { readYouTubePage } from "@/lib/tools/youtube-page";

const id = "jNQXAC9IVRw";
const url = `https://www.youtube.com/watch?v=${id}`;
function page(body = "", location = url): Document {
  const window = new Window({ url: location });
  window.document.body.innerHTML = `<ytd-watch-flexy video-id="${id}">${body}</ytd-watch-flexy>`;
  return window.document as unknown as Document;
}
function req(operation: YouTubeRequest["operation"], extras: Partial<YouTubeRequest> = {}): YouTubeRequest {
  return { operation, url, action: "read", offset: 0, limit: 10, ...extras };
}
function initial(videoId = id): string {
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { videoId, title: "A video", author: "Channel", shortDescription: "Description", lengthSeconds: "19" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "en", kind: "asr", name: { simpleText: "English" }, baseUrl: "https://secret.invalid/caption" }] } } })};</script>`;
}
function segment(stamp: string, body: string, attrs = ""): string {
  return `<ytd-transcript-segment-renderer ${attrs}><div class="segment-timestamp" aria-label="1 second">${stamp}</div><div class="segment-text">${body}</div></ytd-transcript-segment-renderer>`;
}

describe("YouTube request boundary", () => {
  it("validates result envelopes and rejects cyclic, non-JSON and oversized data", () => {
    expect(isYouTubeResult({ status: "ready", data: { items: [], loadedOnly: true } })).toBe(true);
    expect(isYouTubeResult({ status: "pending", message: "Waiting", action: "expand" })).toBe(true);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const data of [cycle, { value: Infinity }, { value: new Date() }, { value: "x".repeat(16000) }, { value: undefined }]) expect(isYouTubeResult({ status: "ready", data })).toBe(false);
    expect(isYouTubeResult({ status: "ready" })).toBe(false);
    expect(isYouTubeResult({ status: "pending", message: "Waiting", action: "click" })).toBe(false);
  });
  it("normalizes IDs and supported video URLs without retaining tracking parameters", () => {
    for (const value of [id, url, `https://youtu.be/${id}?t=1`, `https://youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`]) expect(normalizeYouTubeVideo(value)).toBe(url);
    for (const value of ["bad", "http://www.youtube.com/watch?v=" + id, `https://www.youtube.com.evil/watch?v=${id}`, `https://user@www.youtube.com/watch?v=${id}`, `https://www.youtube.com:444/watch?v=${id}`]) expect(normalizeYouTubeVideo(value)).toBeNull();
  });
  it("rejects unknown fields, noncanonical URLs, actions and excessive bounds", () => {
    expect(isYouTubeRequest(req("metadata"))).toBe(true);
    for (const invalid of [{ selector: "button" }, { limit: 101 }, { offset: -1 }, { offset: 1.1 }, { url: `${url}&t=1` }, { action: "expand" }, { operation: "fetch" }]) expect(isYouTubeRequest({ ...req("metadata"), ...invalid })).toBe(false);
    expect(isYouTubeRequest(req("comments", { limit: 21 }))).toBe(false);
    expect(isYouTubeRequest(req("search", { url: "https://www.youtube.com/results?search_query=two%20words" }))).toBe(true);
    expect(isYouTubeRequest(req("search", { url: "https://www.youtube.com/results?search_query=two+words" }))).toBe(false);
    expect(isYouTubeRequest(req("search", { url: `https://www.youtube.com/results?search_query=${encodeURIComponent("映".repeat(400))}` }))).toBe(true);
  });
});

describe("bounded synchronous YouTube reader (synthetic DOM fixtures)", () => {
  it("reads matching pure JSON metadata and languages without leaking caption URLs", () => {
    const doc = page(initial());
    expect(readYouTubePage(doc, req("metadata"))).toMatchObject({ status: "ready", data: { title: "A video", durationSeconds: 19 } });
    const result = readYouTubePage(doc, req("languages"));
    expect(result).toMatchObject({ status: "ready", data: { languages: [{ code: "en", name: "English", automatic: true }] } });
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });
  it("never executes expressions or accepts another video's stale script", () => {
    expect(readYouTubePage(page(initial("AAAAAAAAAAA")), req("metadata")).status).toBe("unavailable");
    expect(readYouTubePage(page('<script>var ytInitialPlayerResponse = (() => { throw 1 })();</script>'), req("metadata")).status).toBe("unavailable");
    expect(readYouTubePage(page(`<script>var ytInitialPlayerResponse = ${" ".repeat(1500001)}</script>`), req("metadata")).status).toBe("unavailable");
  });
  it("checks the origin, current video and canonical DOM identity before effects", () => {
    expect(readYouTubePage(page("", "https://consent.youtube.com/"), req("transcript")).status).toBe("blocked");
    const doc = page(initial());
    doc.querySelector("ytd-watch-flexy")!.setAttribute("video-id", "AAAAAAAAAAA");
    expect(readYouTubePage(doc, req("metadata")).status).toBe("pending");
    const stale = page(`<link rel="canonical" href="https://www.youtube.com/watch?v=AAAAAAAAAAA">${initial()}`);
    expect(readYouTubePage(stale, req("metadata")).status).toBe("pending");
  });
  it("blocks challenges before clicking any description control", () => {
    const doc = page('<iframe src="https://www.google.com/recaptcha/api"></iframe><ytd-watch-metadata><div id="description-inline-expander"><button id="expand">…more</button></div></ytd-watch-metadata>');
    const click = vi.fn();
    doc.querySelector("button")!.addEventListener("click", click);
    expect(readYouTubePage(doc, req("transcript", { action: "expand" })).status).toBe("blocked");
    expect(click).not.toHaveBeenCalled();
  });
  it("refuses reuse of an observed document after SPA navigation", () => {
    const doc = page(initial());
    expect(readYouTubePage(doc, req("metadata")).status).toBe("ready");
    const next = "https://www.youtube.com/watch?v=AAAAAAAAAAA";
    doc.defaultView!.history.pushState({}, "", next);
    doc.querySelector("ytd-watch-flexy")!.setAttribute("video-id", "AAAAAAAAAAA");
    expect(readYouTubePage(doc, req("metadata", { url: next })).status).toBe("blocked");
  });
  it("stages description and transcript actions without English-label or timestamp waits", () => {
    const doc = page('<ytd-watch-metadata><div id="description-inline-expander"><button id="expand">…more</button></div></ytd-watch-metadata>');
    const expand = vi.fn(() => {
      doc.body.insertAdjacentHTML("beforeend", '<ytd-video-description-transcript-section-renderer><button>Transkript anzeigen</button></ytd-video-description-transcript-section-renderer>');
    });
    doc.querySelector("button")!.addEventListener("click", expand);
    expect(readYouTubePage(doc, req("transcript"))).toMatchObject({ status: "pending", action: "expand" });
    expect(expand).not.toHaveBeenCalled();
    readYouTubePage(doc, req("transcript", { action: "expand" }));
    expect(expand).toHaveBeenCalledTimes(1);
    expect(readYouTubePage(doc, req("transcript"))).toMatchObject({ status: "pending", action: "open-transcript" });
    doc.querySelector("ytd-video-description-transcript-section-renderer button")!.addEventListener("click", () => doc.body.insertAdjacentHTML("beforeend", segment("0:01", "Hello")));
    readYouTubePage(doc, req("transcript", { action: "open-transcript" }));
    expect(readYouTubePage(doc, req("transcript"))).toMatchObject({ status: "ready", data: { segments: [{ startSeconds: 1, text: "Hello" }], loadedOnly: true } });
  });
  it("normalizes structured millisecond timestamps and bounds transcript slices", () => {
    const doc = page(segment("one second", "first", 'data-start-ms="1500"') + segment("1:02:03", "second"));
    expect(readYouTubePage(doc, req("transcript", { limit: 1 }))).toMatchObject({ data: { segments: [{ startSeconds: 1.5, text: "first" }], nextOffset: 1 } });
    expect(readYouTubePage(doc, req("transcript", { offset: 1 }))).toMatchObject({ data: { segments: [{ startSeconds: 3723, text: "second" }], nextOffset: null } });
    const bounded = readYouTubePage(page(Array.from({ length: 20 }, () => segment("0:01", "x".repeat(1000))).join("")), req("transcript", { limit: 100 }));
    expect(bounded).toMatchObject({ data: { nextOffset: 6 } });
    expect(JSON.stringify(bounded).length).toBeLessThan(16000);
    expect(readYouTubePage(page(segment("1 second", "No numeric timestamp")), req("transcript"))).toMatchObject({ status: "ready", data: { segments: [{ startSeconds: null, text: "No numeric timestamp" }] } });
  });
  it("scrolls only on the explicit comments stage and reports only initial top-level comments", () => {
    const doc = page('<ytd-comments id="comments"></ytd-comments>');
    const scroll = vi.fn();
    doc.querySelector("ytd-comments")!.scrollIntoView = scroll;
    expect(readYouTubePage(doc, req("comments"))).toMatchObject({ action: "load-comments" });
    expect(scroll).not.toHaveBeenCalled();
    readYouTubePage(doc, req("comments", { action: "load-comments" }));
    expect(scroll).toHaveBeenCalledTimes(1);
    doc.querySelector("ytd-comments")!.innerHTML = '<ytd-comment-thread-renderer><div id="author-text">Author</div><div id="content-text">Top level</div><ytd-comment-replies-renderer><div id="content-text">Reply</div></ytd-comment-replies-renderer></ytd-comment-thread-renderer>';
    const result = readYouTubePage(doc, req("comments"));
    expect(result).toMatchObject({ data: { items: [{ author: "Author", text: "Top level" }], incomplete: true, loadedOnly: true } });
    expect(JSON.stringify(result)).not.toContain("Reply");
  });
  it("waits for the comments mount before consuming its one preparation action", () => {
    const doc = page();
    expect(readYouTubePage(doc, req("comments"))).toEqual({ status: "pending", message: "Initial comments are not loaded; disabled or unavailable comments may remain empty." });
    doc.body.insertAdjacentHTML("beforeend", '<ytd-comments id="comments"></ytd-comments>');
    expect(readYouTubePage(doc, req("comments"))).toMatchObject({ action: "load-comments" });
    doc.querySelector("ytd-comments")!.innerHTML = '<ytd-comment-thread-renderer><ytd-comment-replies-renderer><div id="content-text">A reply, not the top level</div></ytd-comment-replies-renderer></ytd-comment-thread-renderer>';
    expect(readYouTubePage(doc, req("comments"))).toMatchObject({ status: "pending", message: "Waiting for top-level comment text." });
  });
  it("reads rendered search cards with an explicit loaded-only window", () => {
    const searchUrl = "https://www.youtube.com/results?search_query=test";
    const doc = page(`<ytd-video-renderer><a id="video-title" href="/watch?v=${id}">Example</a><ytd-channel-name>Channel</ytd-channel-name></ytd-video-renderer>`, searchUrl);
    expect(readYouTubePage(doc, req("search", { url: searchUrl }))).toMatchObject({ data: { items: [{ url, title: "Example" }], loadedOnly: true } });
  });
  it("refuses an oversized DOM rather than scanning without a bound", () => {
    expect(readYouTubePage(page("<i></i>".repeat(20001)), req("transcript")).status).toBe("unavailable");
  });
});
