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
  Loader2,
  FilePlus2,
} from "lucide-react";

import { DomainSettings } from "../components/DomainSettings";
import { GitSettings } from "../components/GitSettings";
import { BuildSettings } from "../components/BuildSettings";
import { LogsSettings } from "../components/LogsSettings";
import { Deployments } from "../components/Deployments";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { OverviewTab } from "../components/OverviewTab";
import { ServicesTab } from "../components/ServicesTab";
import { ProjectSidebar, ProjectMobileTabs } from "../components/ProjectSidebar";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";
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
  const router = useRouter();
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
            name: projectData.environmentName || "Production",
            slug: projectData.environmentSlug || "production",
            type: projectData.environmentType || "production",
            gitBranch: projectData.gitBranch || "main",
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

    setIsAdding(true);
    setIsOpen(false);
    setManualMode(false);
    setBranchQuery("");
    setManualEnvironmentName("");
    setManualBranch("");
    setCreatingBranch(null);
  }, [closeMenus, isAdding]);

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
        const message = error instanceof Error ? error.message : "Failed to load branches";
        showToast(message, "error", "Branches");
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
      const message = error instanceof Error ? error.message : "Failed to create environment";
      showToast(message, "error", "Environment");
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
      const message = error instanceof Error ? error.message : "Failed to create environment";
      showToast(message, "error", "Environment");
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
        aria-label="Switch environment"
      >
        <span className="truncate">{currentEnvironment.name}</span>
        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <GitBranch className="size-3" />
          <span className="truncate">{currentEnvironment.gitBranch}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <button
        type="button"
        onClick={openBranchCreator}
        className="inline-flex size-9 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        aria-label="Add branch"
      >
        {isAdding ? <X className="size-4" /> : <Plus className="size-4" />}
      </button>

      {isOpen && (
        <div className="absolute right-11 top-full z-40 mt-2 w-[320px] overflow-hidden rounded-lg border border-border/50 bg-card shadow-xl">
          <div className="max-h-[320px] overflow-y-auto p-1">
            {options.map((env) => {
              const active = env.id === projectData.id;

              return (
                <button
                  key={env.id}
                  type="button"
                  onClick={() => handleSwitch(env.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{env.name}</span>
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <GitBranch className="size-3" />
                      <span className="truncate">{env.gitBranch}</span>
                    </span>
                  </span>
                  {active && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {isAdding && (
        <div className="absolute right-0 top-full z-40 mt-2 w-[340px] rounded-lg border border-border/50 bg-card p-2 shadow-xl">
          <div className="space-y-2">
            <input
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
              placeholder="Search branches"
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
                      className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
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
                  No branches found
                </div>
              )}
            </div>
            <div className="border-t border-border/50 pt-2">
              {manualMode ? (
                <div className="space-y-2">
                  <input
                    value={manualEnvironmentName}
                    onChange={(event) => setManualEnvironmentName(event.target.value)}
                    placeholder="Environment name"
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/40"
                  />
                  <input
                    value={manualBranch}
                    onChange={(event) => setManualBranch(event.target.value)}
                    placeholder="Branch label"
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/40"
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setManualMode(false)}
                      className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleAddManual}
                      disabled={!manualEnvironmentName.trim() || isCreating}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isCreating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                      Create
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setManualMode(true)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                >
                  <FilePlus2 className="size-4 text-muted-foreground" />
                  Manual environment
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
    isLoadingAnalytics,
  } = useProjectSettings();

  const isServicesProject = tabs[0]?.id === "services";

  const { showToast } = useToast();
  const router = useRouter();

  const handleDeleteProject = async (deleteApp = true) => {
    // Optimistic - immediately show "Deleting" status
    setProjectData((prev: any) => ({ ...prev, deletedAt: new Date().toISOString() }));

    const response = await projectsApi.delete(projectData.id, { deleteApp });
    if (response.success) {
      showToast(deleteApp ? "Project deleted successfully" : "Environment deleted successfully", "success");
      router.push("/");
    } else {
      // Revert on failure
      setProjectData((prev: any) => ({ ...prev, deletedAt: null }));
      showToast(response.message || response.error, "error", "Failed to delete project");
    }
  };

  const helpMenuActions: MenuAction[] = [
    {
      id: "support",
      label: "Contact Support",
      icon: <HelpCircle className="w-4 h-4" />,
      onClick: () => {
        window.open("https://oblien.com/support", "_blank");
      },
    },
    {
      id: "report-issue",
      label: "Report Issue",
      icon: <Bug className="w-4 h-4" />,
      onClick: () => {
        window.open("https://github.com/oblien/deployments/issues/new", "_blank");
      },
    },
    {
      id: "feedback",
      label: "Send Feedback",
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => {
        window.open("https://oblien.com/feedback", "_blank");
      },
    },
    {
      id: "divider",
      divider: true,
    },
    {
      id: "documentation",
      label: "Documentation",
      icon: <BookOpen className="w-4 h-4" />,
      onClick: () => {
        window.open("https://oblien.com/docs", "_blank");
      },
    },
    {
      id: "community",
      label: "Join Community",
      icon: <ExternalLink className="w-4 h-4" />,
      onClick: () => {
        window.open("https://discord.gg/oblien", "_blank");
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
        return <BuildSettings />;
      case "logs":
        return <LogsSettings />;
      case "advanced":
        return <AdvancedSettings onDeleteProject={handleDeleteProject} />;
      default:
        return isServicesProject ? <ServicesTab /> : <OverviewTab />;
    }
  };

  if (projectNotFound) {
    return <ErrorState type={errorType || "project-not-found"} />;
  }

  if (isLoadingAnalytics) {
    return (
      <PageContainer fullScreen={false}>
        <div className="space-y-5 py-6">
          {/* Skeleton cards */}
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
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      {/* Compact Header */}
      <div className="mb-6">
        <div className="flex items-center space-x-2 text-sm text-muted-foreground mb-2">
          <Link href="/" className="hover:text-foreground transition-colors font-medium">
            Dashboard
          </Link>
          <span>/</span>
          <Link
            href={`/projects/${projectData.id || "projectId"}/overview`}
            className="hover:text-foreground transition-colors font-medium"
          >
            {projectData.name || "Project"}
          </Link>
          {activeTab !== "overview" && (
            <>
              <span>/</span>
              <span className="text-foreground font-medium">
                {tabs.find((t) => t.id === activeTab)?.label}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-foreground truncate">
              {tabs.find((t) => t.id === activeTab)?.label || "Overview"}
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
