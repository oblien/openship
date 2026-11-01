"use client";

import { useCallback, useState, type SetStateAction } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { DEPLOYMENT_HISTORY_STATUSES, type DeploymentHistoryFilter } from "@repo/core";

interface HistoryQuery {
  days: number;
  page: number;
  filter: DeploymentHistoryFilter | "all";
  searchQuery: string;
  selectedProjectId: string;
}
const DEFAULT_QUERY: HistoryQuery = { days: 30, page: 1, filter: "all", searchQuery: "", selectedProjectId: "all" };

function readQuery(params: Pick<URLSearchParams, "get">): HistoryQuery {
  const status = params.get("status") ?? "all";
  const page = Number(params.get("page") ?? 1);
  return {
    days: [7, 30, 90].includes(Number(params.get("days"))) ? Number(params.get("days")) : 30,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    filter: Object.hasOwn(DEPLOYMENT_HISTORY_STATUSES, status) ? status as DeploymentHistoryFilter : "all",
    searchQuery: (params.get("q") ?? "").slice(0, 200),
    selectedProjectId: params.get("project") || "all",
  };
}

/** The standalone history is URL-owned; embedded project tabs keep local state. */
export function useDeploymentHistoryQuery(isProject: boolean) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [local, setLocal] = useState(DEFAULT_QUERY);
  const query = isProject ? local : readQuery(searchParams);
  const setQuery = useCallback((update: SetStateAction<HistoryQuery>) => {
    if (isProject) { setLocal(update); return; }
    const url = new URL(window.location.href);
    // A late response/search must not rewrite the page navigated to meanwhile.
    if (url.pathname !== pathname) return;
    // Read the current URL so rapid filter edits compose before React rerenders.
    const next = typeof update === "function" ? update(readQuery(url.searchParams)) : update;
    for (const [key, value, defaultValue] of [
      ["days", String(next.days), "30"], ["status", next.filter, "all"], ["project", next.selectedProjectId, "all"],
      ["q", next.searchQuery, ""], ["page", String(next.page), "1"],
    ] as const) {
      if (value === defaultValue) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    if (url.href === window.location.href) return;
    // Next synchronizes native history writes with useSearchParams. This keeps
    // the current history entry and scroll position without a server navigation.
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [isProject, pathname]);
  return [query, setQuery] as const;
}
