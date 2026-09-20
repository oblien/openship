/**
 * Low-level GitHub App authentication shared by env-backed and database-backed
 * Apps. It knows nothing about tenants or storage; callers supply credentials.
 */

import crypto from "node:crypto";

export interface GitHubAppClientCredentials {
  appId: string | number;
  privateKeyPem: string;
  apiBaseUrl?: string;
}

export function generateGitHubAppJwt(credentials: GitHubAppClientCredentials): string {
  const appId = String(credentials.appId).trim();
  if (!/^\d+$/.test(appId) || Number(appId) <= 0) {
    throw new Error("GitHub App ID must be a positive integer.");
  }
  const privateKeyPem = credentials.privateKeyPem.trim();
  if (!privateKeyPem) throw new Error("A GitHub App private key is required.");

  // Parse first so malformed/non-private keys fail with a deterministic setup
  // error before any network request is attempted.
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("GitHub App private key must be an RSA private key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

function apiUrl(base: string | undefined, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${(base ?? "https://api.github.com").replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export async function githubAppFetch<T = unknown>(
  credentials: GitHubAppClientCredentials,
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(apiUrl(credentials.apiBaseUrl, path), {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${generateGitHubAppJwt(credentials)}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // An invalid Enterprise endpoint must not pin an API worker indefinitely.
    signal: options.signal ?? AbortSignal.timeout(15_000),
  });

  const raw = await response.text();
  let data: unknown = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message.slice(0, 300)
        : "GitHub rejected the request";
    throw new Error(`GitHub App API error (${response.status}): ${message}`);
  }
  return data as T;
}
