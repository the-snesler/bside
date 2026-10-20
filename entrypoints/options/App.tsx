import { useEffect, useState } from "preact/hooks";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { AppSettingsV1, ChatGPTStatus, ProviderDefinition, ReasoningEffort } from "@/lib/domain/provider";
import type { CredentialRequest, CredentialResponse, SettingsRequest, SettingsResponse } from "@/lib/protocol";

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

export function App() {
  const [credential, setCredential] = useState<CredentialState | null>(null);
  const [settings, setSettings] = useState<AppSettingsV1 | null>(null);
  const [provider, setProvider] = useState<ProviderDefinition>(OPENAI_PROVIDER);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      const [credentialResponse, settingsResponse] = await Promise.all([
        sendCredentialRequest({ type: "credentials.openai.status" }),
        sendSettingsRequest({ type: "settings.get" }),
      ]);
      if (credentialResponse.ok) setCredential(credentialResponse);
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

  const handleSaveKey = async (event: Event) => {
    event.preventDefault();
    const action = performCredentialAction({ type: "credentials.openai.save", apiKey: apiKeyInput });
    setApiKeyInput("");
    await action;
  };

  const handleChatGPT = async (type: "credentials.chatgpt.login" | "credentials.chatgpt.unlock") => {
    const action = performCredentialAction({ type, pin: pinInput });
    setPinInput("");
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
  const pinValid = /^\d{8,64}$/.test(pinInput);
  const chatgpt = credential?.chatgpt;

  return (
    <div class="options">
      <h1 class="options__title">bside settings</h1>

      <section class="options__section">
        <h2 class="options__heading">ChatGPT subscription</h2>
        <p class="options__disclosure">Use your ChatGPT plan. Your PIN encrypts the saved connection; unlock it after restarting Firefox. While connected, ChatGPT takes priority over an API key.</p>
        <p class="options__status" role="status">
          {!chatgpt?.connected ? "Not connected." : chatgpt.locked ? "Locked. Enter your PIN to continue." : `Connected${chatgpt.email ? ` as ${chatgpt.email}` : ""}.`}
        </p>
        {(!chatgpt?.connected || chatgpt.locked) && (
          <form class="options__form options__form--wrap" onSubmit={(event) => {
            event.preventDefault();
            void handleChatGPT(chatgpt?.connected ? "credentials.chatgpt.unlock" : "credentials.chatgpt.login");
          }}>
            <label class="options__field options__pin">
              {chatgpt?.connected ? "PIN" : "Create a PIN (at least 8 digits)"}
              <input type="password" inputMode="numeric" autoComplete="off" minLength={8} maxLength={64} pattern="[0-9]{8,64}"
                value={pinInput} disabled={saving} onInput={(event) => setPinInput(event.currentTarget.value)} />
            </label>
            <button type="submit" disabled={saving || !pinValid}>{chatgpt?.connected ? "Unlock" : "Continue with ChatGPT"}</button>
            {chatgpt?.connected && <button type="button" disabled={saving || !pinValid} onClick={() => void handleChatGPT("credentials.chatgpt.login")}>Sign in again</button>}
          </form>
        )}
        {chatgpt?.connected && (
          <div class="options__form options__form--wrap">
            {!chatgpt.locked && <>
              <button type="button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.test" })}>Test connection</button>
              <button type="button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.lock" })}>Lock</button>
            </>}
            <button type="button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.disconnect" })}>Disconnect</button>
          </div>
        )}
        {saving && <p class="options__status" role="status">Working… Complete the sign-in window if it opened.</p>}
        {chatgpt?.locked && <p class="options__disclosure">Forgot your PIN? Enter a new PIN and choose Sign in again.</p>}
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
    </div>
  );
}
