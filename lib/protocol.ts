/**
 * Shared, versioned wire contract between background, content scripts, and
 * extension UI surfaces. Every cross-context message is a JSON-compatible
 * discriminated union carrying an explicit `v: 1` envelope version.
 *
 * Extend this file as later slices introduce new message types; never add
 * ad-hoc message names outside this contract.
 */

export interface PageHealthRequest {
  v: 1;
  id: string;
  type: "page.health";
}

export type PageRequest = PageHealthRequest;

export interface PageHealthResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.health";
  url: string;
}

export type PageResponse = PageHealthResponse;

export function isPageHealthRequest(value: unknown): value is PageHealthRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && candidate.type === "page.health" && typeof candidate.id === "string";
}
