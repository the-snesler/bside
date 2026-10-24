/**
 * Reads a search results page in the session's search tab, after Firefox ran
 * the user's default engine there (`search.query`). The URL says which engine
 * produced it; Google, Bing, and DuckDuckGo have their own extractors, and any
 * other engine's page is read generically. The result is a compact list
 * (title, URL, snippet; at most `SEARCH_RESULT_LIMIT`) plus at most one short
 * answer block (a featured snippet, direct answer, or knowledge panel), never
 * a page snapshot. Ads, "People also ask", "Things to know", and video and
 * other carousels are skipped. A consent wall or CAPTCHA is reported as
 * `blocked` so the model can ask the user to clear it in the search tab.
 */

import { SEARCH_RESULT_LIMIT, type SearchEngineId, type SearchPage, type SearchResult } from "@/lib/domain/tools";
import { clip, composedText, isRendered, trimText } from "@/lib/tools/page-executor";

const SNIPPET_CHARS = 300;
const ANSWER_CHARS = 400;
const EXCERPT_CHARS = 600;

const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/;

/** Hosts whose links are the engine's own pages or redirects, never results themselves. */
const SEARCH_ENGINE_HOSTS = ["duckduckgo.com", "bing.com", "search.yahoo.com", "startpage.com"];

/** Module headings on a results page whose links are not organic results. */
const SKIPPED_MODULES = /^(?:people also ask|people also search for|related searches|things to know|videos?|short videos|images|top stories|perspectives|discussions and forums|what people are saying|latest posts from .*|explore further|related questions|ads?|sponsored( results)?)$/i;

/** Phrases a CAPTCHA or bot check shows; they decide only when the page has no results. */
const CAPTCHA_TEXT = /unusual traffic from your computer network|verify (?:that )?you are (?:a )?human|are you a robot|not a robot|solve the challenge|complete the following challenge|confirm this search was made by a human|bots use duckduckgo too|one last step/i;
const CONSENT_TEXT = /before you continue to google|we use cookies and data to/i;
const CAPTCHA_SELECTORS = [
  "#captcha-form", "form[action*='sorry']", ".g-recaptcha", "#recaptcha", "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']",
  "iframe[src*='challenges.cloudflare.com']", ".cf-turnstile", "#b_captcha", "[class*='anomaly-modal']", "#challenge-form",
].join(", ");

export function searchEngineOf(url: URL): { engine: SearchEngineId; engineName: string } {
  const host = url.hostname.toLowerCase();
  if (GOOGLE_HOST.test(host)) return { engine: "google", engineName: "Google" };
  if (host === "bing.com" || host.endsWith(".bing.com")) return { engine: "bing", engineName: "Bing" };
  if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return { engine: "duckduckgo", engineName: "DuckDuckGo" };
  return { engine: "other", engineName: host.replace(/^www\./, "") };
}

/** Reads the search tab's page; `href` is its URL (`location.href` in the content script). */
export function readSearchPage(document: Document, href: string, limit = SEARCH_RESULT_LIMIT): SearchPage {
  const url = new URL(href);
  const { engine, engineName } = searchEngineOf(url);
  const read = engine === "google" ? google(document, limit)
    : engine === "bing" ? bing(document, limit)
    : engine === "duckduckgo" ? duckDuckGo(document, limit)
    : { results: [], answer: null };
  // An engine whose layout changed still gets the generic reading rather than nothing.
  const results = read.results.length ? read.results : generic(document, url, limit);
  const excerpt = document.body ? composedText(document.body, EXCERPT_CHARS) : "";
  return { engine, engineName, url: href, results, answer: read.answer, blocked: blockedBy(document, url, engine, results.length > 0), excerpt };
}

/**
 * Whether the page is a consent wall or a CAPTCHA instead of results. The
 * engines' own interstitials (Google's consent host and `/sorry/` page,
 * DuckDuckGo's bot check) count whatever else is on the page; generic signs
 * (challenge widgets, bot-check wording) count only when there are no results.
 */
