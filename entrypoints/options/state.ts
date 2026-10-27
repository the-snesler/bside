import { useEffect, useState } from "preact/hooks";
import { OPENAI_PROVIDER } from "@/lib/providers/openai-models";
import type { AppSettingsV1, ChatGPTStatus, ProviderDefinition } from "@/lib/domain/provider";
import { sendCredentialRequest, sendSettingsRequest } from "@/lib/ui/settings/requests";

export interface CredentialState {
  configured: boolean;
  maskedSuffix: string | null;
  chatgpt: ChatGPTStatus;
}

/** Background-owned state that more than one settings page shows. Page-local state stays in its page. */
export interface OptionsApp {
  /** Null until the first status reply. */
  credential: CredentialState | null;
  /** True once the first status request settled, even if it failed. */
  loaded: boolean;
  settings: AppSettingsV1 | null;
  provider: ProviderDefinition;
  /** The background's note about the saved model (e.g. it was reset). */
  settingsNotice: string | null;
  /** Adopt a credential reply and re-read settings, whose model list follows the active credential. */
  applyCredential(credential: CredentialState): Promise<void>;
  saveSettings(next: AppSettingsV1): Promise<void>;
}

export const isConnected = (credential: CredentialState) => credential.configured || credential.chatgpt.connected;

/**
 * Runs `refresh` on mount and whenever this tab regains focus, so pages
 * re-read background-owned state after it changed elsewhere (e.g. the model
 * in the sidebar). storage.onChanged is avoided on purpose: its payload would
 * carry the raw key into this page.
 */
export function useRefreshOnFocus(refresh: () => Promise<void>) {
  useEffect(() => {
    const run = () => void refresh().catch(() => undefined);
    run();
    window.addEventListener("focus", run);
    return () => window.removeEventListener("focus", run);
  }, []);
}

export function useOptionsApp(): OptionsApp {
  const [credential, setCredential] = useState<CredentialState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<AppSettingsV1 | null>(null);
  const [provider, setProvider] = useState<ProviderDefinition>(OPENAI_PROVIDER);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  const refreshSettings = async () => {
    const response = await sendSettingsRequest({ type: "settings.get" });
    if (!response.ok) return;
    setSettings(response.settings);
    setProvider(response.provider);
    if (response.notice) setSettingsNotice(response.notice);
  };

  useRefreshOnFocus(async () => {
    try {
      const [credentialResponse] = await Promise.all([sendCredentialRequest({ type: "credentials.openai.status" }), refreshSettings()]);
      if (credentialResponse.ok) setCredential(credentialResponse);
    } finally {
      setLoaded(true);
    }
  });

  return {
    credential,
    loaded,
    settings,
    provider,
    settingsNotice,
    applyCredential: async (next) => {
      setCredential(next);
      await refreshSettings();
    },
    saveSettings: async (next) => {
      setSettings(next);
      await sendSettingsRequest({ type: "settings.save", settings: next });
    },
  };
}
