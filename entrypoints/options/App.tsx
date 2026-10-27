import { useEffect, useRef, useState } from "preact/hooks";
import Menu from "~icons/tabler/menu-2";
import Search from "~icons/tabler/search";
import X from "~icons/tabler/x";
import { SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPage } from "./pages";
import { hrefFor, routeFromHash, searchPages } from "./navigation";
import { isConnected, useOptionsApp } from "./state";

const findPage = (id: string | null): SettingsPage | undefined => SETTINGS_PAGES.find((page) => page.id === id);

/**
 * The settings app: a searchable, grouped sidebar of the pages in
 * `SETTINGS_PAGES` and the selected page, routed by `#/<id>`. Without a
 * route it opens Account until an account is connected, else General.
 */
export function App() {
  const app = useOptionsApp();
  const [route, setRoute] = useState(() => routeFromHash(location.hash));
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const pageTitle = useRef<HTMLHeadingElement>(null);
  const focusPage = useRef(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 719px)").matches);
  const page = findPage(route);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 719px)");
    const changed = () => setNarrow(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      focusPage.current = true;
      setRoute(routeFromHash(location.hash));
      setMenuOpen(false);
      window.scrollTo?.(0, 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (focusPage.current && page) { focusPage.current = false; pageTitle.current?.focus(); }
  }, [route, page]);

  // Resolve the default page once, after the first status reply, and record
  // it in the URL so connecting an account does not move the page.
  useEffect(() => {
    if (page || !app.loaded) return;
    const fallback = findPage(app.credential && !isConnected(app.credential) ? "account" : "general")!;
    history.replaceState(null, "", hrefFor(fallback));
    setRoute(fallback.id);
  }, [page, app.loaded]);

  useEffect(() => {
    document.title = page ? `${page.label} · bside settings` : "bside settings";
  }, [page]);

  useEffect(() => {
    if (!menuOpen) return;
    search.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); }
      if (event.key !== "Tab" || !narrow) return;
      // The narrow menu covers the pane. Keep keyboard focus in its visible
      // controls, including the button that closes it.
      const controls = [menuButton.current, ...document.querySelectorAll<HTMLElement>("#settings-sidebar input, #settings-sidebar a")].filter((element): element is HTMLElement => element !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, narrow]);

  const results = searchPages(SETTINGS_PAGES, query);

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      location.hash = hrefFor(results[0].page);
    } else if (event.key === "Escape" && query) {
      event.stopPropagation();
      setQuery("");
    }
  };

  const Icon = page?.icon;
  const PageComponent = page?.component;

  return (
    <div class={menuOpen ? "settings settings--menu-open" : "settings"}>
      <header class="settings-topbar">
        <button
          type="button"
          class="settings-topbar__menu"
          ref={menuButton}
          aria-label="Settings menu"
          aria-expanded={menuOpen}
          aria-controls="settings-sidebar"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
        {Icon && <Icon class="settings-topbar__icon" aria-hidden="true" />}
        <span class="settings-topbar__title">{page?.label ?? "Settings"}</span>
      </header>

      <aside id="settings-sidebar" class="settings-sidebar">
        <div class="settings-brand">
          <img src="/icon.svg" alt="" width={22} height={22} />
          <span>bside settings</span>
        </div>
        <div class="settings-search">
          <Search class="settings-search__icon" aria-hidden="true" />
          <input
            ref={search}
            type="search"
            class="settings-search__input"
            placeholder="Search…"
            aria-label="Search settings"
            aria-controls="settings-nav"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        <nav id="settings-nav" class="settings-nav" aria-label="Settings">
          {SETTINGS_GROUPS.map((group) => {
            const items = results.filter((result) => result.page.group === group);
            if (!items.length) return null;
            const headingId = `settings-nav-${group.toLowerCase()}`;
            return (
              <div key={group} class="settings-nav__group">
                <h2 id={headingId} class="settings-nav__heading">{group}</h2>
                <ul class="settings-nav__list" aria-labelledby={headingId}>
                  {items.map(({ page: item, hint }) => {
                    const ItemIcon = item.icon;
                    return (
                      <li key={item.id}>
                        <a
                          class="settings-nav__item"
                          href={hrefFor(item)}
                          aria-current={item === page ? "page" : undefined}
                          onClick={() => {
                            setMenuOpen(false);
                            // Selecting the current route causes no hashchange.
                            if (item === page && narrow) requestAnimationFrame(() => pageTitle.current?.focus());
                          }}
                        >
                          <ItemIcon class="settings-nav__icon" aria-hidden="true" />
                          <span class="settings-nav__text">
                            <span class="settings-nav__label">{item.label}</span>
                            {hint && <span class="settings-nav__hint">{hint}</span>}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {!results.length && <p class="settings-nav__empty" role="status">No settings match “{query.trim()}”.</p>}
        </nav>
      </aside>

      <main class="settings-pane" inert={menuOpen && narrow}>
        {page && PageComponent && (
          <div class="settings-page" key={page.id}>
            <h1 class="settings-page__title" ref={pageTitle} tabIndex={-1}>{page.label}</h1>
            {page.description && <p class="settings-page__description">{page.description}</p>}
            <PageComponent app={app} />
          </div>
        )}
      </main>
    </div>
  );
}