function blockedBy(document: Document, url: URL, engine: SearchEngineId, hasResults: boolean): SearchPage["blocked"] {
  if (engine === "google") {
    if (url.hostname.startsWith("consent.")) return "consent";
    if (url.pathname.startsWith("/sorry/")) return "captcha";
  }
  if (engine === "duckduckgo" && document.querySelector("[class*='anomaly-modal'], #challenge-form")) return "captcha";
  if (hasResults) return null;
  const text = document.body?.textContent ?? "";
  if (engine === "google" && (CONSENT_TEXT.test(text) || document.querySelector("form[action*='consent.google']"))) return "consent";
  if (document.querySelector(CAPTCHA_SELECTORS) || CAPTCHA_TEXT.test(text)) return "captcha";
  return null;
}

type EngineRead = { results: SearchResult[]; answer: string | null };

function google(document: Document, limit: number): EngineRead {
  const root = document.querySelector("#rso") ?? document.querySelector("#search") ?? document.body;
  if (!root) return { results: [], answer: null };
  const skipped = [
    ...Array.from(document.querySelectorAll("#tads, #tadsb, #bottomads, [data-text-ad], [aria-label='Ads'], [aria-label='Sponsored']")),
    ...Array.from(root.querySelectorAll("[data-initq], .related-question-pair, g-scrolling-carousel, g-inner-card, video-voyager")),
    ...modulesHeaded(root, SKIPPED_MODULES),
  ];
  const featured = [...modulesHeaded(root, /^featured snippet/i), ...Array.from(root.querySelectorAll("[data-attrid='wa:/description']"))];
  const answer = answerFrom(featured[0]) ?? googlePanel(document);
  const results = new Map<string, SearchResult>();
  for (const heading of Array.from(root.querySelectorAll("a h3"))) {
    if (results.size >= limit) break;
    const anchor = heading.closest("a[href]")!;
    if ([...skipped, ...featured].some((module) => module.contains(anchor))) continue;
    add(results, anchor, composedText(heading, 200), singleResult(anchor, root, "h3"));
  }
  return { results: [...results.values()], answer };
}

/** Google's knowledge panel: its title and description. */
function googlePanel(document: Document): string | null {
  const panel = document.querySelector("#rhs, .kp-wholepage");
  const description = panel?.querySelector("[data-attrid='description'], [data-attrid$=':description']") ?? document.querySelector("[data-attrid='description']");
  if (!description || !isRendered(description)) return null;
  const title = panel?.querySelector("[data-attrid='title'], h2") ?? null;
  const text = composedText(description, ANSWER_CHARS);
  return text ? clip(trimText(`${title && isRendered(title) ? `${composedText(title, 100)}: ` : ""}${text}`), ANSWER_CHARS) : null;
}

function bing(document: Document, limit: number): EngineRead {
  const results = new Map<string, SearchResult>();
  for (const item of Array.from(document.querySelectorAll("#b_results > li.b_algo"))) {
    if (results.size >= limit) break;
    const anchor = item.querySelector("h2 a[href]");
    if (!anchor || item.closest(".b_ad, .b_adTop, .b_adBottom")) continue;
    const snippet = item.querySelector(".b_caption p, [class*='b_lineclamp'], .b_algoSlug, .b_snippet");
    add(results, anchor, composedText(anchor, 200), snippet ?? item);
  }
  const focus = document.querySelector("#b_results [class*='b_focusText']")?.closest(".b_ans, .b_rich, li") ?? null;
  const panel = document.querySelector("#b_context .b_entityTP");
  return { results: [...results.values()], answer: answerFrom(focus) ?? answerFrom(panel) };
}

function duckDuckGo(document: Document, limit: number): EngineRead {
  const results = new Map<string, SearchResult>();
  // The JavaScript page (duckduckgo.com/?q=), then the HTML and Lite pages.
  const items = [
    ...Array.from(document.querySelectorAll("article[data-testid='result']"), (item) => ({ item, anchor: item.querySelector("a[data-testid='result-title-a']"), snippet: item.querySelector("[data-result='snippet']") })),
    ...Array.from(document.querySelectorAll(".result:not(.result--ad)"), (item) => ({ item, anchor: item.querySelector("a.result__a"), snippet: item.querySelector(".result__snippet") })),
    ...Array.from(document.querySelectorAll("a.result-link"), (anchor) => ({ item: anchor, anchor, snippet: anchor.closest("tr")?.nextElementSibling?.querySelector(".result-snippet") ?? null })),
  ];
  for (const { item, anchor, snippet } of items) {
    if (results.size >= limit) break;
    if (!anchor || item.closest("[data-testid='ad'], .result--ad, .badge--ad")) continue;
    add(results, anchor, composedText(anchor, 200), snippet ?? item);
  }
  const about = document.querySelector("[data-testid='about-module'], .module--about .module__text, .zci__body");
  return { results: [...results.values()], answer: answerFrom(about) };
}

