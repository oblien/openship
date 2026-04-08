import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitCommit,
  Github,
  Link2,
  Loader2,
  Webhook,
  Zap,
} from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { formatDate } from "@/utils/date";
import { projectsApi } from "@/lib/api";

export const GitSettings = () => {
  const { gitData, refreshGit, id } = useProjectSettings();
  const [isTogglingAutoDeploy, setIsTogglingAutoDeploy] = useState(false);
  const hasRefreshed = useRef(false);

  useEffect(() => {
    if (!hasRefreshed.current) {
      hasRefreshed.current = true;
      refreshGit();
    }
  }, [refreshGit]);

  const handleAutoDeployToggle = async () => {
    setIsTogglingAutoDeploy(true);
    try {
      const newState = !gitData.autoDeployEnabled;
      const response = await projectsApi.setAutoDeploy(id, newState);
      if (response.success) {
        await refreshGit();
      }
    } catch (error) {
      console.error("Failed to toggle auto-deploy:", error);
    } finally {
      setIsTogglingAutoDeploy(false);
    }
  };

  if (gitData.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <LoadingCard />
          <LoadingCard />
        </div>
        <div>
          <LoadingCard />
        </div>
      </div>
    );
  }

  if (!gitData.repository) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-muted/40">
          <Github className="size-6 text-muted-foreground/50" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-foreground">Repository not connected</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a source repository to enable automatic deployments and commit history.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_320px]">
      <div className="space-y-5">
        <SectionCard
          title="Source Repository"
          description="Git integration, deployment triggers, and repository health"
          icon={Github}
          iconTone="primary"
        >
          <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">Repository</div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-foreground">{gitData.repository.name}</div>
                <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                  <GitBranch className="size-3.5" />
                  <span>{gitData.branch || "main"}</span>
                </div>
              </div>
              <a
                href={gitData.repository.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-foreground/[0.06] px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
              >
                <ExternalLink className="size-3.5" />
                Open
              </a>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <InfoCard
              icon={Zap}
              title="Auto Deploy"
              value={gitData.autoDeployEnabled ? "Enabled" : "Disabled"}
              description={gitData.autoDeployEnabled ? "Pushes trigger deployments automatically" : "Deployments must be started manually"}
              action={
                <button
                  type="button"
                  role="switch"
                  aria-checked={gitData.autoDeployEnabled}
                  onClick={handleAutoDeployToggle}
                  disabled={isTogglingAutoDeploy}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${gitData.autoDeployEnabled ? "bg-primary" : "bg-muted"} ${isTogglingAutoDeploy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                >
                  {isTogglingAutoDeploy ? (
                    <span className="mx-auto">
                      <Loader2 className="size-3.5 animate-spin text-background" />
                    </span>
                  ) : (
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${gitData.autoDeployEnabled ? "translate-x-6" : "translate-x-1"}`} />
                  )}
                </button>
              }
            />
            <InfoCard
              icon={Webhook}
              title="Webhook"
              value={gitData.webhookActive ? "Active" : "Inactive"}
              description={gitData.webhookActive ? "Repository events are reaching Openship" : "Webhook has not been configured or is not responding"}
              tone={gitData.webhookActive ? "success" : "neutral"}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Recent Commits"
          description="Latest repository activity connected to this project"
          icon={GitCommit}
          iconTone="orange"
        >
          {gitData.recentCommits.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-5 text-center">
              <p className="text-sm font-medium text-foreground">No commits found</p>
              <p className="mt-1 text-sm text-muted-foreground">Push to your repository and recent commit activity will appear here.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
              {gitData.recentCommits.slice(0, 8).map((commit: any) => (
                <div key={commit.id} className="px-4 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="rounded-full bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{commit.id?.slice(0, 7)}</code>
                        <StatusChip status={commit.status} />
                      </div>
                      <p className="mt-2 break-words text-sm font-medium text-foreground">{commit.message}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                        <span>{commit.author}</span>
                        <span className="text-muted-foreground/40">·</span>
                        <span>{formatDate(commit.time, undefined, undefined, true)}</span>
                        {commit.files ? (
                          <>
                            <span className="text-muted-foreground/40">·</span>
                            <span>{commit.files} file{commit.files !== 1 ? "s" : ""} changed</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {commit.url ? (
                      <a
                        href={commit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10"
                      >
                        <Link2 className="size-3.5" />
                        View
                      </a>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="space-y-5 xl:sticky xl:top-6 xl:self-start">
        <SectionCard
          title="Integration Status"
          description="Current source control connection health"
          icon={CheckCircle2}
          iconTone="emerald"
        >
          <MetricRow label="Provider" value="GitHub" />
          <MetricRow label="Repository" value={gitData.repository.name} />
          <MetricRow label="Branch" value={gitData.branch || "main"} />
          <MetricRow label="Webhook" value={gitData.webhookActive ? "Active" : "Inactive"} />
        </SectionCard>
      </div>
    </div>
  );
};

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-emerald-500/10 text-emerald-500",
  orange: "bg-orange-500/10 text-orange-500",
} as const;

function SectionCard({
  title,
  description,
  icon: Icon,
  iconTone,
  children,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconTone: keyof typeof ICON_TONES;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5 animate-pulse">
      <div className="h-4 w-28 rounded bg-muted/50" />
      <div className="mt-4 space-y-3">
        <div className="h-10 rounded-xl bg-muted/40" />
        <div className="h-10 rounded-xl bg-muted/40" />
        <div className="h-10 rounded-xl bg-muted/40" />
      </div>
    </div>
  );
}

function InfoCard({
  icon: Icon,
  title,
  value,
  description,
  action,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  description: string;
  action?: React.ReactNode;
  tone?: "neutral" | "success";
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone === "success" ? "bg-emerald-500/10 text-emerald-500" : "bg-primary/10 text-primary"}`}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">{title}</p>
            <p className="mt-1 text-[13px] font-semibold text-foreground">{value}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="max-w-[180px] truncate text-right text-[13px] font-medium text-foreground">{value}</span>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    failed: "bg-red-500/10 text-red-600 dark:text-red-400",
    pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[status] || "bg-muted/50 text-muted-foreground"}`}>
      {status}
    </span>
  );
}