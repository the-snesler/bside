// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { App } from "@/entrypoints/options/App";
import { SETTINGS_GROUPS, SETTINGS_PAGES } from "@/entrypoints/options/pages";
import { routeFromHash, searchPages } from "@/entrypoints/options/navigation";
import { Card, Row, Switch } from "@/lib/ui/settings/primitives";
import { OPENAI_API_KEY_PROVIDER } from "@/lib/providers/openai";
import type { CredentialRequest, HistoryRequest, SettingsRequest, SkillsRequest } from "@/lib/protocol";

let root: HTMLDivElement;
afterEach(() => {
  if (root) render(null, root);
  document.body.innerHTML = "";
  history.replaceState(null, "", location.pathname);
  vi.restoreAllMocks();
});

async function mount({ hash = "", connected = false, signInAgain = false, configured = false } = {}) {
  let retention = "forever";
  let sessionCount = 3;
  history.replaceState(null, "", `${location.pathname}${hash}`);
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (message: unknown) => {
    const request = message as CredentialRequest | SettingsRequest | HistoryRequest | SkillsRequest;
    if (request.type === "skills.list") return { v: 1, id: request.id, ok: true, skills: [], builtinNames: [] };
    if (request.type.startsWith("history.")) {
      let notice: string | null = null;
      if (request.type === "history.retention.save") retention = request.retention;
      if (request.type === "history.deleteAll") { notice = `Deleted ${sessionCount} chats.`; sessionCount = 1; }
      return { v: 1, id: request.id, ok: true, settings: { version: 1, retention }, sessionCount, notice };
    }
    if (request.type === "settings.get" || request.type === "settings.save") return { v: 1, id: request.id, ok: true, notice: null, provider: OPENAI_API_KEY_PROVIDER,
      settings: { version: 1, providerId: "openai", modelId: "gpt-5.6-terra", reasoningEffort: "medium" } };
    if (request.type === "credentials.chatgpt.login") { connected = true; signInAgain = false; }
    if (request.type === "credentials.chatgpt.notice.dismiss") signInAgain = false;
    if (request.type === "credentials.chatgpt.disconnect") connected = false;
    if (request.type === "credentials.openai.save") configured = true;
    return { v: 1, id: request.id, ok: true, configured, maskedSuffix: configured ? "abcd" : null, notice: null,
      chatgpt: { connected, email: connected ? "user@example.test" : null, signInAgain } };
  });
  root = document.createElement("div"); document.body.append(root);
  await act(async () => render(h(App, {}), root));
  await vi.waitFor(() => expect(root.querySelector("h1")).not.toBeNull());
  return send;
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
const navLinks = () => [...root.querySelectorAll<HTMLAnchorElement>("nav a")];
const navLink = (label: string) => navLinks().find((link) => link.querySelector(".settings-nav__label")?.textContent === label);
const title = () => root.querySelector("h1")?.textContent;
const search = () => root.querySelector<HTMLInputElement>("input[type=search]")!;

