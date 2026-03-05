/**
 * CLI HTTP client — communicates with the Openship API.
 */

const DEFAULT_API_URL = "http://localhost:4000/api";

export function getApiUrl(): string {
  return process.env.OPENSHIP_API_URL || DEFAULT_API_URL;
}

export async function apiRequest(path: string, options?: RequestInit) {
  const url = `${getApiUrl()}${path}`;
  const token = getStoredToken();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

function getStoredToken(): string | null {
  // TODO: Read token from ~/.openship/config.json
  return null;
}
