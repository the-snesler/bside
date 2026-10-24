import type { AppSettingsV1, ReasoningEffort } from "@/lib/domain/provider";
import { Banner, Card, Row, Select, SettingsSection } from "@/lib/ui/settings/primitives";
import { isConnected, type CredentialState } from "../state";
import type { SettingsPageProps } from ".";

function connectionSummary(credential: CredentialState | null): string {
  if (!credential) return "Checking…";
  if (credential.chatgpt.connected) return `ChatGPT plan${credential.chatgpt.email ? ` · ${credential.chatgpt.email}` : ""}`;
  if (credential.configured) return `API key ending in ${credential.maskedSuffix}`;
  return "Not connected";
}

const effortLabel = (effort: ReasoningEffort) => effort[0]!.toUpperCase() + effort.slice(1);

export function GeneralPage({ app }: SettingsPageProps) {
  const { credential, settings, provider } = app;
  const currentModel = settings ? provider.models.find((model) => model.id === settings.modelId) : undefined;

  const handleModelChange = async (event: Event) => {
    if (!settings) return;
    const modelId = (event.target as HTMLSelectElement).value;
    const model = provider.models.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const reasoningEffort = (model.reasoningEfforts as readonly ReasoningEffort[]).includes(settings.reasoningEffort)
      ? settings.reasoningEffort
      : model.defaultReasoningEffort;
    const next: AppSettingsV1 = { ...settings, modelId, reasoningEffort };
    await app.saveSettings(next);
  };

  const handleEffortChange = async (event: Event) => {
    if (!settings) return;
    const reasoningEffort = (event.target as HTMLSelectElement).value as ReasoningEffort;
    await app.saveSettings({ ...settings, reasoningEffort });
  };

  return (
    <>
      {credential && !isConnected(credential) && (
        <Banner action={<a class="settings-button settings-button--on-accent" href="#/account">Connect</a>}>
          Connect an OpenAI account to start.
        </Banner>
      )}
      {app.settingsNotice && <Banner tone="warning">{app.settingsNotice}</Banner>}

      <SettingsSection>
        <Card>
          <Row
            title="OpenAI account"
            description={connectionSummary(credential)}
            control={<a class="settings-button" href="#/account">Manage</a>}
          />
        </Card>
      </SettingsSection>

      <SettingsSection label="Model">
        {settings && (
          <Card>
            <Row
              title="Model"
              controlId="settings-model"
              description="Used for every chat. The sidebar's model menu changes the same setting."
              control={
                <Select id="settings-model" value={settings.modelId} onChange={(event) => void handleModelChange(event)}>
                  {provider.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </Select>
              }
            />
            <Row
              title="Reasoning effort"
              controlId="settings-effort"
              description="Higher effort thinks longer before answering and uses more tokens."
              control={
                <Select id="settings-effort" value={settings.reasoningEffort} onChange={(event) => void handleEffortChange(event)}>
                  {(currentModel?.reasoningEfforts ?? []).map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
                </Select>
              }
            />
          </Card>
        )}
      </SettingsSection>
      <SettingsSection label="Keyboard shortcuts">
        <Card>
          <Row title="Open or close bside" description="Alt+Shift+B on Windows and Linux; Control+Shift+B on macOS. Opening focuses the message box." />
          <Row title="New chat" description="Assign a shortcut in Firefox: Add-ons and themes → gear menu → Manage Extension Shortcuts. You can also change or clear the sidebar shortcut there." />
          <Row title="In the message box" description="Enter sends (or queues while working). Ctrl/⌘+Enter steers a running task. Shift+Enter adds a line." />
        </Card>
      </SettingsSection>
    </>
  );
}
