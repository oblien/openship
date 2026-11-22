"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { actionsApi } from "@/lib/api/actions";
import { gitSourcesChangedEvent } from "@/lib/api/git";
import { DEFAULT_GIT_PROVIDER, gitRepositoryLink } from "@repo/core";
import { useGit } from "@/context/GitContext";
import { useActionResource } from "./useActions";

export function WorkflowRepositoryChecks({
  repository,
  github,
  gitProvider = DEFAULT_GIT_PROVIDER,
}: {
  repository: string;
  gitProvider?: string;
  github: boolean;
}) {
  const { t } = useI18n();
  const c = t.actions.completion;
  const slash = repository.lastIndexOf("/");
  const owner = repository.slice(0, slash),
    repo = repository.slice(slash + 1);
  const connection = useGit(gitProvider);
  const heading = github ? c.githubChecks : c.appChecks;
  const changedEvent = gitSourcesChangedEvent(gitProvider);
  const resource = useActionResource(
    useCallback(
      () =>
        actionsApi.repositoryChecks({
          gitProvider,
          owner: owner!,
          repo: repo!,
          controller: github ? "github" : "openship",
        }),
      [owner, repo, github, gitProvider],
    ),
  );
  const [connecting, setConnecting] = useState(false);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  useEffect(() => {
    window.addEventListener(changedEvent, resource.refresh);
    window.addEventListener("focus", resource.refresh);
    return () => {
      window.removeEventListener(changedEvent, resource.refresh);
      window.removeEventListener("focus", resource.refresh);
    };
  }, [resource.refresh, changedEvent]);
  const data = resource.data;
  const status = resource.error ? "unavailable" : data?.status;
  const connected = status === "connected";
  const account = data?.account;
  const hint =
    status &&
    (connected ? (github ? c.githubChecksHint : c.appChecksHint) : c.connectionHints[status]);
  return (
    <section className="space-y-3" aria-label={heading} aria-busy={resource.loading || undefined}>
      <div className="flex items-center gap-2">
        <Icon name={connection.icon} className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">{heading}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto size-7"
          onClick={resource.refresh}
          disabled={resource.loading}
          aria-label={c.refreshConnection}
        >
          <Icon name="refresh" className="size-3.5" />
        </Button>
      </div>
      <div className="rounded-xl bg-background p-3.5">
        {resource.loading && !data ? (
          <div
            className="flex animate-pulse items-center gap-3"
            aria-label={c.checkingConnection}
            role="status"
          >
            <span className="size-9 rounded-full bg-muted" />
            <span className="flex-1 space-y-2">
              <span className="block h-3 w-24 rounded bg-muted" />
              <span className="block h-2.5 w-36 rounded bg-muted" />
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-card">
              {account?.avatarUrl && failedAvatar !== account.avatarUrl ? (
                <img
                  src={account.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-full object-cover"
                  onError={() => setFailedAvatar(account.avatarUrl)}
                />
              ) : (
                <Icon name={connection.icon} className="size-5 text-muted-foreground" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {account
                  ? account.kind === "installation"
                    ? interpolate(c.installedFor, { account: account.login })
                    : account.login
                  : c.noAccount}
              </p>
              <a
                className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-foreground"
                href={gitRepositoryLink(gitProvider, owner, repo)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {repository}
              </a>
            </div>
            {status && (
              <span
                className={`shrink-0 text-xs ${connected ? "text-success" : "text-muted-foreground"}`}
              >
                {c.connectionStatus[status]}
              </span>
            )}
          </div>
        )}
      </div>
      {hint && (
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          role={status === "unavailable" ? "status" : undefined}
        >
          {hint}
        </p>
      )}
      {!resource.loading && (
        <div className="flex flex-wrap gap-2">
          {status === "unavailable" ? (
            <Button variant="secondary" size="sm" onClick={resource.refresh}>
              {t.actions.retry}
            </Button>
          ) : github && status === "actions_disabled" ? (
            <Button asChild variant="secondary" size="sm">
              <a
                href={`https://github.com/${repository}/settings/actions`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {c.enableActions}
                <Icon name="external-link" className="size-3.5" />
              </a>
            </Button>
          ) : (
            <Button
              variant={connected ? "ghost" : "secondary"}
              size="sm"
              className={connected ? "-ms-2" : undefined}
              onClick={() => setConnecting(true)}
            >
              {connected
                ? c.manageConnection
                : status === "access_required"
                  ? c.reviewAccess
                  : `Connect ${connection.definition.name}`}
              <Icon name="arrow-right" className="size-3.5 rtl:rotate-180" />
            </Button>
          )}
        </div>
      )}
      {connecting &&
        connection.renderManageConnection({
          onClose: () => {
            setConnecting(false);
            resource.refresh();
          },
        })}
    </section>
  );
}
