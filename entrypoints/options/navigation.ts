import type { SettingsPage } from "./pages";

/** `#/skills` → `"skills"`; anything else → null. */
export function routeFromHash(hash: string): string | null {
  const match = /^#\/([a-z0-9-]+)\/?$/.exec(hash);
  return match ? match[1]! : null;
}

export const hrefFor = (page: Pick<SettingsPage, "id">) => `#/${page.id}`;

export interface SearchResult {
  page: SettingsPage;
  /** The keyword that matched when the label did not, shown under the nav item. */
  hint: string | null;
}

/**
 * Pages whose label or keywords contain every word of `query`, in registry
 * order. An empty query returns every page.
 */
export function searchPages(pages: readonly SettingsPage[], query: string): SearchResult[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return pages.map((page) => ({ page, hint: null }));
  const results: SearchResult[] = [];
  for (const page of pages) {
    const label = page.label.toLocaleLowerCase();
    const haystack = [label, ...page.keywords.map((keyword) => keyword.toLocaleLowerCase())].join("\n");
    if (!words.every((word) => haystack.includes(word))) continue;
    const labelMatches = words.every((word) => label.includes(word));
    const hint = labelMatches
      ? null
      : page.keywords.find((keyword) => words.some((word) => keyword.toLocaleLowerCase().includes(word))) ?? null;
    results.push({ page, hint });
  }
  return results;
}
