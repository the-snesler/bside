import type {
  CredentialRequest,
  CredentialResponse,
  HistoryRequest,
  HistoryResponse,
  InstructionsRequest,
  InstructionsResponse,
  SettingsRequest,
  SettingsResponse,
  SiteNotesRequest,
  SiteNotesResponse,
  SkillsRequest,
  SkillsResponse,
} from "@/lib/protocol";

/**
 * The options page's only route to background-owned state: one-shot
 * `runtime.sendMessage` requests, which the background accepts only from
 * options.html. Callers pass the request body; the envelope is added here.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RequestBody<T> = DistributiveOmit<T, "v" | "id">;

async function send<Request, Response>(request: RequestBody<Request>): Promise<Response> {
  return (await browser.runtime.sendMessage({ v: 1, id: crypto.randomUUID(), ...request })) as Response;
}

export const sendCredentialRequest = (request: RequestBody<CredentialRequest>) => send<CredentialRequest, CredentialResponse>(request);
export const sendSettingsRequest = (request: RequestBody<SettingsRequest>) => send<SettingsRequest, SettingsResponse>(request);
export const sendHistoryRequest = (request: RequestBody<HistoryRequest>) => send<HistoryRequest, HistoryResponse>(request);
export const sendSkillsRequest = (request: RequestBody<SkillsRequest>) => send<SkillsRequest, SkillsResponse>(request);
export const sendInstructionsRequest = (request: RequestBody<InstructionsRequest>) => send<InstructionsRequest, InstructionsResponse>(request);
export const sendSiteNotesRequest = (request: RequestBody<SiteNotesRequest>) => send<SiteNotesRequest, SiteNotesResponse>(request);

/** Shown when the background rejects or drops a request; never the raw error. */
export const BACKGROUND_FAILURE = "The background could not complete this request. Try again.";
