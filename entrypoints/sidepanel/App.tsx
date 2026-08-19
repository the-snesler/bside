export function App() {
  return (
    <div class="sidebar">
      <header class="sidebar__header">
        <h1 class="sidebar__title">Agent</h1>
        <button
          type="button"
          class="sidebar__settings"
          onClick={() => browser.runtime.openOptionsPage()}
        >
          Settings
        </button>
      </header>
      <main class="sidebar__body">
        <p class="sidebar__empty">Open a page, then start a conversation.</p>
      </main>
    </div>
  );
}
