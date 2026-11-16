"use client";

import { useEffect, useState } from "react";
import { deploySourceParams, type DeploySource } from "@repo/core";
import type { RepositoryBranding } from "@/lib/repository-branding";

export function useRepositoryBranding(source: DeploySource | null) {
  const key = source?.kind === "repo" ? deploySourceParams(source).toString() : null;
  const [result, setResult] = useState<{ key: string; display: RepositoryBranding | null } | null>(
    null,
  );
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void fetch(`/api/deploy/branding?${key}`, { signal: controller.signal, credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) return;
        const { display } = (await response.json()) as { display: RepositoryBranding | null };
        if (!controller.signal.aborted) setResult({ key, display });
      })
      .catch(() => {
        // diagnostics-ignore: branding is optional; retain the immediately usable repository fallback.
      });
    return () => controller.abort();
  }, [key]);
  return result && result.key === key ? result.display : null;
}
