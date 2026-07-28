"use client";

import { useState, useEffect, useRef } from "react";
import { githubApi } from "@/lib/api";
import type { GitHubRepo } from "@/context/GitHubContext";
import type { VisibilityFilter, SortBy } from "./types";

export const REPOS_PER_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 200;

/** Authoritative counts from the server. `count` follows the active
 *  search/visibility (the list footer); `total`/`publicCount`/`privateCount`
 *  are the owner-wide overview (the sidebar) and ignore the search. */
export interface RepoPageMeta {
  count: number;
  total: number;
  publicCount: number;
  privateCount: number;
  page: number;
  totalPages: number;
}

const EMPTY_META: RepoPageMeta = {
  count: 0,
  total: 0,
  publicCount: 0,
  privateCount: 0,
  page: 1,
  totalPages: 1,
};

export interface LibraryReposState {
  repos: GitHubRepo[];
  meta: RepoPageMeta;
  loading: boolean;
  search: string;
  setSearch: (s: string) => void;
  visibility: VisibilityFilter;
  setVisibility: (v: VisibilityFilter) => void;
  sort: SortBy;
  setSort: (s: SortBy) => void;
  page: number;
  setPage: (p: number) => void;
}

/**
 * Server-side paginated repo list for the Library. Owns the page/search/
 * visibility/sort query, debounces search, and resets to page 1 whenever the
 * owner or a filter changes (atomically, so no wasted fetch). A monotonic
 * request id drops stale responses when the user pages/searches quickly.
 */
export function useLibraryRepos(owner: string, enabled: boolean): LibraryReposState {
  const [query, setQuery] = useState<{
    search: string;
    visibility: VisibilityFilter;
    sort: SortBy;
    page: number;
  }>({ search: "", visibility: "all", sort: "updated", page: 1 });
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [meta, setMeta] = useState<RepoPageMeta>(EMPTY_META);
  const [loading, setLoading] = useState(false);

  // Reset to page 1 and drop the previous owner's data the instant `owner`
  // changes — done during render (React's "adjust state on a prop change"
  // pattern), so the fetch effect below already sees page 1. Doing it in a
  // separate effect instead would fetch once for the stale page and again after
  // the reset commits (a wasted request), and would leave the sidebar showing
  // the previous owner's counts until the new page lands.
  const [prevOwner, setPrevOwner] = useState(owner);
  if (owner !== prevOwner) {
    setPrevOwner(owner);
    setQuery((q) => (q.page === 1 ? q : { ...q, page: 1 }));
    setRepos([]);
    setMeta(EMPTY_META);
  }

  // Debounce the search term; land the page-1 reset in the same tick as the
  // debounced value so the fetch fires once, not once per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(query.search.trim());
      setQuery((q) => (q.page === 1 ? q : { ...q, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query.search]);

  const reqId = useRef(0);
  useEffect(() => {
    if (!owner || !enabled) {
      reqId.current++; // invalidate any in-flight response so it can't repopulate
      setRepos([]);
      setMeta(EMPTY_META);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    githubApi
      .getUserRepos(owner, {
        page: query.page,
        perPage: REPOS_PER_PAGE,
        search: debouncedSearch || undefined,
        visibility: query.visibility,
        sort: query.sort,
      })
      .then((res) => {
        if (id !== reqId.current) return; // superseded by a newer request
        setRepos((res.data ?? []) as GitHubRepo[]);
        setMeta({
          count: res.count ?? 0,
          total: res.total ?? 0,
          publicCount: res.publicCount ?? 0,
          privateCount: res.privateCount ?? 0,
          page: res.page ?? 1,
          totalPages: res.totalPages ?? 1,
        });
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setRepos([]);
        setMeta(EMPTY_META);
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false);
      });
  }, [owner, enabled, query.page, query.visibility, query.sort, debouncedSearch]);

  return {
    repos,
    meta,
    loading,
    search: query.search,
    setSearch: (search) => setQuery((q) => ({ ...q, search })),
    visibility: query.visibility,
    setVisibility: (visibility) => setQuery((q) => ({ ...q, visibility, page: 1 })),
    sort: query.sort,
    setSort: (sort) => setQuery((q) => ({ ...q, sort, page: 1 })),
    page: query.page,
    setPage: (page) => setQuery((q) => ({ ...q, page })),
  };
}
