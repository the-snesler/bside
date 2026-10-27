import { useState } from "preact/hooks";
import type { CredentialRequest } from "@/lib/protocol";
import { Banner, Card, Feedback, Note, Row, SettingsSection } from "@/lib/ui/settings/primitives";
import { BACKGROUND_FAILURE, sendCredentialRequest, type RequestBody } from "@/lib/ui/settings/requests";
import type { SettingsPageProps } from ".";

export function AccountPage({ app }: SettingsPageProps) {
  const { credential } = app;
  const chatgpt = credential?.chatgpt;
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const performCredentialAction = async (request: RequestBody<CredentialRequest>) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await sendCredentialRequest(request);
      if (!response.ok) { setError(response.error.message); return; }
      setNotice(response.notice);
      await app.applyCredential(response);
    } catch { setError(BACKGROUND_FAILURE); }
    finally { setSaving(false); }
  };

  const handleSaveKey = async (event: Event) => {
    event.preventDefault();
    const action = performCredentialAction({ type: "credentials.openai.save", apiKey: apiKeyInput });
    setApiKeyInput("");
    await action;
  };

  return (
    <>
      {chatgpt?.signInAgain && (
        <Banner
          tone="warning"
          action={<button type="button" class="settings-button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.notice.dismiss" })}>Dismiss</button>}
        >
          Sign in with ChatGPT again. bside no longer uses a PIN, so your earlier connection was removed.
        </Banner>
      )}
      {saving && <Feedback>Working… Complete the sign-in window if it opened.</Feedback>}
      {notice && <Feedback>{notice}</Feedback>}
      {error && <Feedback error>{error}</Feedback>}

      <SettingsSection label="ChatGPT subscription">
        <Card>
          <Row
            title="Sign in with ChatGPT"
            live
            description={chatgpt?.connected ? `Connected${chatgpt.email ? ` as ${chatgpt.email}` : ""}.` : "Not connected."}
            control={chatgpt?.connected ? (
              <>
                <button type="button" class="settings-button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.test" })}>Test connection</button>
                <button type="button" class="settings-button" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.disconnect" })}>Disconnect</button>
              </>
            ) : (
              <button type="button" class="settings-button settings-button--primary" disabled={saving || !credential} onClick={() => void performCredentialAction({ type: "credentials.chatgpt.login" })}>Continue with ChatGPT</button>
            )}
          />
        </Card>
        <Note>Use your ChatGPT plan. The saved connection is encrypted in this Firefox profile. While connected, ChatGPT takes priority over an API key.</Note>
      </SettingsSection>

      <SettingsSection label="OpenAI API key">
        <Card>
          <Row
            title="API key"
            description={credential?.configured ? `Configured (ending in ${credential.maskedSuffix}).` : "Not configured."}
            control={credential?.configured && (
              <button type="button" class="settings-button settings-button--danger" disabled={saving} onClick={() => void performCredentialAction({ type: "credentials.openai.delete" })}>Delete key</button>
            )}
          />
          <Row title={credential?.configured ? "Replace key" : "Add a key"} controlId="settings-api-key" description="Checked with OpenAI before it is saved.">
            <form class="settings-inline-form" onSubmit={(event) => void handleSaveKey(event)}>
              <input
                id="settings-api-key"
                class="settings-input"
                type="password"
                autocomplete="off"
                placeholder={credential?.configured ? "Replace with a new key" : "sk-..."}
                value={apiKeyInput}
                aria-describedby="settings-api-key-description"
                onInput={(event) => setApiKeyInput((event.target as HTMLInputElement).value)}
              />
              <button type="submit" class="settings-button settings-button--primary" disabled={saving || apiKeyInput.trim().length === 0}>
                {credential?.configured ? "Replace" : "Test & save"}
              </button>
            </form>
          </Row>
        </Card>
        <Note>Encrypted in this Firefox profile with a key that never leaves it. Never shared with page scripts.</Note>
      </SettingsSection>
    </>
  );
}
