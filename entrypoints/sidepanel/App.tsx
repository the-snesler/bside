import { useBackground } from "@/lib/ui/use-background";
import type { PageArtifactSummary } from "@/lib/domain/tools";

export function App() {
  const { page } = useBackground();

  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <h1 class="sidebar__title">bside</h1>
        <button
          type="button"
          class="sidebar__settings"
          onClick={() => browser.runtime.openOptionsPage()}
        >
          Settings
        </button>
      </header>
      <div class="sidebar__chip" title={page?.url}>
        {page ? describeAttachment(page) : "Unsupported page"}
      </div>
      <main class="sidebar__body">
        <p class="sidebar__empty">Open a page, then start a conversation.</p>
      </main>
    </div>
  );
}

function describeAttachment(page: PageArtifactSummary): string {
  let origin = page.url;
  try {
    origin = new URL(page.url).origin;
  } catch {
    // Keep the raw URL if it does not parse.
  }
  return page.title ? `${page.title} · ${origin}` : origin;
}
