"use client";

import { useEffect, useState } from "react";
import { azureApi, type AzureRepo } from "@/lib/api";

export function useLibraryAzureRepos(org: string, enabled: boolean) {
  const [repos, setRepos] = useState<AzureRepo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!org || !enabled) {
      setRepos([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    azureApi
      .listRepos(org)
      .then((res) => {
        if (!cancelled) setRepos(res.repos ?? []);
      })
      .catch(() => {
        if (!cancelled) setRepos([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [org, enabled]);

  return { repos, loading };
}
