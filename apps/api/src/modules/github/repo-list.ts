import type { MappedRepository } from "./github.types";

export type RepoVisibility = "all" | "public" | "private";
export type RepoSort = "updated" | "name" | "stars";

export interface RepoListParams {
  page?: number;
  /** Absent → no slicing: `data` is the full filtered set (MCP / legacy). */
  perPage?: number;
  search?: string;
  visibility?: RepoVisibility;
  sort?: RepoSort;
}

export interface RepoListResult {
  /** The requested page (or the full filtered set when unpaged). */
  data: MappedRepository[];
  page: number;
  perPage: number;
  /** Repos matching search + visibility — drives the "N repositories" footer. */
  count: number;
  /** All repos for the owner, search-independent — the sidebar overview total. */
  total: number;
  publicCount: number;
  privateCount: number;
  totalPages: number;
}

const MAX_PER_PAGE = 100;

/**
 * Server-side search / visibility / sort / pagination for a repo list, plus the
 * authoritative counts. Mirrors the dashboard's former client-side logic
 * verbatim so moving it behind the API is invisible to the user — except the
 * displayed count is now the true total, not the length of a capped page.
 *
 * `count` reflects the active search+visibility (footer); `total` /
 * `publicCount` / `privateCount` are over the whole owner set (sidebar), so a
 * search never distorts the overview stats.
 */
export function paginateRepoList(
  repos: MappedRepository[],
  params: RepoListParams,
): RepoListResult {
  const total = repos.length;
  const publicCount = repos.filter((r) => !r.private).length;
  const privateCount = total - publicCount;

  let list = repos;
  const query = params.search?.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (r) =>
        r.name?.toLowerCase().includes(query) ||
        r.description?.toLowerCase().includes(query),
    );
  }
  if (params.visibility === "public") list = list.filter((r) => !r.private);
  else if (params.visibility === "private") list = list.filter((r) => r.private);

  const sort = params.sort ?? "updated";
  list = [...list].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "stars") return (b.stars ?? 0) - (a.stars ?? 0);
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const count = list.length;

  // No page size → return everything (keeps the MCP `list repos` tool + any
  // legacy caller returning the whole set), but still with real counts.
  if (params.perPage === undefined || params.perPage <= 0) {
    return { data: list, page: 1, perPage: count, count, total, publicCount, privateCount, totalPages: 1 };
  }

  const perPage = Math.min(Math.max(1, Math.floor(params.perPage)), MAX_PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(count / perPage));
  const page = Math.min(Math.max(1, Math.floor(params.page ?? 1)), totalPages);
  const start = (page - 1) * perPage;
  return {
    data: list.slice(start, start + perPage),
    page,
    perPage,
    count,
    total,
    publicCount,
    privateCount,
    totalPages,
  };
}
