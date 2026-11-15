"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { CloudWorkspaceUsage } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { formatBillingNumber } from "@/lib/billing-usage";

type Project = CloudWorkspaceUsage["projects"][number];
const PREVIEW_LIMIT = 4;

/** Projects use the same scoped snapshot as resource usage, including in the full list. */
export function ServerProjects({
  usage,
  loading,
  error,
  refresh,
  resourcePool,
  title,
  unavailableHint,
}: {
  usage: CloudWorkspaceUsage | null;
  loading: boolean;
  error: string | null;
  refresh?: ReactNode;
  resourcePool: boolean;
  title?: string;
  unavailableHint?: string;
}) {
  const { t, locale } = useI18n();
  const copy = t.servers.resources;
  const [expanded, setExpanded] = useState(false);
  const projects = usage?.projects ?? [];
  const showDisk =
    projects.some((project) => project.diskMb !== null) || usage?.sharedDiskMb != null;
  const heading = title ?? t.billing.resourcesGuide.projects;
  const visible = resourcePool ? projects.slice(0, PREVIEW_LIMIT) : projects;
  const showAll = interpolate(copy.showAllProjects, { count: String(projects.length) });
  return (
    <section className="@container/plan-projects rounded-2xl bg-card p-5" aria-busy={loading}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{heading}</h2>
          {(resourcePool || showDisk) && (
            <p className="mt-1 text-sm text-muted-foreground">
              {resourcePool ? copy.projectsAssignedHint : t.billing.workspaces.projectDiskHint}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {resourcePool && (
            <span className="rounded-full bg-muted/50 px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
              {usage ? projects.length : "—"}
            </span>
          )}
          {refresh}
        </div>
      </header>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <div
        className={`mt-4 grid gap-2 ${resourcePool ? "@min-[36rem]/plan-projects:grid-cols-2" : ""}`}
      >
        {loading ? (
          [0, 1].map((key) => (
            <div key={key} className="h-14 motion-safe:animate-pulse rounded-xl bg-muted/40" />
          ))
        ) : usage ? (
          <>
            {visible.map((project) => (
              <ProjectLink key={project.id} project={project} showDisk={showDisk} />
            ))}
            {projects.length === 0 &&
              (usage.available ? (
                <div className="col-span-full rounded-xl bg-muted/30 p-4">
                  <p className="text-sm text-muted-foreground">
                    {resourcePool ? copy.noProjects : t.billing.workspaces.noProjects}
                  </p>
                  <Button asChild variant="secondary" size="sm" className="mt-3">
                    <Link href="/library">
                      {t.dashboard.pages.projects.emptyState.createProject}
                    </Link>
                  </Button>
                </div>
              ) : (
                <p role="status" className="col-span-full py-2 text-sm text-muted-foreground">
                  {unavailableHint ?? usage.reason ?? t.billing.resourceOverview.unavailable}
                </p>
              ))}
          </>
        ) : (
          <p className="col-span-full py-2 text-sm text-muted-foreground">
            {t.billing.resourceOverview.unavailable}
          </p>
        )}
      </div>
      {!loading && resourcePool && projects.length > PREVIEW_LIMIT && (
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => setExpanded(true)}>
          {showAll}
          <Icon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden />
        </Button>
      )}
      {usage?.sharedDiskMb != null && (
        <div className="mt-3 flex justify-between gap-4 text-xs text-muted-foreground">
          <span>{t.billing.workspaces.sharedDisk}</span>
          <span className="shrink-0 whitespace-nowrap tabular-nums">
            {formatBillingNumber(usage.sharedDiskMb / 1024, locale)} GB
          </span>
        </div>
      )}
      {resourcePool && showDisk && (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{copy.storageDetails}</summary>
          <p className="mt-2 leading-5">{t.billing.workspaces.projectDiskHint}</p>
        </details>
      )}
      {expanded && (
        <ProjectListDialog
          projects={projects}
          title={heading}
          showDisk={showDisk}
          onClose={() => setExpanded(false)}
        />
      )}
    </section>
  );
}

function ProjectLink({ project, showDisk }: { project: Project; showDisk: boolean }) {
  const { t, locale } = useI18n();
  return (
    <Link
      href={`/projects/${encodeURIComponent(project.id)}`}
      className="flex min-w-0 items-center gap-3 rounded-xl bg-muted/30 p-3 text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground">
        <Icon name="folder" className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{project.name}</span>
        {showDisk && (
          <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
            {t.billing.workspaces.diskUsage}:{" "}
            {project.diskMb == null
              ? "—"
              : `${formatBillingNumber(project.diskMb / 1024, locale)} GB`}
          </span>
        )}
      </span>
      <Icon name="arrow-up-right" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

function ProjectListDialog({
  projects,
  title,
  showDisk,
  onClose,
}: {
  projects: Project[];
  title: string;
  showDisk: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.dashboard.pages.projects;
  const titleId = useId();
  const [search, setSearch] = useState("");
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const filtered = projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      width="min(640px, calc(100vw - 2rem))"
      maxWidth="calc(100vw - 2rem)"
      maxHeight="calc(100dvh - 2rem)"
      overflow="hidden"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-col"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5">
          <h2 id={titleId} className="text-lg font-medium">
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t.billing.deployGate.close}
          >
            <Icon name="close" className="size-4" aria-hidden />
          </Button>
        </header>
        <div className="shrink-0 px-5 py-4">
          <Input
            variant="filled"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchPlaceholder}
          />
        </div>
        <div className="min-h-0 space-y-2 overflow-y-auto px-5 pb-5">
          {filtered.map((project) => (
            <ProjectLink key={project.id} project={project} showDisk={showDisk} />
          ))}
          {filtered.length === 0 && (
            <p role="status" className="py-6 text-center text-sm text-muted-foreground">
              {interpolate(copy.noResultsFound, { query: search })}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
