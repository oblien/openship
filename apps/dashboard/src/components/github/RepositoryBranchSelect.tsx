"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { CustomSelect, type CustomSelectProps } from "@/components/ui/CustomSelect";
import { githubApi } from "@/lib/api/github";
import { projectsApi } from "@/lib/api/projects";

interface Props {
  owner: string;
  repo: string;
  projectId?: string;
  value: string;
  onChange: (branch: string) => void;
  initialBranches?: string[];
  initialPage?: number;
  initialHasMore?: boolean;
  disabled?: boolean;
  footerAction?: CustomSelectProps<string>["footerAction"];
}

/** Repository identity owns the pending requests and pagination state. */
export function RepositoryBranchSelect(props: Props) {
  return <BranchSelect key={`${props.projectId ?? ""}/${props.owner}/${props.repo}`} {...props} />;
}

function BranchSelect({
  owner,
  repo,
  projectId,
  value,
  onChange,
  initialBranches = [],
  initialPage = 0,
  initialHasMore = true,
  disabled,
  footerAction,
}: Props) {
  const { t } = useI18n();
  const text = t.deploy.sidebar;
  const [branches, setBranches] = useState(initialBranches);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const page = useRef(initialPage);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (!active.current || pending.current || !hasMore || !owner || !repo || owner === "local")
      return;
    pending.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const result = projectId
        ? await projectsApi.getBranchPage(projectId, page.current + 1)
        : await githubApi.listBranches(owner, repo, page.current + 1);
      if (!active.current) return;
      page.current = result.pagination.page;
      setBranches((previous) => [
        ...new Set([...previous, ...result.data.map((branch) => branch.name)]),
      ]);
      setHasMore(result.pagination.hasMore);
    } catch {
      if (active.current) setFailed(true);
    } finally {
      pending.current = false;
      if (active.current) setLoading(false);
    }
  }, [hasMore, owner, repo, projectId]);

  // Keep the selected/default branch available even when it is on a later page.
  const names = [...new Set([value, ...initialBranches, ...branches].filter(Boolean))];
  const rank = (name: string) => (name === "main" ? 0 : name === "master" ? 1 : 2);
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return (
    <div className="space-y-1.5">
      <CustomSelect
        value={value}
        onChange={onChange}
        disabled={disabled}
        onOpen={() => {
          if (page.current === 0 || failed) void loadMore();
        }}
        onLoadMore={loadMore}
        hasMore={hasMore && !failed}
        isLoadingMore={loading}
        searchable
        options={names.map((name) => ({
          value: name,
          label: name,
          icon: <UiIcon name="git-branch" className="size-3.5" />,
        }))}
        footerAction={footerAction}
        placeholder={text.selectBranch}
        searchPlaceholder={text.searchBranches}
        emptyMessage={text.noBranchesMatch}
        loadingMessage={text.loadingBranches}
        loadMoreMessage={text.loadMoreBranches}
      />
      {failed && (
        <p role="alert" className="text-xs text-destructive">
          {text.loadBranchesFailed}{" "}
          <button type="button" className="underline" onClick={loadMore}>
            {text.retryBranches}
          </button>
        </p>
      )}
    </div>
  );
}