/**
 * Any other engine: links in the main content to other sites, those with a
 * heading first (titles of results usually are), then the rest, each with
 * the text around it as its snippet.
 */
function generic(document: Document, url: URL, limit: number): SearchResult[] {
  const root = document.querySelector("main, [role='main'], #main, #results, #search") ?? document.body;
  if (!root) return [];
  const own = siteOf(url.hostname);
  const anchors = Array.from(root.querySelectorAll("a[href]")).filter((anchor) => {
    const destination = resultDestination((anchor as HTMLAnchorElement).href);
    return destination !== null && siteOf(new URL(destination).hostname) !== own;
  });
  const headed = (anchor: Element) => !!(anchor.querySelector("h1, h2, h3, h4") ?? anchor.closest("h1, h2, h3, h4"));
  const results = new Map<string, SearchResult>();
  for (const anchor of [...anchors.filter(headed), ...anchors.filter((anchor) => !headed(anchor))]) {
    if (results.size >= limit) break;
    const title = composedText(anchor, 200);
    if (title.length < 3 || /^https?:\/\//.test(title)) continue;
    let context: Element | null = null;
    for (let node = anchor.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
      if (node.querySelectorAll("a[href]").length > 8) break;
      if (composedText(node, 600).length >= title.length + 40) { context = node; break; }
    }
    add(results, anchor, title, context);
  }
  return [...results.values()];
}

/** The top-level blocks of `root` (or their nearest ancestor below it) whose heading matches. */
function modulesHeaded(root: Element, pattern: RegExp): Element[] {
  const modules: Element[] = [];
  for (const heading of Array.from(root.querySelectorAll("h2, h3, [role='heading']"))) {
    if (heading.closest("a") || !pattern.test(trimText(heading.textContent ?? ""))) continue;
    let module: Element = heading;
    while (module.parentElement && module.parentElement !== root) module = module.parentElement;
    modules.push(module.parentElement === root ? module : heading.parentElement ?? heading);
  }
  return modules;
}

/** The largest ancestor of a result link (below `root`) that holds only that one result. */
function singleResult(anchor: Element, root: Element, titleSelector: string): Element {
  let container = anchor;
  for (let node = anchor.parentElement, depth = 0; node && node !== root && depth < 8; node = node.parentElement, depth++) {
    if (node.querySelectorAll(titleSelector).length > 1) break;
    container = node;
  }
  return container;
}

function answerFrom(element: Element | null | undefined): string | null {
  if (!element || !isRendered(element)) return null;
  const text = trimText(composedText(element, ANSWER_CHARS + 100)
    .replace(/featured snippet from the web|about featured snippets|feedback/gi, ""));
  return text.length >= 20 ? clip(text, ANSWER_CHARS) : null;
}

/** Adds one result, keyed by destination; the text of `context` outside the link is its snippet. */
function add(results: Map<string, SearchResult>, anchor: Element, title: string, context: Element | null): void {
  const destination = resultDestination((anchor as HTMLAnchorElement).href);
  if (!destination || results.has(destination) || !isRendered(anchor)) return;
  title = trimText(title);
  if (title.length < 2) return;
  const snippet = context ? trimText(composedText(context, 600, anchor).replace(title, "")) : "";
  results.set(destination, { title, url: destination, snippet: clip(snippet, SNIPPET_CHARS) });
}

function isSearchEngineHost(hostname: string): boolean {
  return GOOGLE_HOST.test(hostname) || SEARCH_ENGINE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

/** Unwraps a search engine's redirect link into its destination URL; null for the engine's own pages. */
export function resultDestination(href: string): string | null {
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

/** A host's site, roughly its registrable domain (`news.example.co.uk` → `example.co.uk`). */
function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().split(".");
  const secondLevel = labels.length > 2 && labels.at(-1)!.length === 2 && /^(?:co|com|org|net|ac|gov|edu|ne|or)$/.test(labels.at(-2)!);
  return labels.slice(secondLevel ? -3 : -2).join(".");
}
