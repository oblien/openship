"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  getApiErrorMessage,
  projectsApi,
  registriesApi,
  swarmApi,
  systemApi,
  type ContainerRegistry,
  type SwarmDiscoveryView,
  type SwarmNode,
  type SwarmStackDetail,
  type SwarmSummary,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import {
  HealthBadge,
  formatObservedAt,
  shortId,
  SwarmNodesTable,
  SwarmTasksTable,
} from "@/components/swarm/SwarmReadOnlyViews";

type SwarmSnapshot = {
  summary: SwarmSummary;
  discovery: SwarmDiscoveryView;
  nodes: SwarmNode[];
};

type SwarmManagerCandidate = {
  serverId: string;
  label: string;
  summary: SwarmSummary;
};

const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

function suggestedStackName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 63);
}

function isRelativeRepositoryPath(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  return (
    !!normalized &&
    !normalized.startsWith("/") &&
    !normalized.includes("\u0000") &&
    !normalized.split("/").some((part) => part === "" || part === "..")
  );
}

export function SwarmTab({ serverId }: { serverId: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStack, setSelectedStack] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmStackDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [confirmStack, setConfirmStack] = useState<string | null>(null);
  const [importingStack, setImportingStack] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary, discovery, nodes] = await Promise.all([
        swarmApi.summary(serverId),
        swarmApi.stacks(serverId),
        swarmApi.nodes(serverId),
      ]);
      setSnapshot({ summary, discovery, nodes: nodes.nodes });
    } catch (cause) {
      setSnapshot(null);
      setError(getApiErrorMessage(cause, "Unable to inspect Docker Swarm on this server."));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showStack = useCallback(
    async (stackName: string) => {
      if (selectedStack === stackName) {
        setSelectedStack(null);
        setDetail(null);
        return;
      }
      setSelectedStack(stackName);
      setLoadingDetail(true);
      try {
        setDetail(await swarmApi.stack(serverId, stackName));
      } catch (cause) {
        setDetail(null);
        showToast(
          getApiErrorMessage(cause, "Unable to load stack details."),
          "error",
          "Docker Swarm",
        );
      } finally {
        setLoadingDetail(false);
      }
    },
    [selectedStack, serverId, showToast],
  );

  const observe = useCallback(
    async (stackName: string) => {
      setImportingStack(stackName);
      try {
        const imported = await swarmApi.observe(serverId, stackName);
        showToast(
          imported.created
            ? "Stack is now observed read-only."
            : "This stack is already observed by this organization.",
          "success",
          "Docker Swarm",
        );
        router.push(`/projects/${imported.projectId}/overview`);
      } catch (cause) {
        showToast(
          getApiErrorMessage(cause, "Unable to import this stack."),
          "error",
          "Docker Swarm",
        );
      } finally {
        setImportingStack(null);
        setConfirmStack(null);
      }
    },
    [router, serverId, showToast],
  );

  if (loading) {
    return <LoadingCard />;
  }

  if (error || !snapshot) {
    const managerRequired = /manager|required|inactive/i.test(error || "");
    return (
      <section className="rounded-2xl border border-border/50 bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning">
            <TriangleAlert className="size-4" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Docker Swarm unavailable</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {managerRequired
                ? "This endpoint is not an active Swarm manager. Connect an active manager to browse cluster stacks."
                : error || "OpenShip could not inspect this Docker Swarm manager."}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <RefreshCw className="size-3.5" /> Retry inspection
            </button>
          </div>
        </div>
      </section>
    );
  }

  const { summary, discovery, nodes } = snapshot;
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-primary/25 bg-primary/[0.04] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Boxes className="size-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-foreground">Docker Swarm</h2>
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                  Experimental
                </span>
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Inspect existing stacks without changing them, or reserve a new stack namespace and
                configure its authoritative source before the first reviewed apply.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            <RefreshCw className="size-3.5" /> Refresh
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-success" />
          <h2 className="text-sm font-semibold text-foreground">Manager health</h2>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Cluster" value={shortId(summary.manager.clusterId)} mono />
          <Metric
            label="Manager"
            value={summary.manager.managerAddress || summary.manager.nodeAddress || "Connected"}
          />
          <Metric label="Nodes" value={String(nodes.length)} />
          <Metric label="Stacks" value={String(discovery.stacks.length)} />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Engine {summary.manager.engineVersion || "unknown"} · Last observed{" "}
          {formatObservedAt(discovery.observedAt)}
        </p>
        {discovery.diagnostics.length > 0 && (
          <p className="mt-3 text-sm text-warning">
            Some metadata could not be read:{" "}
            {discovery.diagnostics.map((item) => item.resource).join(", ")}.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-foreground">New Docker Swarm stack project</h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              Reserve an unused stack namespace on a manager, choose its source and registry, then
              dry-run the rendered configuration before OpenShip can apply anything.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreatingProject((open) => !open)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-3.5" /> {creatingProject ? "Close setup" : "Create stack project"}
          </button>
        </div>
        {creatingProject && (
          <NewSwarmStackProject
            initialServerId={serverId}
            initialSummary={summary}
            onClose={() => setCreatingProject(false)}
          />
        )}
      </section>

      <section className="rounded-2xl border border-border/50 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
          <div>
            <h2 className="font-semibold text-foreground">Discovered stacks</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Grouped from Docker’s stack namespace labels.
            </p>
          </div>
          <span className="text-sm text-muted-foreground">
            {discovery.stacks.length} stacks · {discovery.standaloneServices.length} standalone
            services
          </span>
        </div>
        {discovery.stacks.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No stack namespaces were found on this manager. Standalone Swarm services remain
            separate below.
          </p>
        ) : (
          <div className="divide-y divide-border/40">
            {discovery.stacks.map((stack) => {
              const expanded = selectedStack === stack.name;
              return (
                <div key={stack.name} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void showStack(stack.name)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <Boxes className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">
                          {stack.name}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {stack.services.length} services ·{" "}
                          {stack.services.reduce((sum, service) => sum + service.taskCount, 0)}{" "}
                          current tasks
                        </span>
                      </span>
                      {expanded ? (
                        <ChevronUp className="size-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="size-4 text-muted-foreground" />
                      )}
                    </button>
                    {stack.portainerManaged && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Portainer metadata detected
                      </span>
                    )}
                    <HealthBadge state={stack.health.state} />
                    <button
                      type="button"
                      onClick={() => setConfirmStack(stack.name)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10"
                    >
                      <Eye className="size-3.5" /> Observe
                    </button>
                  </div>
                  {expanded && (
                    <div className="mt-4 rounded-xl border border-border/50 bg-muted/[0.18] p-4">
                      {loadingDetail ? (
                        <div className="flex justify-center py-6">
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : detail ? (
                        <StackDetail initialDetail={detail} nodes={nodes} serverId={serverId} />
                      ) : (
                        <p className="py-4 text-sm text-muted-foreground">
                          Stack details could not be loaded.
                        </p>
                      )}
                    </div>
                  )}
                  {confirmStack === stack.name && (
                    <div
                      role="alertdialog"
                      aria-label={`Observe ${stack.name}`}
                      className="mt-4 rounded-xl border border-warning/25 bg-warning/5 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-foreground">Observe {stack.name}?</p>
                          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                            This is read-only. OpenShip will save safe discovery metadata and
                            service projections; no workload changes will be sent to Docker or
                            Portainer.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmStack(null)}
                            className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={importingStack === stack.name}
                            onClick={() => void observe(stack.name)}
                            className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                          >
                            {importingStack === stack.name && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            Import read-only
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {discovery.standaloneServices.length > 0 && (
          <div className="border-t border-border/50 px-5 py-4">
            <h3 className="text-sm font-semibold text-foreground">Standalone Swarm services</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              These services have no stack namespace and cannot be inferred into a stack.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {discovery.standaloneServices.map((service) => (
                <span
                  key={service.id}
                  className="rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground"
                >
                  {service.name}{" "}
                  <span className="text-muted-foreground">· {service.taskCount} tasks</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function NewSwarmStackProject({
  initialServerId,
  initialSummary,
  onClose,
}: {
  initialServerId: string;
  initialSummary: SwarmSummary;
  onClose: () => void;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [projectName, setProjectName] = useState("");
  const [stackName, setStackName] = useState("");
  const [stackNameTouched, setStackNameTouched] = useState(false);
  const [sourceMode, setSourceMode] = useState<"inline" | "repository">("inline");
  const [inlineYaml, setInlineYaml] = useState("");
  const [repositoryOwner, setRepositoryOwner] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryBranch, setRepositoryBranch] = useState("main");
  const [repositoryPaths, setRepositoryPaths] = useState("compose.yaml");
  const [sourcePath, setSourcePath] = useState("");
  const [registries, setRegistries] = useState<ContainerRegistry[]>([]);
  const [registryId, setRegistryId] = useState("");
  const [loadingRegistries, setLoadingRegistries] = useState(true);
  const [managerCandidates, setManagerCandidates] = useState<SwarmManagerCandidate[]>([
    { serverId: initialServerId, label: "Current manager", summary: initialSummary },
  ]);
  const [selectedManagerId, setSelectedManagerId] = useState(initialServerId);
  const [loadingManagers, setLoadingManagers] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [partialProjectId, setPartialProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void registriesApi
      .list()
      .then((items) => {
        if (!cancelled) setRegistries(items);
      })
      .catch((cause) => {
        if (!cancelled)
          showToast(
            getApiErrorMessage(cause, "Unable to load container registries."),
            "error",
            "Docker Swarm",
          );
      })
      .finally(() => {
        if (!cancelled) setLoadingRegistries(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    void systemApi
      .listServers()
      .then(async (servers) => {
        const summaries = await Promise.all(
          servers
            .filter((server) => server.id !== initialServerId)
            .map(async (server) => {
              try {
                return {
                  serverId: server.id,
                  label: server.name || server.sshHost || "Docker manager",
                  summary: await swarmApi.summary(server.id),
                } satisfies SwarmManagerCandidate;
              } catch {
                // A registered server that is not a Swarm manager is not a
                // valid preference for this project, so it is intentionally absent.
                return null;
              }
            }),
        );
        if (cancelled) return;
        const current = servers.find((server) => server.id === initialServerId);
        setManagerCandidates([
          {
            serverId: initialServerId,
            label: current?.name || current?.sshHost || "Current manager",
            summary: initialSummary,
          },
          ...summaries.filter(
            (candidate): candidate is SwarmManagerCandidate => candidate !== null,
          ),
        ]);
      })
      .catch(() => {
        // The current inspected manager remains a safe, usable choice.
      })
      .finally(() => {
        if (!cancelled) setLoadingManagers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialServerId, initialSummary]);

  const selectedManager =
    managerCandidates.find((candidate) => candidate.serverId === selectedManagerId) ??
    managerCandidates[0]!;
  const composePaths = repositoryPaths
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  const projectNameError = projectName.trim() ? null : "Enter a project name.";
  const stackNameError = !stackName.trim()
    ? "Enter a stack name."
    : stackName.length > 63 || !STACK_NAME_PATTERN.test(stackName)
      ? "Use up to 63 lowercase letters, numbers, dots, underscores, or hyphens; begin with a letter or number."
      : null;
  const repositoryError =
    sourceMode !== "repository"
      ? null
      : !repositoryOwner.trim() || !repositoryName.trim()
        ? "Enter the GitHub owner and repository for a repository source."
        : composePaths.length === 0 || composePaths.some((path) => !isRelativeRepositoryPath(path))
          ? "Compose paths must be non-empty relative paths inside the repository."
          : sourcePath.trim() && !isRelativeRepositoryPath(sourcePath)
            ? "Source subdirectory must be a relative path inside the repository."
            : null;
  const inlineError =
    sourceMode === "inline" && !inlineYaml.trim() ? "Paste the complete stack YAML." : null;
  const canSubmit =
    !projectNameError && !stackNameError && !repositoryError && !inlineError && !submitting;

  const createProject = async () => {
    if (!canSubmit || !selectedManager) return;
    setSubmitting(true);
    setSubmissionError(null);
    setPartialProjectId(null);
    let projectId: string | null = null;
    try {
      const created = await projectsApi.create({
        name: projectName.trim(),
        ...(sourceMode === "repository"
          ? {
              gitProvider: "github" as const,
              gitOwner: repositoryOwner.trim(),
              gitRepo: repositoryName.trim(),
              gitBranch: repositoryBranch.trim() || "main",
            }
          : {}),
        framework: "docker-compose",
        projectType: "docker",
        runtimeMode: "docker",
        orchestratorMode: "standalone",
        hasServer: true,
        hasBuild: true,
        publicEndpoints: [],
      });
      projectId = created.data.id;
      setPartialProjectId(projectId);
      await swarmApi.createStackBinding(projectId, {
        serverId: selectedManager.serverId,
        stackName: stackName.trim(),
      });
      await swarmApi.replaceSource(
        projectId,
        sourceMode === "inline"
          ? { kind: "inline", yaml: inlineYaml, expectedVersion: 1 }
          : {
              kind: "repository",
              composePaths,
              sourcePath: sourcePath.trim() || undefined,
              branch: repositoryBranch.trim() || undefined,
              expectedVersion: 1,
            },
      );
      if (registryId) await swarmApi.setRegistry(projectId, registryId);
      showToast(
        "Stack project created in read-only setup mode. Render and review it before the first apply.",
        "success",
        "Docker Swarm",
      );
      router.push(`/projects/${projectId}/overview`);
    } catch (cause) {
      const message = getApiErrorMessage(cause, "Unable to create the Docker Swarm stack project.");
      setSubmissionError(
        projectId
          ? `${message} The project was kept so you can correct its setup without losing the source you entered.`
          : message,
      );
      showToast(message, "error", "Docker Swarm");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-5 rounded-xl border border-primary/20 bg-primary/[0.025] p-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <h3 className="font-medium text-foreground">1. Stack identity</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The namespace is checked on the selected manager before OpenShip records the binding.
            </p>
          </div>
          <label className="block text-sm text-muted-foreground">
            Project name
            <input
              value={projectName}
              maxLength={100}
              onChange={(event) => {
                const value = event.target.value;
                setProjectName(value);
                if (!stackNameTouched) setStackName(suggestedStackName(value));
              }}
              placeholder="Production web stack"
              className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
            {projectNameError && (
              <span className="mt-1 block text-xs text-danger">{projectNameError}</span>
            )}
          </label>
          <label className="block text-sm text-muted-foreground">
            Stack name
            <input
              value={stackName}
              maxLength={63}
              onChange={(event) => {
                setStackNameTouched(true);
                setStackName(event.target.value);
              }}
              placeholder="production-web"
              className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
            />
            {stackNameError ? (
              <span className="mt-1 block text-xs text-danger">{stackNameError}</span>
            ) : (
              <span className="mt-1 block text-xs text-muted-foreground">
                This name is reserved without creating services, networks, volumes, configs, or
                secrets.
              </span>
            )}
          </label>
          <fieldset>
            <legend className="text-sm text-muted-foreground">Manager preference</legend>
            <div className="mt-1.5 space-y-2">
              {managerCandidates.map((candidate) => (
                <label
                  key={candidate.serverId}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${selectedManagerId === candidate.serverId ? "border-primary/40 bg-primary/[0.035]" : "border-border/50 bg-card"}`}
                >
                  <input
                    type="radio"
                    name="swarm-manager"
                    value={candidate.serverId}
                    checked={selectedManagerId === candidate.serverId}
                    onChange={() => setSelectedManagerId(candidate.serverId)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {candidate.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Cluster fingerprint{" "}
                      <code>{shortId(candidate.summary.manager.clusterId)}</code> ·{" "}
                      {candidate.summary.manager.managerAddress ||
                        candidate.summary.manager.nodeAddress ||
                        "active manager"}
                    </span>
                  </span>
                </label>
              ))}
              {loadingManagers && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Checking other registered managers…
                </p>
              )}
            </div>
          </fieldset>
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="font-medium text-foreground">2. Authoritative source</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Source is saved first, then rendered on the selected manager for a read-only
              comparison.
            </p>
          </div>
          <div className="flex rounded-xl border border-border/50 bg-card p-1">
            {(
              [
                ["inline", "Paste YAML"],
                ["repository", "Repository files"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSourceMode(mode)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${sourceMode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {sourceMode === "inline" ? (
            <label className="block text-sm text-muted-foreground">
              Stack YAML
              <textarea
                value={inlineYaml}
                onChange={(event) => setInlineYaml(event.target.value)}
                spellCheck={false}
                placeholder={"services:\n  web:\n    image: nginx:alpine"}
                className="mt-1.5 min-h-48 w-full rounded-xl border border-border bg-card p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
              {inlineError && <span className="mt-1 block text-xs text-danger">{inlineError}</span>}
            </label>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <SwarmField
                label="GitHub owner"
                value={repositoryOwner}
                onChange={setRepositoryOwner}
                placeholder="acme"
              />
              <SwarmField
                label="GitHub repository"
                value={repositoryName}
                onChange={setRepositoryName}
                placeholder="production-stack"
              />
              <SwarmField
                label="Branch"
                value={repositoryBranch}
                onChange={setRepositoryBranch}
                placeholder="main"
              />
              <SwarmField
                label="Source subdirectory (optional)"
                value={sourcePath}
                onChange={setSourcePath}
                placeholder="deploy"
              />
              <div className="sm:col-span-2">
                <SwarmField
                  label="Compose paths, in merge order"
                  value={repositoryPaths}
                  onChange={setRepositoryPaths}
                  placeholder="compose.yaml, compose.production.yaml"
                />
              </div>
              {repositoryError && (
                <p className="sm:col-span-2 text-xs text-danger">{repositoryError}</p>
              )}
            </div>
          )}
          <label className="block text-sm text-muted-foreground">
            Registry
            <select
              value={registryId}
              disabled={loadingRegistries}
              onChange={(event) => setRegistryId(event.target.value)}
              className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
            >
              <option value="">No registry selected</option>
              {registries.map((registry) => (
                <option key={registry.id} value={registry.id}>
                  {registry.name} · {registry.registryUrl}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted-foreground">
              {loadingRegistries
                ? "Loading registries…"
                : "Prebuilt-image stacks can leave this unset; source-built services need a registry before apply."}
            </span>
          </label>
          <fieldset>
            <legend className="text-sm text-muted-foreground">Routing mode</legend>
            <label className="mt-1.5 flex items-start gap-3 rounded-xl border border-primary/40 bg-primary/[0.035] p-3">
              <input type="radio" checked readOnly className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  External controller
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Router labels, domains, TLS, and ports remain outside OpenShip.
                </span>
              </span>
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              OpenShip Edge becomes selectable only after a reviewed source is claimed, so an
              unowned stack can never take over traffic by mistake.
            </p>
          </fieldset>
        </div>
      </div>
      {submissionError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-danger/25 bg-danger-bg/35 px-3 py-2 text-sm text-danger"
        >
          {submissionError}
          {partialProjectId && (
            <button
              type="button"
              onClick={() => router.push(`/projects/${partialProjectId}/overview`)}
              className="ml-2 font-medium underline underline-offset-2"
            >
              Open saved project
            </button>
          )}
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border/50 pt-4">
        <button
          type="button"
          disabled={submitting}
          onClick={onClose}
          className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void createProject()}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {submitting && <Loader2 className="size-3.5 animate-spin" />}
          {submitting ? "Reserving stack namespace…" : "Create read-only stack project"}
        </button>
      </div>
    </div>
  );
}

function SwarmField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block text-sm text-muted-foreground">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
      />
    </label>
  );
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-border/50 bg-muted/[0.18] p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 truncate text-sm font-semibold text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

function LoadingCard() {
  return (
    <section className="flex min-h-64 items-center justify-center rounded-2xl border border-border/50 bg-card">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </section>
  );
}

function StackDetail({
  initialDetail,
  nodes,
  serverId,
}: {
  initialDetail: SwarmStackDetail;
  nodes: SwarmNode[];
  serverId: string;
}) {
  const [detail, setDetail] = useState(initialDetail);
  const [loadingTasks, setLoadingTasks] = useState(false);

  useEffect(() => setDetail(initialDetail), [initialDetail]);

  const loadTaskPage = useCallback(
    async (taskOffset: number) => {
      setLoadingTasks(true);
      try {
        setDetail(await swarmApi.stack(serverId, initialDetail.stack.name, { taskOffset }));
      } finally {
        setLoadingTasks(false);
      }
    },
    [initialDetail.stack.name, serverId],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{detail.stack.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Observed {formatObservedAt(detail.observedAt)}
          </p>
        </div>
        <HealthBadge state={detail.health.state} />
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Services
        </h3>
        <div className="space-y-2">
          {detail.services.map((service) => (
            <div
              key={service.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {service.sourceServiceName}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {service.image || "No image reported"}
                </p>
              </div>
              <span className="text-sm text-muted-foreground">
                {service.mode}
                {service.desiredReplicas !== null ? ` · ${service.desiredReplicas} desired` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Tasks
        </h3>
        {loadingTasks ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <SwarmTasksTable
            tasks={detail.tasks}
            page={detail.taskPage}
            onPage={(offset) => void loadTaskPage(offset)}
          />
        )}
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Nodes
        </h3>
        <SwarmNodesTable
          nodes={nodes.filter((node) => detail.tasks.some((task) => task.nodeId === node.id))}
        />
      </div>
    </div>
  );
}
