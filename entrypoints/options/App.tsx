import { useEffect, useState } from "preact/hooks";
import { SkillsEditor } from "@/lib/ui/SkillsEditor";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { AppSettingsV1, ChatGPTStatus, ProviderDefinition, ReasoningEffort } from "@/lib/domain/provider";
import type { HistoryRetention, HistorySettingsV1 } from "@/lib/domain/conversation";
import type { CredentialRequest, CredentialResponse, HistoryRequest, HistoryResponse, SettingsRequest, SettingsResponse } from "@/lib/protocol";

interface CredentialState {
  configured: boolean;
  maskedSuffix: string | null;
  chatgpt: ChatGPTStatus;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

async function sendCredentialRequest(request: DistributiveOmit<CredentialRequest, "v" | "id">): Promise<CredentialResponse> {
  const full = { v: 1, id: crypto.randomUUID(), ...request } as CredentialRequest;
  return (await browser.runtime.sendMessage(full)) as CredentialResponse;
}

async function sendSettingsRequest(request: DistributiveOmit<SettingsRequest, "v" | "id">): Promise<SettingsResponse> {
  const full = { v: 1, id: crypto.randomUUID(), ...request } as SettingsRequest;
  return (await browser.runtime.sendMessage(full)) as SettingsResponse;
}

async function sendHistoryRequest(request: DistributiveOmit<HistoryRequest, "v" | "id">): Promise<HistoryResponse> {
  const full = { v: 1, id: crypto.randomUUID(), ...request } as HistoryRequest;
  return (await browser.runtime.sendMessage(full)) as HistoryResponse;
}

const RETENTION_LABELS: Record<HistoryRetention, string> = { forever: "Forever", "30d": "30 days", "7d": "7 days" };

const chatCount = (count: number) => `${count} ${count === 1 ? "chat" : "chats"}`;

export function App() {
  const [credential, setCredential] = useState<CredentialState | null>(null);
  const [settings, setSettings] = useState<AppSettingsV1 | null>(null);
  const [provider, setProvider] = useState<ProviderDefinition>(OPENAI_PROVIDER);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{ settings: HistorySettingsV1; sessionCount: number } | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      const [credentialResponse, settingsResponse, historyResponse] = await Promise.all([
        sendCredentialRequest({ type: "credentials.openai.status" }),
        sendSettingsRequest({ type: "settings.get" }),
        sendHistoryRequest({ type: "history.get" }),
      ]);
      if (credentialResponse.ok) setCredential(credentialResponse);
      if (historyResponse.ok) setHistory(historyResponse);
      if (settingsResponse.ok) {
        setSettings(settingsResponse.settings);
        setProvider(settingsResponse.provider);
        if (settingsResponse.notice) setNotice(settingsResponse.notice);
      }
    };
    // Re-read background-owned state when returning to this tab (e.g. after
    // changing the model in the sidebar). storage.onChanged is avoided on
    // purpose: its payload would carry the raw key into this page.
    const onFocus = () => void refresh();
    void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const performCredentialAction = async (request: DistributiveOmit<CredentialRequest, "v" | "id">) => {
    setSaving(true);
    setSaveError(null);
    setCredentialNotice(null);
    try {
      const response = await sendCredentialRequest(request);
      if (!response.ok) { setSaveError(response.error.message); return; }
      setCredential(response);
      setCredentialNotice(response.notice);
      const refreshed = await sendSettingsRequest({ type: "settings.get" });
      if (refreshed.ok) { setSettings(refreshed.settings); setProvider(refreshed.provider); }
    } catch { setSaveError("The background could not complete this request. Try again."); }
    finally { setSaving(false); }
  };

  const performHistoryAction = async (request: DistributiveOmit<HistoryRequest, "v" | "id">) => {
    setHistoryNotice(null);
    setHistoryError(null);
    setConfirmDeleteAll(false);
    try {
      const response = await sendHistoryRequest(request);
      if (!response.ok) { setHistoryError(response.error.message); return; }
      setHistory(response);
      setHistoryNotice(response.notice);
    } catch { setHistoryError("The background could not complete this request. Try again."); }
  };

  const handleSaveKey = async (event: Event) => {
    event.preventDefault();
    const action = performCredentialAction({ type: "credentials.openai.save", apiKey: apiKeyInput });
    setApiKeyInput("");
    await action;
  };

  const handleModelChange = async (event: Event) => {
    if (!settings) return;
    const modelId = (event.target as HTMLSelectElement).value;
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const reasoningEffort = (model.reasoningEfforts as readonly ReasoningEffort[]).includes(settings.reasoningEffort)
      ? settings.reasoningEffort
      : model.defaultReasoningEffort;
    const next: AppSettingsV1 = { ...settings, modelId, reasoningEffort };
    setSettings(next);
    await sendSettingsRequest({ type: "settings.save", settings: next });
  };

  const handleEffortChange = async (event: Event) => {
    if (!settings) return;
    const reasoningEffort = (event.target as HTMLSelectElement).value as ReasoningEffort;
    const next: AppSettingsV1 = { ...settings, reasoningEffort };
    setSettings(next);
    await sendSettingsRequest({ type: "settings.save", settings: next });
  };

