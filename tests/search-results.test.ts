// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSearchPage, resultDestination, searchEngineOf } from "@/lib/tools/search-results";
import { SEARCH_RESULT_LIMIT } from "@/lib/domain/tools";

/** Puts a sanitized results page (body markup) in the document and reads it as if at `url`. */
function read(fixture: string, url: string) {
  document.body.innerHTML = readFileSync(`tests/fixtures/serp/${fixture}`, "utf8");
  return readSearchPage(document, url);
}

describe("search engine detection", () => {
  it.each([
    ["https://www.google.com/search?q=x", "google", "Google"],
    ["https://www.google.co.uk/search?q=x", "google", "Google"],
    ["https://www.google.com.au/search?q=x", "google", "Google"],
    ["https://consent.google.de/m?continue=x", "google", "Google"],
    ["https://www.bing.com/search?q=x", "bing", "Bing"],
    ["https://duckduckgo.com/?q=x&t=ffab", "duckduckgo", "DuckDuckGo"],
    ["https://html.duckduckgo.com/html/?q=x", "duckduckgo", "DuckDuckGo"],
    ["https://www.ecosia.org/search?q=x", "other", "ecosia.org"],
    ["https://google.evil.example/search?q=x", "other", "google.evil.example"],
  ])("names the engine of %s", (url, engine, engineName) => {
    expect(searchEngineOf(new URL(url))).toEqual({ engine, engineName });
  });
});

describe("Google results", () => {
  it("keeps organic results and one featured-snippet block, and skips ads, People also ask, Things to know, and videos", () => {
    const page = read("google.html", "https://www.google.com/search?q=eiffel+tower+height");
    expect(page).toMatchObject({ engine: "google", engineName: "Google", blocked: null });
    expect(page.results.map((result) => result.url)).toEqual([
      "https://www.toureiffel.paris/en/the-monument/key-figures",
      "https://www.britannica.com/topic/Eiffel-Tower-Paris-France",
      "https://www.history.com/topics/landmarks/eiffel-tower",
    ]);
    expect(page.results[0]).toEqual({
      title: "Key figures - Official Eiffel Tower website",
      url: "https://www.toureiffel.paris/en/the-monument/key-figures",
      snippet: expect.stringContaining("Height: 330 metres"),
    });
    // The breadcrumb inside the link is not repeated as snippet text.
    expect(page.results[0]!.snippet).not.toContain("toureiffel.paris ›");
    expect(page.answer).toContain("330 metres (1,083 ft) tall");
    expect(page.answer!.length).toBeLessThanOrEqual(400);
    expect(page.answer).not.toMatch(/featured snippet/i);
    expect(JSON.stringify(page)).not.toMatch(/tickets\.example|ads\.example|example\.org\/paa|example\.com\/things|youtube\.com/);
  });

  it("uses the knowledge panel as the answer when there is no featured snippet", () => {
    const page = read("google-panel.html", "https://www.google.com/search?q=louvre");
    expect(page.results).toHaveLength(1);
    expect(page.answer).toBe("Louvre: The Louvre is a national art museum in Paris, France, and one of the most famous museums in the world.");
  });

  it("reports Google's consent host, consent dialog, and /sorry/ page as blocked", () => {
    expect(read("google-consent-dialog.html", "https://consent.google.com/m?continue=https://www.google.com/search?q=x").blocked).toBe("consent");
    expect(read("google-consent-dialog.html", "https://www.google.com/search?q=x").blocked).toBe("consent");
    expect(read("google-sorry.html", "https://www.google.com/sorry/index?continue=x").blocked).toBe("captcha");
    // The same wording without Google's own /sorry/ path still counts when there are no results.
    expect(read("google-sorry.html", "https://www.google.com/search?q=x").blocked).toBe("captcha");
  });
});

describe("Bing results", () => {
  it("decodes Bing's redirect links, skips ads and People also ask, and keeps the direct answer", () => {
    const page = read("bing.html", "https://www.bing.com/search?q=eiffel+tower+height");
    expect(page).toMatchObject({ engine: "bing", blocked: null });
    expect(page.results).toEqual([
      { title: "Eiffel Tower - Wikipedia", url: "https://en.wikipedia.org/wiki/Eiffel_Tower", snippet: expect.stringContaining("It is 330 m tall.") },
      { title: "Official website of the Eiffel Tower", url: "https://www.toureiffel.paris/en", snippet: expect.stringContaining("Book tickets") },
    ]);
    expect(page.answer).toContain("330 m");
  });

  it("reports a challenge page with no results as a CAPTCHA", () => {
    expect(read("bing-challenge.html", "https://www.bing.com/search?q=x").blocked).toBe("captcha");
  });
});