async function typeSearch(value: string) {
  await act(async () => {
    search().value = value;
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function go(hash: string) {
  await act(async () => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

describe("settings page registry", () => {
  it("gives every page a unique routable id in a known group, with an icon and keywords", () => {
    const ids = SETTINGS_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of SETTINGS_PAGES) {
      expect(routeFromHash(`#/${page.id}`)).toBe(page.id);
      expect(SETTINGS_GROUPS).toContain(page.group);
      expect(page.icon).toBeTypeOf("function");
      expect(page.keywords.length).toBeGreaterThan(0);
    }
  });

  it("parses only #/<id> routes", () => {
    expect(routeFromHash("#/skills")).toBe("skills");
    expect(routeFromHash("#/skills/")).toBe("skills");
    expect(routeFromHash("")).toBeNull();
    expect(routeFromHash("#skills")).toBeNull();
    expect(routeFromHash("#/../x")).toBeNull();
  });

  it("matches labels and keywords case-insensitively, every word, with a hint for keyword matches", () => {
    expect(searchPages(SETTINGS_PAGES, "").length).toBe(SETTINGS_PAGES.length);
    expect(searchPages(SETTINGS_PAGES, "  SKILLS ").map((result) => [result.page.id, result.hint])).toEqual([["skills", null]]);
    expect(searchPages(SETTINGS_PAGES, "retention").map((result) => [result.page.id, result.hint])).toEqual([["history", "Retention"]]);
    expect(searchPages(SETTINGS_PAGES, "api key").map((result) => result.page.id)).toEqual(["account"]);
    expect(searchPages(SETTINGS_PAGES, "delete").map((result) => result.page.id)).toEqual(["account", "skills", "history"]);
    expect(searchPages(SETTINGS_PAGES, "nothing-like-this")).toEqual([]);
  });
});

describe("settings primitives", () => {
  it("labels a row's control by its title and renders toggles as real switch checkboxes", async () => {
    root = document.createElement("div"); document.body.append(root);
    const onChange = vi.fn();
    await act(async () => render(h(Card, { children: h(Row, { title: "Notify me", description: "When a task finishes.", controlId: "notify", control: h(Switch, { id: "notify", checked: false, onChange }) }) }), root));
    const toggle = root.querySelector<HTMLInputElement>("#notify")!;
    expect(toggle.type).toBe("checkbox");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(root.querySelector("label[for=notify]")!.textContent).toBe("Notify me");
    expect(toggle.getAttribute("aria-describedby")).toBe("notify-description");
    expect(root.querySelector("#notify-description")!.textContent).toBe("When a task finishes.");
    await act(async () => { toggle.click(); });
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe("settings navigation", () => {
  it("opens Account by default until an account is connected, and records it in the URL", async () => {
    await mount();
    await vi.waitFor(() => expect(title()).toBe("Account"));
    expect(location.hash).toBe("#/account");
    expect(navLink("Account")!.getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Account · bside settings");
  });

  it("opens General by default when connected, and for an unknown route", async () => {
    await mount({ configured: true });
    await vi.waitFor(() => expect(title()).toBe("General"));
    expect(location.hash).toBe("#/general");
    render(null, root);
    await mount({ hash: "#/nope", connected: true });
    await vi.waitFor(() => expect(title()).toBe("General"));
  });

  it("deep-links to a page and follows hash changes", async () => {
    await mount({ hash: "#/skills" });
    expect(title()).toBe("Skills");
    expect(location.hash).toBe("#/skills");
    expect(navLink("Skills")!.getAttribute("aria-current")).toBe("page");
    expect(navLinks().filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
    await go("#/history");
    expect(title()).toBe("History & privacy");
    expect(navLink("History & privacy")!.getAttribute("aria-current")).toBe("page");
    expect(navLink("Skills")!.hasAttribute("aria-current")).toBe(false);
  });

  it("lists pages under group headings inside a labelled nav landmark", async () => {
    await mount({ hash: "#/general" });
    const nav = root.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Settings");
    expect([...nav.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([...SETTINGS_GROUPS]);
    expect(navLinks().map((link) => link.getAttribute("href"))).toEqual(SETTINGS_PAGES.map((page) => `#/${page.id}`));
  });

  it("filters the sidebar by label and keyword, and opens the first match on Enter", async () => {
    await mount({ hash: "#/general" });
    await typeSearch("keep chats");
    expect(navLinks().map((link) => link.textContent)).toEqual(["History & privacyKeep chats"]);
    expect([...root.querySelectorAll("nav h2")].map((heading) => heading.textContent)).toEqual(["Data"]);
    await act(async () => { search().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await vi.waitFor(() => expect(title()).toBe("History & privacy"));
    await typeSearch("zzz");
    expect(navLinks()).toHaveLength(0);
    expect(root.querySelector("nav")!.textContent).toContain("No settings match “zzz”.");
    await act(async () => { search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(search().value).toBe("");
    expect(navLinks()).toHaveLength(SETTINGS_PAGES.length);
  });

  it("folds the sidebar into a menu button that closes on navigation and Escape", async () => {
    await mount({ hash: "#/general" });
    const menu = root.querySelector<HTMLButtonElement>("button[aria-controls=settings-sidebar]")!;
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { menu.click(); });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search());
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { menu.click(); });
    await go("#/skills");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".settings-topbar")!.textContent).toBe("Skills");
  });
});

describe("General settings", () => {
  it("asks to connect an account until one is connected", async () => {
    await mount({ hash: "#/general" });
    await vi.waitFor(() => expect(root.textContent).toContain("Connect an OpenAI account to start."));
    const banner = root.querySelector(".settings-banner")!;
    expect(banner.querySelector("a")!.getAttribute("href")).toBe("#/account");
    expect(root.textContent).toContain("Not connected");
    render(null, root);
    await mount({ hash: "#/general", connected: true });
    await vi.waitFor(() => expect(root.textContent).toContain("ChatGPT plan · user@example.test"));
    expect(root.textContent).not.toContain("Connect an OpenAI account to start.");
  });

  it("saves the model and reasoning effort through the background, with labelled selects", async () => {
    const send = await mount({ hash: "#/general", configured: true });
    await vi.waitFor(() => expect(root.querySelector("#settings-model")).not.toBeNull());
    const effort = root.querySelector<HTMLSelectElement>("#settings-effort")!;
    expect(root.querySelector("label[for=settings-effort]")!.textContent).toBe("Reasoning effort");
    const nextEffort = [...effort.options].map((option) => option.value).find((value) => value !== effort.value)!;
    await act(async () => {
      effort.value = nextEffort;
      effort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "settings.save", settings: expect.objectContaining({ reasoningEffort: nextEffort }) }));
  });
});

describe("Account settings", () => {
  it("signs in with a single button through the background and asks for no PIN", async () => {
    const send = await mount({ hash: "#/account" });
    await vi.waitFor(() => expect(button("Continue with ChatGPT")?.disabled).toBe(false));
    expect(root.textContent).toContain("Not connected.");
    expect(root.textContent).not.toMatch(/\bPIN\b|unlock/i);
    expect(root.querySelector("input[inputmode=numeric]")).toBeNull();
    await act(async () => { button("Continue with ChatGPT")!.click(); });
    await vi.waitFor(() => expect(root.textContent).toContain("Connected as user@example.test."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.login" }));
    expect(JSON.stringify(send.mock.calls)).not.toContain("pin");
    expect(button("Continue with ChatGPT")).toBeUndefined();
    expect(button("Test connection")).toBeDefined();
  });

  it("keeps Disconnect for a saved connection", async () => {
    const send = await mount({ hash: "#/account", connected: true });
    await vi.waitFor(() => expect(root.textContent).toContain("Connected as user@example.test."));
    expect(button("Lock")).toBeUndefined();
    await act(async () => { button("Disconnect")!.click(); });
    await vi.waitFor(() => expect(root.textContent).toContain("Not connected."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.disconnect" }));
    expect(button("Continue with ChatGPT")).toBeDefined();
  });

  it("shows the one-time sign-in-again notice until dismissed", async () => {
    const send = await mount({ hash: "#/account", signInAgain: true });
    await vi.waitFor(() => expect(root.textContent).toContain("Sign in with ChatGPT again."));
    await act(async () => { button("Dismiss")!.click(); });
    await vi.waitFor(() => expect(root.textContent).not.toContain("Sign in with ChatGPT again."));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.chatgpt.notice.dismiss" }));
    expect(button("Continue with ChatGPT")).toBeDefined();
  });

  it("clears the sign-in-again notice after signing in", async () => {
    await mount({ hash: "#/account", signInAgain: true });
    await vi.waitFor(() => expect(button("Continue with ChatGPT")?.disabled).toBe(false));
    await act(async () => { button("Continue with ChatGPT")!.click(); });
    await vi.waitFor(() => expect(root.textContent).toContain("Connected as user@example.test."));
    expect(root.textContent).not.toContain("Sign in with ChatGPT again.");
  });

  it("saves an API key through the background and clears the field", async () => {
    const send = await mount({ hash: "#/account" });
    const input = root.querySelector<HTMLInputElement>("#settings-api-key")!;
    expect(input.type).toBe("password");
    expect(root.querySelector("label[for=settings-api-key]")!.textContent).toBe("Add a key");
    expect(button("Test & save")!.disabled).toBe(true);
    await act(async () => {
      input.value = "sk-test-secret";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "credentials.openai.save", apiKey: "sk-test-secret" }));
    await vi.waitFor(() => expect(root.textContent).toContain("Configured (ending in abcd)."));
    expect(input.value).toBe("");
    expect(root.innerHTML).not.toContain("sk-test-secret");
    expect(button("Replace")).toBeDefined();
    expect(button("Delete key")).toBeDefined();
  });
});

describe("History settings", () => {
  const retentionSelect = () => root.querySelector<HTMLSelectElement>("#settings-retention")!;

  it("states that history is local and contains page text, and saves retention through the background", async () => {
    const send = await mount({ hash: "#/history" });
    await vi.waitFor(() => expect(root.textContent).toContain("3 chats saved."));
    expect(root.querySelector("label[for=settings-retention]")!.textContent).toBe("Keep chats");
    expect(root.textContent).toContain("only in this Firefox profile");
    expect(root.textContent).toContain("text from pages bside read");
    expect(root.textContent).toContain("Pinned chats");
    expect(retentionSelect().value).toBe("forever");
    expect([...retentionSelect().options].map((option) => option.textContent)).toEqual(["Forever", "30 days", "7 days"]);
    await act(async () => {
      retentionSelect().value = "7d";
      retentionSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "history.retention.save", retention: "7d" }));
    await vi.waitFor(() => expect(retentionSelect().value).toBe("7d"));
  });

  it("deletes all history only after an inline confirmation", async () => {
    const send = await mount({ hash: "#/history" });
    await vi.waitFor(() => expect(button("Delete all history")).toBeDefined());
    await act(async () => { button("Delete all history")!.click(); });
    expect(root.textContent).toContain("Delete 3 chats, including pinned ones?");
    expect(document.activeElement).toBe(button("Cancel"));
    await act(async () => { button("Cancel")!.click(); });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "history.deleteAll" }));
    await act(async () => { button("Delete all history")!.click(); });
    await act(async () => { button("Delete all")!.click(); });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "history.deleteAll" }));
    await vi.waitFor(() => expect(root.textContent).toContain("Deleted 3 chats."));
    expect(root.textContent).toContain("1 chat saved.");
  });
});
