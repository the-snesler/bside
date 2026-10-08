import { useEffect, useState } from "preact/hooks";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { AppSettingsV1, ReasoningEffort } from "@/lib/domain/provider";
import type { CredentialRequest, CredentialResponse, SettingsRequest, SettingsResponse } from "@/lib/protocol";

interface CredentialState {
  configured: boolean;
  maskedSuffix: string | null;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      const [credentialResponse, settingsResponse] = await Promise.all([
        sendCredentialRequest({ type: "credentials.openai.status" }),
        sendSettingsRequest({ type: "settings.get" }),
      ]);
      if (credentialResponse.ok) setCredential({ configured: credentialResponse.configured, maskedSuffix: credentialResponse.maskedSuffix });
      if (settingsResponse.ok) {
        setSettings(settingsResponse.settings);
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

  const handleSaveKey = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    const response = await sendCredentialRequest({ type: "credentials.openai.save", apiKey: apiKeyInput });
    setSaving(false);
    if (!response.ok) {
      setSaveError(response.error.message);
      return;
    }
    setCredential({ configured: response.configured, maskedSuffix: response.maskedSuffix });
    setApiKeyInput("");
  };

  const handleDeleteKey = async () => {
    setSaving(true);
    const response = await sendCredentialRequest({ type: "credentials.openai.delete" });
    setSaving(false);
    if (response.ok) setCredential({ configured: response.configured, maskedSuffix: response.maskedSuffix });
  };

  const handleModelChange = async (event: Event) => {
    if (!settings) return;
    const modelId = (event.target as HTMLSelectElement).value;
    const model = OPENAI_PROVIDER.models.find((candidate) => candidate.id === modelId);
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

  const currentModel = settings ? OPENAI_PROVIDER.models.find((model) => model.id === settings.modelId) : undefined;

  return (
    <div class="options">
      <h1 class="options__title">bside settings</h1>

      <section class="options__section">
        <h2 class="options__heading">OpenAI API key</h2>
        <p class="options__disclosure">Stored unencrypted in this Firefox profile. Never shared with page scripts.</p>
        {credential?.configured ? (
          <p class="options__status">
            Configured (ending in {credential.maskedSuffix}).{" "}
            <button type="button" onClick={() => void handleDeleteKey()} disabled={saving}>
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
        {saveError && <p class="options__error">{saveError}</p>}
      </section>

      <section class="options__section">
        <h2 class="options__heading">Model</h2>
        {notice && <p class="options__notice">{notice}</p>}
        {settings && (
          <>
            <label class="options__field">
              Model
              <select value={settings.modelId} onChange={(event) => void handleModelChange(event)}>
                {OPENAI_PROVIDER.models.map((model) => (
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