describe("DuckDuckGo results", () => {
  it("reads the JavaScript results page without ads, with the about module as the answer", () => {
    const page = read("duckduckgo.html", "https://duckduckgo.com/?q=python&t=ffab");
    expect(page.results).toEqual([
      { title: "Welcome to Python.org", url: "https://www.python.org/", snippet: "The official home of the Python Programming Language." },
      { title: "The Python Tutorial", url: "https://docs.python.org/3/tutorial/", snippet: "Python is an easy to learn, powerful programming language." },
    ]);
    expect(page.answer).toContain("high-level, general-purpose programming language");
  });

  it("unwraps the HTML page's redirect links and skips ads and its own pages", () => {
    const page = read("duckduckgo-html.html", "https://html.duckduckgo.com/html/?q=box+office+2020");
    expect(page.results).toEqual([{
      title: "2020 Worldwide Box Office",
      url: "https://www.boxofficemojo.com/year/world/2020/",
      snippet: expect.stringContaining("ranked by total gross"),
    }]);
  });

  it("reports the bot check as a CAPTCHA", () => {
    expect(read("duckduckgo-challenge.html", "https://duckduckgo.com/?q=x").blocked).toBe("captcha");
  });
});

describe("other engines", () => {
  it("reads headed links to other sites in the main content, skipping the engine's own links", () => {
    const page = read("generic.html", "https://www.ecosia.org/search?q=orchids");
    expect(page).toMatchObject({ engine: "other", engineName: "ecosia.org", answer: null, blocked: null });
    expect(page.results).toEqual([
      { title: "Orchids: how to grow and care | RHS", url: "https://www.rhs.org.uk/plants/orchids", snippet: expect.stringContaining("bright, indirect light") },
      { title: "Orchidaceae - Wikipedia", url: "https://en.wikipedia.org/wiki/Orchidaceae", snippet: expect.stringContaining("flowering plants") },
    ]);
  });

  it("falls back to the generic reading when an engine's layout is unknown", () => {
    const page = read("generic.html", "https://www.google.com/search?q=orchids");
    expect(page.results.map((result) => result.url)).toContain("https://www.rhs.org.uk/plants/orchids");
  });

  it("keeps ads and related questions out of generic fallback when there are no organic results", () => {
    document.body.innerHTML = `<main id="search"><div id="tads"><a href="https://ads.example/"><h3>Sponsored offer</h3></a></div><section><h2>People also ask</h2><a href="https://questions.example/"><h3>Related question</h3></a></section></main>`;
    expect(readSearchPage(document, "https://www.google.com/search?q=x").results).toEqual([]);
  });

  it("does not call bot-check wording blocked when the page has results", () => {
    document.body.innerHTML = `${readFileSync("tests/fixtures/serp/generic.html", "utf8")}<p>Verify you are human</p>`;
    expect(readSearchPage(document, "https://www.ecosia.org/search?q=orchids").blocked).toBeNull();
  });

  it(`caps results at ${SEARCH_RESULT_LIMIT} and keeps the page excerpt short`, () => {
    document.body.innerHTML = `<main>${Array.from({ length: 25 }, (_, i) => `<div><a href="https://site${i}.example/page"><h3>Result number ${i}</h3></a><p>${"Snippet text ".repeat(60)}</p></div>`).join("")}</main>`;
    const page = readSearchPage(document, "https://search.example/?q=x");
    expect(page.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(page.results.every((result) => result.snippet.length <= 300)).toBe(true);
    expect(page.excerpt.length).toBeLessThanOrEqual(600);
  });
});

describe("result destinations", () => {
  it.each([
    ["https://www.google.de/url?q=https://example.com/a&sa=U", "https://example.com/a"],
    ["https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb", "https://example.com/b"],
    ["https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9j", "https://example.com/c"],
    ["https://www.google.com/preferences", null],
    ["javascript:alert(1)", null],
  ])("unwraps %s", (href, destination) => {
    expect(resultDestination(href)).toBe(destination);
  });
});
