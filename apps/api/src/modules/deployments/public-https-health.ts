import { shellQuote } from "@repo/core";
import { repos } from "@repo/db";

export type PublicHttpsStatus = "passed" | "failed" | "skipped" | "unchecked";

export interface PublicHttpsResult {
  hostname: string | null;
  https: PublicHttpsStatus;
}

export function publicHttpsProbeCommand(hostname: string, healthPath: string): string {
  const path = healthPath.trim() || "/";
  const url = `https://${hostname}${path.startsWith("/") ? path : `/${path}`}`;
  return (
    `code=$(curl -fsS --max-time 8 -o /dev/null -w "%{http_code}" ${shellQuote(url)} 2>/dev/null || echo 000); ` +
    `case $code in 2??|3??) exit 0;; *) exit 1;; esac`
  );
}

export async function resolveProjectPublicHostname(projectId: string): Promise<string | null> {
  const rows = await repos.domain.listByProject(projectId, { limit: 8 }).catch(() => []);
  const hostname = rows.find((row) => row.hostname?.trim())?.hostname?.trim();
  return hostname || null;
}

export function publicHttpsFromMeta(meta: unknown): PublicHttpsResult {
  const value = (meta ?? {}) as { publicHttps?: PublicHttpsResult };
  if (!value.publicHttps) return { hostname: null, https: "unchecked" };
  return value.publicHttps;
}
