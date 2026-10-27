export interface OnboardingApi {
  runtime: {
    getURL(path: string): string;
    onInstalled: { addListener(listener: (details: { reason: string }) => void): void };
  };
  tabs: { create(properties: { url: string }): Promise<unknown> };
}

/** Only a fresh install opens this local page. No sign-in, sidebar opening,
 * model request, or sample task happens from this background event. */
export function registerOnboarding(api: OnboardingApi): void {
  api.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === "install") void api.tabs.create({ url: api.runtime.getURL("/onboarding.html") }).catch(() => {});
  });
}
