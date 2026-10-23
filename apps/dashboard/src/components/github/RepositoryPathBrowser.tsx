"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { githubApi, type RepoTreeEntry } from "@/lib/api/github";
import { getApiErrorMessage, getApiRequestScopeVersion } from "@/lib/api/client";
import { buildTree } from "@/components/permissions/path-tree";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export interface RepositorySource {
  owner: string;
  repo: string;
  branch?: string;
}

/** One permission-filtered repository tree for both folder and file selection. */
export function RepositoryPathBrowser({
  source,
  kind,
  value,
  onChange,
}: {
  source: RepositorySource;
  kind: "directory" | "file";
  value: string;
  onChange: (path: string) => void;
}) {
  const { t } = useI18n();
  const copy = t.importProject.monorepo.selection;
  const treeCopy = t.widgets.permissions.sourceAccess;
  const [entries, setEntries] = useState<RepoTreeEntry[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [folder, setFolder] = useState(
    kind === "directory" ? value : value.split("/").slice(0, -1).join("/") || ".",
  );
  const scope = useRef(getApiRequestScopeVersion());
  const key = JSON.stringify([source.owner, source.repo, source.branch]);
  const [loadedKey, setLoadedKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    scope.current = getApiRequestScopeVersion();
    setEntries(null);
    setError("");
    setLoadedKey(key);
    githubApi
      .getRepoTree(source.owner, source.repo, source.branch)
      .then((result) => {
        if (!cancelled && scope.current === getApiRequestScopeVersion()) setEntries(result.data);
      })
      .catch((error) => {
        if (!cancelled && scope.current === getApiRequestScopeVersion())
          setError(getApiErrorMessage(error, treeCopy.treeError));
      });
    return () => {
      cancelled = true;
    };
  }, [key, source.owner, source.repo, source.branch, retry, treeCopy.treeError]);

  // Manual path edits and source changes move the browser too. File navigation
  // itself never selects a directory as the Dockerfile.
  useEffect(() => {
    setFolder(kind === "directory" ? value : value.split("/").slice(0, -1).join("/") || ".");
  }, [value, kind, key]);
  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  let children = tree;
  for (const part of folder.split("/").filter((part) => part && part !== "."))
    children = children.find((node) => node.name === part && node.isDirectory)?.children ?? [];
  const visible = children.filter((node) => kind === "file" || node.isDirectory);
  const parent = folder.split("/").slice(0, -1).join("/") || ".";
  const navigate = (path: string) => {
    if (scope.current !== getApiRequestScopeVersion()) return;
    setFolder(path);
    if (kind === "directory") onChange(path);
  };

  return (
    <div className="max-h-56 overflow-auto rounded-xl bg-background p-2">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <Icon name="folder" className="size-3.5 shrink-0" />
        <span className="truncate font-mono" dir="ltr">
          {folder || "."}
        </span>
      </div>
      {folder !== "." && folder !== "" && (
        <Button type="button" variant="ghost" size="sm" onClick={() => navigate(parent)}>
          <Icon name="arrow-left" className="rtl:rotate-180" />
          {copy.parentFolder}
        </Button>
      )}
      {loadedKey !== key || (!entries && !error) ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          {treeCopy.treeLoading}
        </p>
      ) : error ? (
        <div role="alert" className="space-y-2 p-2 text-sm">
          <p>{error}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setRetry(retry + 1)}>
            {copy.retry}
          </Button>
        </div>
      ) : visible.length ? (
        visible.map((node) => (
          <button
            key={node.path}
            type="button"
            className="flex w-full items-center gap-2 rounded-lg p-2 text-start text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring"
            onClick={() => {
              if (scope.current !== getApiRequestScopeVersion()) return;
              if (node.isDirectory) navigate(node.path);
              else onChange(node.path);
            }}
          >
            <Icon
              name={node.isDirectory ? "folder" : "file"}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 truncate" dir="ltr">
              {node.name}
            </span>
            {node.isDirectory && (
              <Icon name="chevron-right" className="ms-auto size-4 shrink-0 rtl:rotate-180" />
            )}
            {!node.isDirectory && node.path === value && (
              <Icon name="check" className="ms-auto size-4 shrink-0" />
            )}
          </button>
        ))
      ) : (
        <p className="p-3 text-sm text-muted-foreground">
          {kind === "directory" ? copy.noSubfolders : treeCopy.treeEmpty}
        </p>
      )}
    </div>
  );
}
