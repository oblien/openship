"use client";

import { useState } from "react";
import { Icon } from "@repo/ui/icons";
import { RepositoryPathBrowser } from "@/components/github/RepositoryPathBrowser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n-provider";
import type { ServiceRepositorySource } from "./repository-source";

export function RepositoryBuildFields({
  source,
  context,
  dockerfile,
  onContext,
  onDockerfile,
}: {
  source: ServiceRepositorySource;
  context: string;
  dockerfile: string;
  onContext: (value: string) => void;
  onDockerfile: (value: string) => void;
}) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.addModal.repositorySource;
  const [browsing, setBrowsing] = useState<"directory" | "file" | null>(null);
  return (
    <section className="space-y-4 rounded-xl bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Icon name="github" className="size-4 shrink-0" />
        <span className="min-w-0 break-all font-medium" dir="ltr">
          {source.owner}/{source.repo}
        </span>
        {source.branch && (
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <Icon name="git-branch" className="size-3.5 shrink-0" />
            <span className="break-all" dir="ltr">
              {source.branch}
            </span>
          </span>
        )}
      </div>
      {(["directory", "file"] as const).map((kind) => (
        <div key={kind} className="space-y-2">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">
              {kind === "directory" ? copy.context : copy.dockerfile}
            </span>
            <div className="flex items-center gap-2">
              <Input
                variant="filled"
                dir="ltr"
                className="min-w-0 font-mono"
                maxLength={500}
                value={kind === "directory" ? context : dockerfile}
                onChange={(event) =>
                  (kind === "directory" ? onContext : onDockerfile)(event.target.value)
                }
                placeholder={kind === "directory" ? "." : "Dockerfile"}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={kind === "directory" ? copy.browseContext : copy.browseDockerfile}
                aria-expanded={browsing === kind}
                onClick={() => setBrowsing(browsing === kind ? null : kind)}
              >
                <Icon name="folder" />
              </Button>
            </div>
          </label>
          {browsing === kind && (
            <RepositoryPathBrowser
              source={source}
              kind={kind}
              value={kind === "directory" ? context : dockerfile}
              onChange={(path) => {
                if (kind === "directory") onContext(path);
                else {
                  onDockerfile(path);
                  setBrowsing(null);
                }
              }}
            />
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{copy.pathHint}</p>
    </section>
  );
}
