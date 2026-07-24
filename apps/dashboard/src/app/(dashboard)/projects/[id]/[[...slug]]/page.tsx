"use client";

import {
  MoreVertical,
  HelpCircle,
  MessageSquare,
  Bug,
  BookOpen,
  ExternalLink,
  Check,
  Plus,
  X,
  ChevronDown,
  GitBranch,
  Tag,
  Loader2,
  FilePlus2,
  Trash2,
} from "lucide-react";

import { DomainSettings } from "../components/DomainSettings";
import { GitSettings } from "../components/GitSettings";
import { BuildSettings } from "../components/BuildSettings";
import { LogsSettings } from "../components/LogsSettings";
import { BackupSettings } from "../components/BackupSettings";
import { Deployments } from "../components/Deployments";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { OverviewTab } from "../components/OverviewTab";
import { AppConfiguration } from "../components/AppConfiguration";
import { isSchemaAppTemplate } from "@/components/app-settings/AppSettingsForm";
import { ServicesTab } from "../components/ServicesTab";
import { ProjectSidebar, ProjectMobileTabs } from "../components/ProjectSidebar";
import { DraftProjectView } from "../components/DraftProjectView";
import { getProjectStatus } from "@/utils/project-status";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useProjectInfo } from "@/hooks/useProjectEndpoints";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ApiError, getApiErrorMessage, projectsApi } from "@/lib/api";
import ErrorState from "@/components/shared/ErrorState";
import { PageContainer } from "@/components/ui/PageContainer";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { DismissiblePopover } from "@/components/ui/Popover";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const branchToEnvironmentName = (branch: string) =>
  branch
    .split(/[/-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || branch;

const EnvironmentSwitcher = () => {
  const { projectData, environments, createEnvironment, activeTab } = useProjectSettings();
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [branches, setBranches] = useState<Array<{ name: string; sha?: string; protected?: boolean }>>([]);
  const [branchQuery, setBranchQuery] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState<string | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualEnvironmentName, setManualEnvironmentName] = useState("");
  const [manualBranch, setManualBranch] = useState("");
  const [branchesLoadedForProject, setBranchesLoadedForProject] = useState<string | null>(null);
  const branchRequestId = useRef(0);

  const options =
    environments.length > 0
      ? environments
      : [
          {
            id: projectData.id,
            name: projectData.environmentName || t.projects.env.productionFallback,
            slug: projectData.environmentSlug || "production",
            type: projectData.environmentType || "production",
            gitBranch: projectData.gitBranch || "main",
            isApp: !!projectData.isApp,
            version: null,
          },
      ];

  const currentEnvironment =
    options.find((env) => env.id === projectData.id) ?? options[0];

  const existingBranches = useMemo(
    () => new Set(options.map((env) => env.gitBranch).filter(Boolean)),
    [options],
  );

  const visibleBranches = useMemo<Array<{ name: string; sha?: string; protected?: boolean }>>(() => {
    const query = branchQuery.trim().toLowerCase();

    return branches.filter((branchOption) =>
      query ? branchOption.name.toLowerCase().includes(query) : true,
    );
  }, [branchQuery, branches]);

  const closeMenus = useCallback(() => {
    branchRequestId.current += 1;
    setIsOpen(false);
    setIsAdding(false);
    setManualMode(false);
    setBranchQuery("");
    setManualEnvironmentName("");
    setManualBranch("");
    setCreatingBranch(null);
    setLoadingBranches(false);
  }, []);

  const activateBranchCreator = useCallback((branchSeed?: string) => {
    setIsAdding(true);
    setIsOpen(false);
    setManualMode(false);
    setBranchQuery(branchSeed ?? "");
    setManualEnvironmentName("");
    setManualBranch("");
    setCreatingBranch(null);
  }, []);

  const openSwitcher = useCallback(() => {
    if (isOpen) {
      closeMenus();
      return;
    }

    setIsOpen(true);
    setIsAdding(false);
    setManualMode(false);
    setBranchQuery("");
    setManualEnvironmentName("");
    setManualBranch("");
    setCreatingBranch(null);
    setLoadingBranches(false);
  }, [closeMenus, isOpen]);

  const openBranchCreator = useCallback(() => {
    if (isAdding) {
      closeMenus();
      return;
    }

    activateBranchCreator();
  }, [activateBranchCreator, closeMenus, isAdding]);

  useEffect(() => {
    const shouldCreateEnvironment = searchParams.get("createEnvironment") === "1";
    if (!projectData.id || !shouldCreateEnvironment) return;

    activateBranchCreator(searchParams.get("branch")?.trim() || undefined);
    router.replace(`/projects/${projectData.id}/${activeTab}`);
  }, [activeTab, activateBranchCreator, projectData.id, router, searchParams]);

  useEffect(() => {
    setBranches([]);
    setBranchesLoadedForProject(null);
  }, [projectData.id]);

  useEffect(() => {
    if (!projectData.id || !isAdding || branchesLoadedForProject === projectData.id) return;

    const requestId = branchRequestId.current + 1;
    branchRequestId.current = requestId;
    setLoadingBranches(true);

    projectsApi
      .getBranches(projectData.id)
      .then((response) => {
        if (branchRequestId.current !== requestId) return;
        const data = Array.isArray(response.data)
          ? response.data
          : Array.isArray(response.data?.data)
            ? response.data.data
          : Array.isArray(response.branches)
            ? response.branches
            : [];
        setBranches(
          data.map((branchOption: any) =>
            typeof branchOption === "string"
              ? { name: branchOption }
              : {
                  name: branchOption.name,
                  sha: branchOption.sha,
                  protected: branchOption.protected,
                },
          ).filter((branchOption: { name?: string }) => branchOption.name),
        );
      })
      .catch((error) => {
        if (branchRequestId.current !== requestId) return;
        const message = error instanceof Error ? error.message : t.projects.env.failedLoadBranches;
        showToast(message, "error", t.projects.env.toastBranchesTitle);
      })
      .finally(() => {
        if (branchRequestId.current !== requestId) return;
        setBranchesLoadedForProject(projectData.id);
        setLoadingBranches(false);
      });

    return () => {
      if (branchRequestId.current === requestId) {
        branchRequestId.current += 1;
      }
    };
  }, [branchesLoadedForProject, isAdding, projectData.id, showToast]);

  if (!projectData.id) return null;

  const handleSwitch = (projectId: string) => {
    if (!projectId || projectId === projectData.id) return;
    closeMenus();
    router.push(`/projects/${projectId}/${activeTab}`);
  };

  const handleAddBranch = async (selectedBranch: string) => {
    if (!selectedBranch || isCreating) return;

    const existing = options.find((env) => env.gitBranch === selectedBranch);
    if (existing) {
      handleSwitch(existing.id);
      return;
    }

    setCreatingBranch(selectedBranch);
    setIsCreating(true);

    try {
      const created = await createEnvironment({
        environmentName: branchToEnvironmentName(selectedBranch),
        environmentType: selectedBranch === "main" || selectedBranch === "master" ? "production" : "preview",
        gitBranch: selectedBranch,
        sourceMode: "branch",
      });
      if (created?.id) {
        closeMenus();
        router.push(`/projects/${created.id}/${activeTab}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t.projects.env.failedCreateEnvironment;
      showToast(message, "error", t.projects.env.toastEnvironmentTitle);
    } finally {
      setIsCreating(false);
      setCreatingBranch(null);
    }
  };

  const handleAddManual = async () => {
    const environmentName = manualEnvironmentName.trim();
    const customBranch = manualBranch.trim();

    if (!environmentName || isCreating) return;

    setIsCreating(true);

    try {
      const created = await createEnvironment({
        environmentName,
        environmentType: "development",
        gitBranch: customBranch || undefined,
        sourceMode: "manual",
      });
      if (created?.id) {
        closeMenus();
        router.push(`/projects/${created.id}/${activeTab}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t.projects.env.failedCreateEnvironment;
      showToast(message, "error", t.projects.env.toastEnvironmentTitle);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <DismissiblePopover
      open={isOpen || isAdding}
      onOpenChange={(open) => {
        if (!open) closeMenus();
      }}
      className="relative flex items-center gap-2"
    >
      <button
        type="button"
        onClick={openSwitcher}
        className="inline-flex h-9 max-w-[260px] items-center gap-2 rounded-full border border-border/50 bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
        aria-label={t.projects.env.switchAria}
      >
        <span className="truncate">{currentEnvironment.name}</span>
        {currentEnvironment.isApp ? (
          currentEnvironment.version ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <Tag className="size-3" />
              <span className="truncate">{currentEnvironment.version}</span>
            </span>
          ) : null
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <GitBranch className="size-3" />
            <span className="truncate">{currentEnvironment.gitBranch}</span>
          </span>
        )}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <button
        type="button"
        onClick={openBranchCreator}
        className="inline-flex size-9 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        aria-label={t.projects.env.addBranchAria}
      >
        {isAdding ? <X className="size-4" /> : <Plus className="size-4" />}
      </button>

      {isOpen && (
        <div
          className="absolute end-11 top-full z-40 mt-2 w-[320px] overflow-hidden rounded-lg border border-border/50 shadow-xl"
          style={{ backgroundColor: "var(--th-card-bg-solid, var(--card))" }}
        >
          <div className="max-h-[320px] overflow-y-auto p-1">
            {options.map((env) => {
              const active = env.id === projectData.id;

              return (
                <button
                  key={env.id}
                  type="button"
                  onClick={() => handleSwitch(env.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-start transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{env.name}</span>
                    {env.isApp ? (
                      env.version ? (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Tag className="size-3" />
                          <span className="truncate">{env.version}</span>
                        </span>
                      ) : null
                    ) : (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <GitBranch className="size-3" />
                        <span className="truncate">{env.gitBranch}</span>
                      </span>
                    )}
                  </span>
                  {active && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {isAdding && (
        <div
          className="absolute end-0 top-full z-40 mt-2 w-[340px] rounded-lg border border-border/50 p-2 shadow-xl"
          style={{ backgroundColor: "var(--th-card-bg-solid, var(--card))" }}
        >
          <div className="space-y-2">
            <input
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
              placeholder={t.projects.env.searchBranches}
              className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/40"
            />
            <div className="max-h-[280px] overflow-y-auto">
              {loadingBranches ? (
                <div className="flex h-24 items-center justify-center text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : visibleBranches.length > 0 ? (
                visibleBranches.map((branchOption) => {
                  const exists = existingBranches.has(branchOption.name);
                  const creating = creatingBranch === branchOption.name;

                  return (
                    <button
                      key={branchOption.name}
                      type="button"
                      onClick={() => handleAddBranch(branchOption.name)}
                      disabled={isCreating && !creating}
                      className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-start transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {branchOption.name}
                          </span>
                          {branchOption.sha && (
                            <span className="text-xs text-muted-foreground">
                              {branchOption.sha.slice(0, 7)}
                            </span>
                          )}
                        </span>
                      </span>
                      {creating ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                      ) : exists ? (
                        <Check className="size-4 shrink-0 text-primary" />
                      ) : (
                        <Plus className="size-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {t.projects.env.noBranches}
                </div>
              )}
            </div>
            <div className="border-t border-border/50 pt-2">
              {manualMode ? (
                <div className="space-y-2">
                  <input
                    value={manualEnvironmentName}
                    onChange={(event) => setManualEnvironmentName(event.target.value)}
                    placeholder={t.projects.env.environmentName}
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/40"
                  />
                  <input
                    value={manualBranch}
                    onChange={(event) => setManualBranch(event.target.value)}
                    placeholder={t.projects.env.branchLabel}
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/40"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setManualMode(false)}
                      className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      {t.projects.env.cancel}
                    </button>
                    <button
                      type="button"
                      onClick={handleAddManual}
                      disabled={!manualEnvironmentName.trim() || isCreating}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isCreating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                      {t.projects.env.create}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setManualMode(true)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                >
                  <FilePlus2 className="size-4 text-muted-foreground" />
                  {t.projects.env.manualEnvironment}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </DismissiblePopover>
  );
};

const ProjectSettingsContent = () => {
  const {
    projectData,
    setProjectData,
    projectNotFound,
    errorType,
    activeTab,
    tabs,
    id,
  } = useProjectSettings();
  // Project shell waits for project info specifically (not analytics).
  // Analytics is per-card now; the page-level gate is about whether we
  // know enough about the project to even render its tabs.
  const { isLoading: isLoadingProjectInfo, error: projectInfoError } = useProjectInfo(id);

  const { t } = useI18n();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const router = useRouter();

  // Keep the delete state honest: while this project reads as "deleting"
  // (server flag or optimistic), poll for completion so a finished teardown
  // (row gone) navigates away instead of leaving a stale "Deleting" page open.
  // Read-only — never overwrites the in-flight optimistic state.
  const isDeleting = getProjectStatus(projectData) === "deleting";
  useEffect(() => {
    if (!id || !isDeleting) return;
    const iv = setInterval(async () => {
      try {
        await projectsApi.getInfo(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          clearInterval(iv);
          showToast(t.projects.delete.alreadyDeleted, "success");
          router.push("/");
        }
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [id, isDeleting, router, showToast, t.projects.delete.alreadyDeleted]);

  const handleDeleteProject = async (
    deleteApp = true,
    wipeVolumes = false,
    // Record-only (soft) delete — kept ahead of force/forceOrphan so the delete
    // modal's (deleteApp, wipeVolumes, recordOnly) call maps positionally, and
    // so it survives the force/forceOrphan retries below.
    recordOnly = false,
    force = false,
    forceOrphan = false,
  ) => {
    // Optimistic - immediately show "Deleting" status
    setProjectData((prev: any) => ({ ...prev, deletedAt: new Date().toISOString() }));

    try {
      const response = await projectsApi.delete(projectData.id, {
        deleteApp,
        wipeVolumes,
        recordOnly,
        force,
        forceOrphan,
      });
      // 200: full success. 207 (partial success — row deleted but some
      // external cleanup failed) lands here too because ApiClient only
      // throws on >=400. Surface it as a warning toast and STILL leave
      // the project page so the user doesn't dwell on a half-deleted
      // resource.
      if (response.ok) {
        // Enforced delete: the server was unreachable, so its resources were
        // recorded for GC and will be reclaimed once it's back.
        const orphanCount = Array.isArray(response.orphaned) ? response.orphaned.length : 0;
        if (orphanCount > 0) {
          showToast(
            interpolate(t.projects.delete.orphanCleanup, { count: String(orphanCount) }),
            "success",
            t.projects.delete.orphanCleanupTitle,
          );
        } else {
          showToast(
            deleteApp ? t.projects.delete.successProject : t.projects.delete.successEnvironment,
            "success",
          );
        }
        router.push("/");
        return;
      }
      // 207: rowDeleted=true but unrecoverable steps surfaced. Toast as
      // "success" because the row IS gone — the warning content lives in
      // the title + body. router.push so the user doesn't see a ghost.
      if (Array.isArray(response.unrecoverable) && response.unrecoverable.length > 0) {
        console.warn("[delete-project] partial cleanup", response.unrecoverable);
        showToast(
          interpolate(t.projects.delete.partialCleanup, {
            count: String(response.unrecoverable.length),
          }),
          "success",
          t.projects.delete.partialCleanupTitle,
        );
        router.push("/");
        return;
      }
      // Defensive: 2xx with ok=false but no unrecoverable list. Treat as failure.
      setProjectData((prev: any) => ({ ...prev, deletedAt: null }));
      showToast(
        response.message || response.error || t.projects.delete.failed,
        "error",
        t.projects.delete.failed,
      );
    } catch (err) {
      // Always revert optimistic deletion on any failure - project still exists.
      setProjectData((prev: any) => ({ ...prev, deletedAt: null }));

      if (err instanceof ApiError && err.status === 409) {
        const body = (err.body ?? {}) as {
          code?: string;
          error?: string;
          message?: string;
          active?: Record<string, unknown>;
          canForceOrphan?: boolean;
          unrecoverable?: Array<{ step: string; error?: string }>;
        };
        // Graceful gate hit — there's active work (an in-flight deployment,
        // backup, or restore). The user already confirmed by typing the project
        // name, so escalate to a force teardown: the backend cancels the
        // in-flight work, waits for it to quiesce, then tears down and deletes.
        // Guard on `!force` so a forced call that somehow still reports active
        // work can't loop.
        if (body.code === "PROJECT_HAS_ACTIVE_WORK") {
          if (!force) {
            showToast(t.projects.delete.cancellingActiveWork, "success", t.projects.delete.cleaningUpTitle);
            void handleDeleteProject(deleteApp, wipeVolumes, recordOnly, true, forceOrphan);
            return;
          }
          showToast(
            body.error ?? t.projects.delete.hasActiveWork,
            "error",
            t.projects.delete.cannotDeleteTitle,
          );
          return;
        }
        if (body.code === "PROJECT_DELETION_IN_PROGRESS") {
          showToast(
            t.projects.delete.deletionInProgress,
            "error",
            t.projects.delete.deletionInProgressTitle,
          );
          return;
        }
        // Teardown ran but couldn't complete (row not deleted). Only happens
        // now when the server is REACHABLE but a destroy kept failing —
        // `canForceOrphan` lets the user drop the row anyway and let GC reclaim
        // the leaked resources later.
        const reasons = (body.unrecoverable ?? []).map((u) => u.step).join(", ");
        console.error("[delete-project] teardown failed", body.unrecoverable);
        // The source teardown couldn't complete. Rather than a jarring
        // window.confirm (or silently reverting to a plain "Draft"), surface a
        // themed module offering the storage-only delete (forceOrphan) — atomic
        // delete stays the default; this is the explicit bypass.
        if (body.canForceOrphan) {
          let modalId = "";
          modalId = showModal({
            maxWidth: "480px",
            customContent: (
              <div className="p-6 space-y-5">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-danger-bg text-danger">
                    <Trash2 className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-foreground">
                      {t.projects.delete.forceModalTitle}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {t.projects.delete.forceModalBody}
                    </p>
                    {reasons && (
                      <p className="mt-2 text-xs text-muted-foreground/70">{reasons}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => hideModal(modalId)}
                    className="inline-flex h-9 items-center rounded-xl px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  >
                    {t.projects.delete.forceModalCancel}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      hideModal(modalId);
                      void handleDeleteProject(deleteApp, wipeVolumes, recordOnly, force, true);
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-danger-solid px-4 text-sm font-medium text-white transition-colors hover:bg-danger-solid/90"
                  >
                    <Trash2 className="size-3.5" />
                    {t.projects.delete.forceModalConfirm}
                  </button>
                </div>
              </div>
            ),
          });
          return;
        }
        showToast(
          reasons
            ? interpolate(t.projects.delete.teardownFailedAt, { reasons })
            : body.message || body.error || t.projects.delete.teardownFailed,
          "error",
          t.projects.delete.cleanupFailedTitle,
        );
        return;
      }

      // 404: someone else already deleted the project in another tab.
      if (err instanceof ApiError && err.status === 404) {
        showToast(t.projects.delete.alreadyDeleted, "success");
        router.push("/");
        return;
      }

      showToast(getApiErrorMessage(err, t.projects.delete.failed), "error", t.projects.delete.failed);
    }
  };

  const helpMenuActions: MenuAction[] = [
    {
      id: "support",
      label: t.projects.help.contactSupport,
      icon: <HelpCircle className="w-4 h-4" />,
      onClick: () => {
        window.open("https://openship.io/support", "_blank");
      },
    },
    {
      id: "report-issue",
      label: t.projects.help.reportIssue,
      icon: <Bug className="w-4 h-4" />,
      onClick: () => {
        window.open("https://github.com/oblien/openship/deployments/issues/new", "_blank");
      },
    },
    {
      id: "feedback",
      label: t.projects.help.sendFeedback,
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => {
        window.open("https://openship.io/contact", "_blank");
      },
    },
    {
      id: "divider",
      divider: true,
    },
    {
      id: "documentation",
      label: t.projects.help.documentation,
      icon: <BookOpen className="w-4 h-4" />,
      onClick: () => {
        window.open("https://openship.io/docs", "_blank");
      },
    },
    {
      id: "community",
      label: t.projects.help.joinCommunity,
      icon: <ExternalLink className="w-4 h-4" />,
      onClick: () => {
        window.open("https://discord.gg/Q9eWNCeXjg", "_blank");
      },
    },
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview":
        return <OverviewTab />;
      case "services":
        return <ServicesTab />;
      case "domains":
        return <DomainSettings />;
      case "deployments":
        return <Deployments />;
      case "source":
      case "git":
        return <GitSettings />;
      case "runtime":
      case "settings":
        // Apps get the 2-mode Configuration surface (App settings | Deployment);
        // regular projects get the raw build/runtime config.
        return projectData.isApp && isSchemaAppTemplate(projectData.appTemplateId) ? (
          <AppConfiguration />
        ) : (
          <BuildSettings />
        );
      case "logs":
        return <LogsSettings />;
      case "backup":
        return <BackupSettings />;
      case "advanced":
        return (
          <div className="space-y-5">
            <AdvancedSettings onDeleteProject={handleDeleteProject} />
          </div>
        );
      default:
        return <OverviewTab />;
    }
  };

  if (projectNotFound) {
    return <ErrorState type={errorType || "project-not-found"} />;
  }

  // `projectData` (context state) is re-seeded from the fetch one tick AFTER
  // isLoadingProjectInfo flips false (via an effect in the provider). During
  // that lag it's still the empty seed (id: "") whose derived status is
  // "draft" — rendering it would flash the DraftProjectView for a frame before
  // the real project lands. Treat "data hasn't caught up to this id yet" as
  // still-loading. The `!projectInfoError` guard avoids an infinite skeleton
  // when the fetch genuinely failed (non-404) and the seed will never arrive.
  const projectDataReady = projectData.id === id;
  if (isLoadingProjectInfo || (!projectDataReady && !projectInfoError)) {
    // Mirror the post-load shell (header + two-column grid) so the
    // page doesn't jump when data lands. The right column gets its
    // own placeholder card to reserve the 340px track.
    return (
      <PageContainer>
        <div className="mb-6">
          <div className="flex items-center space-x-2 rtl:space-x-reverse text-sm text-muted-foreground mb-2">
            <div className="h-3 w-20 bg-muted/60 rounded animate-pulse" />
            <span>/</span>
            <div className="h-3 w-32 bg-muted/60 rounded animate-pulse" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="h-7 w-40 bg-muted rounded animate-pulse" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* ── LEFT COLUMN skeleton ── */}
          <div className="space-y-5 min-w-0">
            <div className="bg-card rounded-2xl border border-border/50 p-6 animate-pulse">
              <div className="h-5 w-48 bg-muted rounded-lg mb-2" />
              <div className="h-4 w-32 bg-muted/60 rounded-lg" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse"
                >
                  <div className="h-3 w-20 bg-muted rounded mb-4" />
                  <div className="space-y-3">
                    {[1, 2, 3, 4].map((j) => (
                      <div key={j} className="flex justify-between">
                        <div className="h-3 w-16 bg-muted/60 rounded" />
                        <div className="h-3 w-24 bg-muted/60 rounded" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── RIGHT COLUMN skeleton ── */}
          <div className="hidden lg:block">
            <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
              <div className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
                <div className="h-3 w-16 bg-muted/60 rounded mb-3" />
                <div className="h-5 w-40 bg-muted rounded" />
              </div>
              <div className="bg-card rounded-2xl border border-border/50 p-3 space-y-1 animate-pulse">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <div key={i} className="h-9 w-full bg-muted/40 rounded-lg" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }
  // Draft / never-successfully-deployed projects (no active deployment)
  // get a focused screen instead of the analytics dashboard, which would
  // otherwise render empty. In-flight first builds (queued/building/
  // deploying) and live projects fall through to the normal layout.
  const status = getProjectStatus(projectData);
  const isNeverDeployed =
    ["draft", "failed", "cancelled"].includes(status) ||
    // A draft mid-delete: the optimistic `deletedAt` masks the draft status
    // as "deleting". Keep the focused draft screen (its own delete spinner
    // handles the pending state) instead of flipping to the analytics
    // dashboard for the duration of the teardown. A never-deployed project
    // has no activeDeploymentId — that's the discriminator vs. a live delete.
    (status === "deleting" && !projectData.activeDeploymentId);
  if (isNeverDeployed && activeTab === "overview") {
    return (
      <PageContainer>
        <div className="mb-6">
          <div className="flex items-center space-x-2 rtl:space-x-reverse text-sm text-muted-foreground mb-2">
            <Link href="/" className="hover:text-foreground transition-colors font-medium">
              {t.projects.detail.breadcrumbDashboard}
            </Link>
            <span>/</span>
            <span className="text-foreground font-medium">{projectData.name || t.projects.detail.projectFallback}</span>
          </div>
          {/* Logo intentionally omitted here — it lives in the DraftProjectView
              hero card below; showing it in both duplicates it. */}
          <h1 className="text-2xl font-semibold text-foreground truncate">
            {projectData.name || t.projects.detail.projectFallback}
          </h1>
        </div>
        <DraftProjectView onDeleteProject={() => handleDeleteProject()} />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Compact Header */}
      <div className="mb-6">
        <div className="flex items-center space-x-2 rtl:space-x-reverse text-sm text-muted-foreground mb-2">
          <Link href="/" className="hover:text-foreground transition-colors font-medium">
            {t.projects.detail.breadcrumbDashboard}
          </Link>
          <span>/</span>
          <Link
            href={`/projects/${projectData.id || "projectId"}/overview`}
            className="hover:text-foreground transition-colors font-medium"
          >
            {projectData.name || t.projects.detail.projectFallback}
          </Link>
          {activeTab !== "overview" && (
            <>
              <span>/</span>
              <span className="text-foreground font-medium">
                {tabs.find((tab) => tab.id === activeTab)?.label}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-foreground truncate">
              {tabs.find((tab) => tab.id === activeTab)?.label || t.projects.detail.overviewFallback}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <EnvironmentSwitcher />
            <DropdownMenu
              actions={helpMenuActions}
              trigger={<MoreVertical className="w-5 h-5 text-muted-foreground" />}
              align="right"
            />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        {/* ── LEFT COLUMN ── */}
        <div className="space-y-6 min-w-0">
          <ProjectMobileTabs />
          {renderTabContent()}
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className="hidden lg:block">
          <ProjectSidebar />
        </div>
      </div>
    </PageContainer>
  );
};

export default ProjectSettingsContent;
