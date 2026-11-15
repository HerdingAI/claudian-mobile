// Pure URL/token helpers for the bridge client. No Obsidian imports.

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function buildAuthHeaders(
  authToken: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const token = authToken.trim();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}
