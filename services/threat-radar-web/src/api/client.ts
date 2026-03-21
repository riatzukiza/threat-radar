/**
 * API client for the threat-radar-mcp backend.
 *
 * Provides typed fetch functions with proper error handling.
 * All network errors are caught and re-thrown as descriptive messages
 * without exposing internal details.
 */

import type {
  BlueskyTimelinePost,
  JetstreamRule,
  JetstreamStatus,
  OperatorDraft,
  OperatorSession,
  RadarTile,
  SignalFeedItem,
  WorkspaceConfig,
  WorkspacePrefs,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Fetch all radar tiles from the API.
 *
 * @param apiUrl - Base URL of the threat-radar-mcp API (e.g. "http://localhost:9001")
 * @returns Array of RadarTile objects
 * @throws ApiError on network failure or non-OK HTTP status
 */
export async function fetchRadars(apiUrl: string): Promise<RadarTile[]> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/radars`);
  } catch (_err: unknown) {
    throw new ApiError("Unable to reach the radar API");
  }

  if (!res.ok) {
    throw new ApiError(`API returned HTTP ${res.status}`, res.status);
  }

  try {
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      throw new ApiError("Unexpected API response format");
    }
    return data as RadarTile[];
  } catch (err: unknown) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("Failed to parse API response");
  }
}

export async function fetchSignalFeed(apiUrl: string, radarId?: string, limit = 200): Promise<SignalFeedItem[]> {
  const url = new URL(`${apiUrl}/api/signals`, window.location.origin);
  url.searchParams.set("limit", String(limit));
  if (radarId) {
    url.searchParams.set("radarId", radarId);
  }
  return fetchJson<SignalFeedItem[]>(url.toString());
}

function operatorHeaders(sessionId?: string): HeadersInit {
  return sessionId ? { "x-operator-session": sessionId } : {};
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    throw new ApiError("Unable to reach the radar API");
  }
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new ApiError(message || `API returned HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export async function loginOperator(apiUrl: string, identifier: string, appPassword: string, serviceUrl?: string): Promise<OperatorSession> {
  const data = await fetchJson<{ ok: true; session: OperatorSession }>(`${apiUrl}/api/operator/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, appPassword, serviceUrl }),
  });
  return data.session;
}

export async function fetchOperatorSession(apiUrl: string, sessionId: string): Promise<OperatorSession> {
  const data = await fetchJson<{ ok: true; session: OperatorSession }>(`${apiUrl}/api/operator/auth/session`, {
    headers: operatorHeaders(sessionId),
  });
  return data.session;
}

export async function logoutOperator(apiUrl: string, sessionId: string): Promise<void> {
  await fetchJson<{ ok: true }>(`${apiUrl}/api/operator/auth/logout`, {
    method: "POST",
    headers: operatorHeaders(sessionId),
  });
}

export async function fetchBlueskyTimeline(apiUrl: string, sessionId: string, limit = 25): Promise<BlueskyTimelinePost[]> {
  const data = await fetchJson<{ ok: true; posts: BlueskyTimelinePost[] }>(`${apiUrl}/api/operator/bluesky/timeline?limit=${encodeURIComponent(String(limit))}`, {
    headers: operatorHeaders(sessionId),
  });
  return data.posts;
}

export async function fetchDrafts(apiUrl: string, sessionId: string): Promise<OperatorDraft[]> {
  const data = await fetchJson<{ ok: true; drafts: OperatorDraft[] }>(`${apiUrl}/api/operator/drafts`, {
    headers: operatorHeaders(sessionId),
  });
  return data.drafts;
}

export async function createDraft(apiUrl: string, sessionId: string, title: string, text: string): Promise<OperatorDraft> {
  const data = await fetchJson<{ ok: true; draft: OperatorDraft }>(`${apiUrl}/api/operator/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders(sessionId) },
    body: JSON.stringify({ title, text }),
  });
  return data.draft;
}

export async function updateDraft(apiUrl: string, sessionId: string, draftId: string, title: string, text: string): Promise<OperatorDraft> {
  const data = await fetchJson<{ ok: true; draft: OperatorDraft }>(`${apiUrl}/api/operator/drafts/${encodeURIComponent(draftId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...operatorHeaders(sessionId) },
    body: JSON.stringify({ title, text }),
  });
  return data.draft;
}

export async function deleteDraft(apiUrl: string, sessionId: string, draftId: string): Promise<void> {
  await fetchJson<{ ok: true }>(`${apiUrl}/api/operator/drafts/${encodeURIComponent(draftId)}`, {
    method: "DELETE",
    headers: operatorHeaders(sessionId),
  });
}

export async function publishDraft(apiUrl: string, sessionId: string, text: string, draftId?: string, title?: string): Promise<Record<string, unknown>> {
  const data = await fetchJson<{ ok: true; published: Record<string, unknown> }>(`${apiUrl}/api/operator/publish/bluesky`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders(sessionId) },
    body: JSON.stringify({ text, draftId, title }),
  });
  return data.published;
}

export async function fetchWorkspaceConfig(apiUrl: string, sessionId: string): Promise<WorkspaceConfig> {
  const data = await fetchJson<{ ok: true; workspace: WorkspaceConfig }>(`${apiUrl}/api/operator/workspace`, {
    headers: operatorHeaders(sessionId),
  });
  return data.workspace;
}

export async function updateWorkspaceConfig(apiUrl: string, sessionId: string, prefs: Pick<WorkspacePrefs, "enabledServerIds" | "proxxDocked">): Promise<WorkspacePrefs> {
  const data = await fetchJson<{ ok: true; prefs: WorkspacePrefs }>(`${apiUrl}/api/operator/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...operatorHeaders(sessionId) },
    body: JSON.stringify(prefs),
  });
  return data.prefs;
}

export async function fetchJetstreamStatus(apiUrl: string): Promise<JetstreamStatus> {
  const data = await fetchJson<{ ok: true } & JetstreamStatus>(`${apiUrl}/api/jetstream/status`);
  return data;
}

export async function fetchJetstreamRule(apiUrl: string, sessionId: string, radarId: string): Promise<JetstreamRule | null> {
  const data = await fetchJson<{ ok: true; rule: JetstreamRule | null }>(`${apiUrl}/api/operator/jetstream/rules/${encodeURIComponent(radarId)}`, {
    headers: operatorHeaders(sessionId),
  });
  return data.rule;
}

export async function updateJetstreamRule(apiUrl: string, sessionId: string, radarId: string, rule: Partial<JetstreamRule>): Promise<JetstreamRule> {
  const data = await fetchJson<{ ok: true; rule: JetstreamRule }>(`${apiUrl}/api/operator/jetstream/rules/${encodeURIComponent(radarId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...operatorHeaders(sessionId) },
    body: JSON.stringify(rule),
  });
  return data.rule;
}

export async function collectJetstream(apiUrl: string, sessionId: string, radarId: string, limit?: number): Promise<{ collected: number; duplicates: number; total_fetched: number }> {
  return fetchJson(`${apiUrl}/api/operator/jetstream/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders(sessionId) },
    body: JSON.stringify({ radarId, limit }),
  });
}