  const currentModel = settings ? provider.models.find((model) => model.id === settings.modelId) : undefined;
  const chatgpt = credential?.chatgpt;

  return (
    <div class="options">
      <h1 class="options__title">bside settings</h1>

      <section class="options__section">
        <h2 class="options__heading">ChatGPT subscription</h2>
        <p class="options__disclosure">Use your ChatGPT plan. The saved connection is encrypted in this Firefox profile. While connected, ChatGPT takes priority over an API key.</p>
        <p class="options__status" role="status">
          {chatgpt?.connected ? `Connected${chatgpt.email ? ` as ${chatgpt.email}` : ""}.` : "Not connected."}
        </p>
        {chatgpt?.signInAgain && (
          <p class="options__notice" role="status">
            Sign in with ChatGPT again. bside no longer uses a PIN, so your earlier connection was removed.{" "}
            <button type="button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.notice.dismiss" })}>Dismiss</button>
          </p>
        )}
        <div class="options__form options__form--wrap">
          {chatgpt?.connected ? <>
            <button type="button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.test" })}>Test connection</button>
            <button type="button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.disconnect" })}>Disconnect</button>
          </> : (
            <button type="button" disabled={saving || !credential} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.login" })}>Continue with ChatGPT</button>
          )}
        </div>
        {saving && <p class="options__status" role="status">Working… Complete the sign-in window if it opened.</p>}
        {credentialNotice && <p class="options__status" role="status">{credentialNotice}</p>}
        {saveError && <p class="options__error" role="alert">{saveError}</p>}
      </section>

      <section class="options__section">
        <h2 class="options__heading">OpenAI API key</h2>
        <p class="options__disclosure">Encrypted in this Firefox profile with a key that never leaves it. Never shared with page scripts.</p>
        {credential?.configured ? (
          <p class="options__status">
            Configured (ending in {credential.maskedSuffix}).{" "}
            <button type="button" onClick={() => void performCredentialAction({ type: "credentials.openai.delete" })} disabled={saving}>
              Delete key
            </button>
          </p>
        ) : (
          <p class="options__status">Not configured.</p>
        )}
        <form class="options__form" onSubmit={(event) => void handleSaveKey(event)}>
          <input
            type="password"
            autocomplete="off"
            placeholder={credential?.configured ? "Replace with a new key" : "sk-..."}
            value={apiKeyInput}
            onInput={(event) => setApiKeyInput((event.target as HTMLInputElement).value)}
          />
          <button type="submit" disabled={saving || apiKeyInput.trim().length === 0}>
            {credential?.configured ? "Replace" : "Test & save"}
          </button>
        </form>
      </section>

      <section class="options__section">
        <h2 class="options__heading">Model</h2>
        {notice && <p class="options__notice">{notice}</p>}
        {settings && (
          <>
            <label class="options__field">
              Model
              <select value={settings.modelId} onChange={(event) => void handleModelChange(event)}>
                {provider.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label class="options__field">
              Reasoning effort
              <select value={settings.reasoningEffort} onChange={(event) => void handleEffortChange(event)}>
                {(currentModel?.reasoningEfforts ?? []).map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </section>

      <SkillsEditor />

      <section class="options__section">
        <h2 class="options__heading">History</h2>
        <p class="options__disclosure">
          Chats are saved only in this Firefox profile and are never synced. They contain your prompts, bside's answers, and text
          from pages bside read for you, such as page titles, addresses, and excerpts.
        </p>
        {history && (
          <>
            <label class="options__field">
              Keep chats
              <select
                value={history.settings.retention}
                onChange={(event) => void performHistoryAction({ type: "history.retention.save", retention: (event.target as HTMLSelectElement).value as HistoryRetention })}
              >
                {(Object.keys(RETENTION_LABELS) as HistoryRetention[]).map((retention) => (
                  <option key={retention} value={retention}>{RETENTION_LABELS[retention]}</option>
                ))}
              </select>
            </label>
            <p class="options__disclosure">
              Chats not updated within this period are deleted, starting immediately. Pinned chats, the open chat, and a chat with a
              running task are kept.
            </p>
            <p class="options__status">{chatCount(history.sessionCount)} saved.</p>
            {confirmDeleteAll ? (
              <div class="options__form options__form--wrap" role="group" aria-label="Confirm deleting all history">
                <p class="options__confirm">Delete {chatCount(history.sessionCount)}, including pinned ones? This cannot be undone.</p>
                <button type="button" class="options__secondary" onClick={() => setConfirmDeleteAll(false)}>Cancel</button>
                <button type="button" class="options__danger" onClick={() => void performHistoryAction({ type: "history.deleteAll" })}>Delete all</button>
              </div>
            ) : (
              <div class="options__form">
                <button type="button" class="options__danger" onClick={() => setConfirmDeleteAll(true)}>Delete all history</button>
              </div>
            )}
          </>
        )}
        {historyNotice && <p class="options__status" role="status">{historyNotice}</p>}
        {historyError && <p class="options__error" role="alert">{historyError}</p>}
      </section>
    </div>
  );
}
