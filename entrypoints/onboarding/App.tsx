import { useState } from "preact/hooks";

export function App() {
  const [notice, setNotice] = useState<string | null>(null);
  return <main class="welcome">
    <img src="/icon.svg" alt="" width={56} height={56} />
    <h1>Meet bside</h1>
    <p>Your browser assistant, beside the page. Ask it to read, compare, or help with a task, and watch its work in the sidebar.</p>
    <section aria-labelledby="welcome-privacy">
      <h2 id="welcome-privacy">Choose what you share</h2>
      <p>When you send a task, bside sends your prompt and relevant page content, URLs, tool results, and saved context to OpenAI. Connected accounts can share data with their MCP service and OpenAI. Tasks can use your signed-in websites.</p>
      <p>Chats and memory stay in this Firefox profile until used in a task or exported by you. There is no bside backend or telemetry. <a href="/privacy.html">Read the privacy policy</a>.</p>
    </section>
    <ol class="welcome__steps">
      <li><h2>Connect your account</h2>
        <p>Use Sign in with ChatGPT or an OpenAI API key in Account settings. A compatible plan or paid API access is required.</p>
        <a class="welcome__button" href="/options.html#/account">Open Account settings</a>
      </li>
      <li><h2>Keep bside handy</h2>
        <p>Open Firefox’s Extensions menu (the puzzle piece), find bside, and choose Pin to Toolbar from its menu. Click bside’s toolbar button to open or close the sidebar. You can also choose bside from Firefox’s sidebar selector.</p>
        <button type="button" class="welcome__button" onClick={() => {
          // Firefox requires the direct click gesture. Never defer through a
          // background message, await, timer, or install event.
          try {
            const sidebar = Reflect.get(browser, "sidebarAction") as { open(): Promise<void> };
            void sidebar.open().catch(() => setNotice("Use bside’s toolbar button or Firefox’s sidebar selector to open the sidebar."));
          } catch { setNotice("Use bside’s toolbar button or Firefox’s sidebar selector to open the sidebar."); }
        }}>Open sidebar</button>
        {notice && <p role="status">{notice}</p>}
      </li>
      <li><h2>Try a small task</h2>
        <p>Open a public article, select the sample below, and paste it into bside’s message box. Review the attached page, then press Send when you are ready. This sample does not run automatically.</p>
        <label for="welcome-sample">Sample task</label>
        <textarea id="welcome-sample" rows={3} readOnly value="Summarize this page in three bullet points and link to the source." />
        <p>You can stop a run, review confirmations, or take over an agent tab. Avoid sharing passwords or other secrets in chat.</p>
      </li>
    </ol>
    <p>Return here from Settings → History &amp; privacy → Getting started.</p>
  </main>;
}
