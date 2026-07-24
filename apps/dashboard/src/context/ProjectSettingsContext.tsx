"use client";
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
  useRef,
  useMemo,
} from "react";
import { isServicesFramework } from "@repo/core";
import { isSchemaAppTemplate } from "@/components/app-settings/AppSettingsForm";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";
import { projectsApi, servicesApi, type Service } from "@/lib/api";
import { PROJECT_INFO_NOT_FOUND, useProjectInfo } from "@/hooks/useProjectEndpoints";

interface ProjectDomain {
  domain: string;
  primary?: boolean;
  [key: string]: any;
}

interface ProjectOptions {
  buildCommand?: string;
  outputDirectory?: string;
  productionPaths?: string;
  installCommand?: string;
  startCommand?: string;
  productionPort?: string;
  rootDirectory?: string;
  hasBuild?: boolean;
  hasServer?: boolean;
  [key: string]: any;
}

interface BasicProjectData {
  id: string;
  slug: string;
  name: string;
  description: string;
  framework: string;
  options?: ProjectOptions;
  domains?: ProjectDomain[];
  buildImage?: string;
  hasMultipleServices?: boolean;
  serviceCount?: number;
  activeDeploymentId?: string | null;
  deployTarget?: "cloud" | "server" | "local";
  cloudWorkspaceId?: string | null;
  deletedAt?: string | null;
  packageManager?: string;
  /** How many recent versions retain their build artifact for rollback (snapshot strategy). null = instance default. */
  rollbackWindow?: number | null;
  [key: string]: any;
}


interface DomainsData {
  domains: any[];
  isLoading: boolean;
  error: string | null;
}

interface EnvironmentData {
  envVars: any;
  isLoading: boolean;
  error: string | null;
}

interface GitData {
  repository: any;
  branch: string;
  recentCommits: any[];
  isLoading: boolean;
  error: string | null;
  /** Which git host this project's repo lives on — drives GitHub vs GitLab
   *  labels/icons/URLs across GitSettings and GitInfo. Defaults to "github"
   *  for pre-GitLab projects (undefined `provider` in the API response). */
  gitProvider?: "github" | "gitlab";
  autoDeployEnabled?: boolean;
  webhookActive?: boolean;
  webhookStrategy?: "app" | "domain" | "repo" | "none";
  webhookDomain?: string | null;
  availableStrategies?: string[];
  verifiedDomains?: Array<{ hostname: string; ssl: boolean }>;
  installationInstalled?: boolean;
  installUrl?: string;
  defaultRollbackStrategy?: "git" | "snapshot";
}

interface ProjectEnvironment {
  id: string;
  name: string;
  slug: string;
  type: "production" | "preview" | "development";
  gitBranch: string;
  projectSlug: string;
  activeDeploymentId: string | null;
  latestDeploymentStatus: string | null;
  primaryDomain: string | null;
  // App axis: version instead of git branch (null for git projects).
  version?: string | null;
  isApp?: boolean;
  gitProvider?: string | null;
}

interface BuildData {
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string;
  installCommand: string;
  startCommand: string;
  productionPort: string;
  buildImage: string;
  rootDirectory: string;
  hasBuild: boolean;
  hasServer: boolean;
  isLoading: boolean;
  error: string | null;
}

// Defaults applied when project.options has no value for a field.
// Used by the `buildData` view in the provider — defaults first,
// then server values override via spread.
const BUILD_OPTION_DEFAULTS = {
  buildCommand: "",
  outputDirectory: ".",
  productionPaths: "",
  installCommand: "bun install",
  startCommand: "npm start",
  productionPort: "",
  rootDirectory: "./",
  hasBuild: true,
  hasServer: true,
} as const;

interface TerminalLogsData {
  logs: string[];
  isStreaming: boolean;
  sseConnection: { disconnect: () => void } | null;
  xtermInstance: any | null;
}

interface ServerLogsData {
  logs: any[];
  mockInterval: NodeJS.Timeout | null;
}

interface ServicesData {
  services: Service[];
  isLoading: boolean;
  error: string | null;
}

interface ProjectSettingsContextType {
  // Project basic data
  projectData: BasicProjectData;
  setProjectData: React.Dispatch<React.SetStateAction<BasicProjectData>>;
  // Update helpers below mutate context state only — they do NOT persist.
  // Callers must hit projectsApi.* themselves and only invoke these on
  // success. Synchronous to make that contract explicit.
  updateProjectData: (updates: Partial<BasicProjectData>) => void;

  // Domains
  domainsData: DomainsData;
  updateDomains: (domains: ProjectDomain[]) => void;

  // Environment
  environmentData: EnvironmentData;
  updateEnvironment: (envVars: any) => void;
  refreshEnvironment: () => Promise<void>;

  // Git
  gitData: GitData;
  refreshGit: () => Promise<void>;

  // Build
  buildData: BuildData;
  updateBuild: (buildInfo: Partial<BuildData>) => void;

  // Terminal Logs
  terminalLogsData: TerminalLogsData;
  addTerminalLog: (log: string) => void;
  clearTerminalLogs: () => void;
  setTerminalStreaming: (isStreaming: boolean) => void;
  setTerminalXtermInstance: (instance: any) => void;

  // Server Logs
  serverLogsData: ServerLogsData;
  addServerLog: (log: any) => void;
  mergeServerLogs: (logs: any[]) => void;
  setServerLogs: (logs: any[]) => void;
  clearServerLogs: () => void;

  // Services
  servicesData: ServicesData;
  refreshServices: () => Promise<Service[]>;
  hasMultipleServices: boolean;

  // Global state
  projectNotFound: boolean;
  errorType: "project-not-found" | "repo-not-found" | "access-denied" | null;
  id: string;
  environments: ProjectEnvironment[];
  createEnvironment: (input: {
    environmentName: string;
    environmentSlug?: string;
    environmentType?: "production" | "preview" | "development";
    gitBranch?: string;
    sourceMode?: "branch" | "manual";
  }) => Promise<ProjectEnvironment | null>;
  domain: string;
  /** Shared domain selection driving the overview URL + analytics (multi-domain projects). */
  selectedDomain: string;
  setSelectedDomain: (domain: string) => void;
  slug?: string[]; // Optional array for catch-all routes
  activeTab: string;
  setActiveTab: (tab: string) => void;
  tabs: { id: string; label: string; icon: string }[];
}

const ProjectSettingsContext = createContext<ProjectSettingsContextType | undefined>(undefined);


interface ProviderProps {
  children: ReactNode;
  id: string;
  slug?: string[]; // Optional array for catch-all routes
  initialProjectData?: BasicProjectData;
}

export const ProjectSettingsProvider: React.FC<ProviderProps> = ({
  children,
  id,
  slug,
  initialProjectData,
}) => {
  const { t } = useI18n();
  const [projectData, setProjectData] = useState<BasicProjectData>(
    initialProjectData || {
      id: "",
      slug: "",
      name: "",
      description: "",
      framework: "",
    },
  );

  // Analytics + projectInfo state moved to `@/hooks/useProjectEndpoints`.
  // The provider no longer fires those fetches — consumers call the
  // hooks directly and the module-level cache dedups across components.

  const [environmentData, setEnvironmentData] = useState<EnvironmentData>({
    envVars: {},
    isLoading: false,
    error: null,
  });

  const [gitData, setGitData] = useState<GitData>({
    repository: null,
    branch: "",
    recentCommits: [],
    isLoading: false,
    error: null,
  });

  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);

  const [terminalLogsData, setTerminalLogsData] = useState<TerminalLogsData>({
    logs: [],
    isStreaming: false,
    sseConnection: null,
    xtermInstance: null,
  });

  const [serverLogsData, setServerLogsData] = useState<ServerLogsData>({
    logs: [],
    mockInterval: null,
  });

  const [servicesData, setServicesData] = useState<ServicesData>({
    services: [],
    isLoading: false,
    error: null,
  });

  const [projectNotFound, setProjectNotFound] = useState(false);
  const [errorType, setErrorType] = useState<
    "project-not-found" | "repo-not-found" | "access-denied" | null
  >(null);

  // ─── Single source of truth: useProjectInfo ────────────────────────────
  //
  // /projects/:id/info is the canonical source for the whole project
  // payload (basics + options + domains + environments). The hook gives
  // us cache + dedup + invalidation via `invalidateProjectCaches(id)`.
  //
  // - `projectData` is a useState seeded from the hook so consumers can
  //   still call `setProjectData(prev => ...)` for optimistic local
  //   updates (delete flow, name edits, etc.). The effect below
  //   re-seeds on every fresh fetch — the canonical server data wins
  //   after an invalidation.
  //
  // - `buildData`, `domainsData`, `domain` are NOT state. They are
  //   `useMemo` views over `projectData` (and the hook's loading state).
  //   This kills the previous five-state mirror-via-effect anti-pattern:
  //   one place to write, derived views update automatically.
  //
  // - `updateBuild` and `updateDomains` write back through
  //   `setProjectData` into `projectData.options.*` and
  //   `projectData.domains` respectively, where the data actually lives.
  const {
    data: projectInfo,
    isLoading: isLoadingProjectInfo,
    error: projectInfoError,
  } = useProjectInfo(id);

  const router = useRouter();

  // When the user navigates from /projects/A to /projects/B, the layout
  // (and this provider) stays mounted — Next.js just re-renders with a
  // new `id` prop. `useProjectInfo` keeps the previous project's data
  // until B's fetch resolves, which would otherwise leak project A's
  // values into B's UI (build settings, domains, etc.) during the
  // loading window. Clearing on `id` change closes that window.
  const lastIdRef = useRef(id);
  useEffect(() => {
    if (lastIdRef.current === id) return;
    lastIdRef.current = id;
    setProjectData(
      initialProjectData || { id: "", slug: "", name: "", description: "", framework: "" },
    );
    setEnvironments([]);
  }, [id, initialProjectData]);

  // 404 cold-load: the project was deleted (other tab, force flow, direct
  // DB). useProjectInfo surfaces the sentinel PROJECT_INFO_NOT_FOUND via
  // `error` — we redirect to /projects rather than render the half-empty
  // layout (no name, no right rail, "not found" body) that confused users.
  // Guarded per-id so React re-renders during the navigation don't loop.
  // The hook also pins isLoading=true while this sentinel is set, so the
  // page-level skeleton covers the tick before the route change lands.
  const redirectedForIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    if (projectInfoError !== PROJECT_INFO_NOT_FOUND) return;
    if (redirectedForIdRef.current === id) return;
    redirectedForIdRef.current = id;
    router.replace("/projects");
  }, [id, projectInfoError, router]);

  useEffect(() => {
    if (projectInfo?.project) setProjectData(projectInfo.project);
    if (projectInfo?.environments) setEnvironments(projectInfo.environments);
  }, [projectInfo]);

  const buildData = useMemo<BuildData>(
    () => ({
      ...BUILD_OPTION_DEFAULTS,
      ...projectData.options,
      // buildImage lives at top-level on the project, not in options.
      buildImage: projectData.buildImage || "node:22",
      isLoading: isLoadingProjectInfo,
      error: projectInfoError,
    }),
    [projectData, isLoadingProjectInfo, projectInfoError],
  );

  const domainsData = useMemo<DomainsData>(
    () => ({
      domains: projectData.domains || [],
      isLoading: isLoadingProjectInfo,
      error: projectInfoError,
    }),
    [projectData.domains, isLoadingProjectInfo, projectInfoError],
  );

  const domain = useMemo(
    () =>
      projectData.domains?.find((d: any) => d.primary)?.domain ||
      projectData.domains?.[0]?.domain ||
      "",
    [projectData.domains],
  );

  // Shared domain selection driving the overview URL + analytics: the sidebar
  // switcher writes it, OverviewTab/MonitoringTab read it to refetch per-domain.
  // Defaults to the primary and snaps back to it when the current pick drops out
  // of the project's domains. (The /logs view keeps its own separate selection.)
  const [selectedDomain, setSelectedDomain] = useState("");
  useEffect(() => {
    const available = (projectData.domains || [])
      .map((d: any) => d?.domain)
      .filter((d: unknown): d is string => typeof d === "string" && d.length > 0);
    setSelectedDomain((current) =>
      current && available.includes(current) ? current : domain,
    );
  }, [domain, projectData.domains]);

  // Derived: do we have multi-service rendering paths to enable?
  // projectData hint OR serviceCount > 1 OR loaded services > 1.
  const hasMultipleServices =
    projectData.hasMultipleServices === true ||
    Number(projectData.serviceCount ?? 0) > 1 ||
    servicesData.services.length > 1;

  const isLoadingEnvironmentRef = useRef(false);
  // Fetch environment
  const refreshEnvironment = useCallback(async () => {
    try {
      if (isLoadingEnvironmentRef.current) return;
      isLoadingEnvironmentRef.current = true;
      setEnvironmentData((prev) => ({ ...prev, isLoading: true, error: null }));

      if (!id) {
        setEnvironmentData((prev) => ({ ...prev, isLoading: false }));
        return;
      }

      const response = await projectsApi.getEnv(id);

      if (response.data) {
        // Convert array format to expected format
        const envVarsArray = response.data || [];
        const envVars = {
          development: envVarsArray.map((env: any, index: number) => ({
            id: Date.now() + index,
            key: env.key,
            value: env.value,
            encrypted: true,
          })),
          preview: [],
          production: [],
        };

        setEnvironmentData({
          envVars: envVars,
          isLoading: false,
          error: null,
        });
      } else {
        setEnvironmentData((prev) => ({
          ...prev,
          isLoading: false,
        }));
      }
    } catch (error) {
      console.error("Failed to fetch environment variables:", error);
      setEnvironmentData((prev) => ({
        ...prev,
        isLoading: false,
      }));
    } finally {
      isLoadingEnvironmentRef.current = false;
    }
  }, [id]);

  // Fetch git
  const isLoadingGitRef = useRef(false);
  const refreshGit = useCallback(async () => {
    try {
      if (isLoadingGitRef.current) return;
      isLoadingGitRef.current = true;
      setGitData((prev) => ({ ...prev, isLoading: true, error: null }));

      if (!id) {
        setGitData((prev) => ({ ...prev, isLoading: false }));
        return;
      }

      const response = await projectsApi.getGit(id);

      if (response.success) {
        // Map commits from API response
        const mappedCommits = (response.commits || []).map((commit: any) => ({
          id: commit.sha,
          message: commit.message || "No message",
          author: commit.author || "Unknown",
          authorAvatar: commit.author_avatar || "",
          time: commit.date ? new Date(commit.date).toLocaleString() : "",
          url: commit.url,
        }));

        const gitProvider = response.provider === "gitlab" ? "gitlab" : "github";
        setGitData({
          repository: {
            name: `${response.owner}/${response.repo}`,
            provider: gitProvider === "gitlab" ? "GitLab" : "GitHub",
            url:
              gitProvider === "gitlab"
                ? `https://gitlab.com/${response.owner}/${response.repo}`
                : `https://github.com/${response.owner}/${response.repo}`,
          },
          gitProvider,
          branch: response.branch || "main",
          recentCommits: mappedCommits,
          isLoading: false,
          error: null,
          autoDeployEnabled: response.auto_deploy,
          webhookActive: response.webhook_active,
          webhookStrategy: response.webhook_strategy,
          webhookDomain: response.webhook_domain,
          availableStrategies: response.available_strategies,
          verifiedDomains: response.verified_domains,
          installationInstalled: response.installation_installed,
          installUrl: response.install_url,
          defaultRollbackStrategy: response.default_rollback_strategy,
        });
      } else {
        // "No repository connected" is the NORMAL state for upload/local
        // projects, not a failure — let GitSettings render its inline
        // "connect a repository" empty state (repository: null) instead of
        // hijacking the whole layout with the full-page repo-not-found
        // ErrorState. Only a genuine repo-not-found on a git-backed project
        // (repo deleted / access lost) escalates to the full-page error.
        const noRepoConnected =
          response.code === "NO_REPOSITORY" ||
          response.error?.toLowerCase().includes("no repository connected");
        const isRepoError =
          !noRepoConnected &&
          (response.error?.toLowerCase().includes("repository") ||
            response.error?.toLowerCase().includes("repo"));

        if (isRepoError) {
          setProjectNotFound(true);
          setErrorType("repo-not-found");
        }

        setGitData((prev) => ({
          ...prev,
          isLoading: false,
          error: noRepoConnected ? null : response.error || "Failed to load git data",
          repository: null,
          recentCommits: [],
        }));
      }
    } catch (error) {
      console.error("Failed to fetch git data:", error);
      setGitData((prev) => ({
        ...prev,
        isLoading: false,
        error: "Failed to load git data",
        repository: null,
        recentCommits: [],
      }));
    } finally {
      isLoadingGitRef.current = false;
    }
  }, [id]);

  // ─── Local-state update helpers ────────────────────────────────────────
  //
  // These mutate context state only — they do NOT persist to the API. The
  // calling component is responsible for calling projectsApi.* first and
  // then invoking the helper on success (and/or `invalidateProjectCaches`
  // to force a refetch). Kept synchronous + useCallback-stabilized so the
  // value-memo identity below stays stable across renders.

  const updateProjectData = useCallback((updates: Partial<BasicProjectData>) => {
    setProjectData((prev) => ({ ...prev, ...updates }));
  }, []);

  const updateDomains = useCallback((domains: ProjectDomain[]) => {
    // Domains live on the project itself, so we mutate projectData
    // directly. The `domainsData` view is a useMemo that re-derives
    // from projectData.domains, so consumers update automatically.
    setProjectData((prev) => ({ ...prev, domains }));
  }, []);

  const updateEnvironment = useCallback((envVars: any) => {
    setEnvironmentData((prev) => ({ ...prev, envVars }));
  }, []);

  const updateBuild = useCallback((buildInfo: Partial<BuildData>) => {
    // BuildData is a flat view but the underlying fields live in two
    // places on the project: `buildImage` is top-level, everything
    // else nests under `project.options`. Split the input, drop the
    // view-only `isLoading`/`error`, and merge each piece into the
    // right slot. The `buildData` useMemo re-derives from projectData
    // on the next render.
    const { buildImage, isLoading: _il, error: _err, ...optionUpdates } = buildInfo;
    void _il;
    void _err;
    setProjectData((prev) => ({
      ...prev,
      ...(buildImage !== undefined && { buildImage }),
      options: { ...(prev.options || {}), ...optionUpdates },
    }));
  }, []);

  const servicesRequestRef = useRef<{ projectId: string; promise: Promise<Service[]> } | null>(
    null,
  );
  const servicesRequestIdRef = useRef(0);

  const refreshServices = useCallback(async () => {
    if (!id || id === "undefined") {
      servicesRequestIdRef.current += 1;
      servicesRequestRef.current = null;
      setServicesData({ services: [], isLoading: false, error: null });
      return [];
    }

    if (servicesRequestRef.current?.projectId === id) {
      return servicesRequestRef.current.promise;
    }

    const requestId = servicesRequestIdRef.current + 1;
    servicesRequestIdRef.current = requestId;

    let promise!: Promise<Service[]>;
    promise = (async () => {
      setServicesData((prev) => ({ ...prev, isLoading: true, error: null }));

      try {
        const response = await servicesApi.list(id);
        const services = response.success ? (response.services ?? []) : [];
        if (servicesRequestIdRef.current === requestId) {
          setServicesData({
            services,
            isLoading: false,
            error: response.success ? null : "Failed to load services",
          });
        }
        return services;
      } catch (error) {
        console.error("Failed to fetch project services:", error);
        if (servicesRequestIdRef.current === requestId) {
          setServicesData({
            services: [],
            isLoading: false,
            error: "Failed to load services",
          });
        }
        return [];
      } finally {
        if (servicesRequestRef.current?.promise === promise) {
          servicesRequestRef.current = null;
        }
      }
    })();

    servicesRequestRef.current = { projectId: id, promise };
    return promise;
  }, [id]);

  const refreshEnvironments = useCallback(async () => {
    if (!id) return;
    const response = await projectsApi.getEnvironments(id);
    if (response.success) {
      setEnvironments(response.data || []);
    }
  }, [id]);

  const createEnvironment = useCallback(
    async (input: {
      environmentName: string;
      environmentSlug?: string;
      environmentType?: "production" | "preview" | "development";
      gitBranch?: string;
      sourceMode?: "branch" | "manual";
    }) => {
      if (!id) return null;
      const response = await projectsApi.createEnvironment(id, input);
      if (!response.success || !response.data) {
        throw new Error(response.error || "Failed to create environment");
      }
      await refreshEnvironments();
      return response.data as ProjectEnvironment;
    },
    [id, refreshEnvironments],
  );

  // Terminal Logs Management
  const MAX_TERMINAL_LOGS = 1000;

  const addTerminalLog = useCallback((log: string) => {
    setTerminalLogsData((prev) => ({
      ...prev,
      logs: [...prev.logs, log].slice(-MAX_TERMINAL_LOGS),
    }));
  }, []);

  const clearTerminalLogs = useCallback(() => {
    setTerminalLogsData((prev) => ({
      ...prev,
      logs: [],
    }));
  }, []);

  const setTerminalStreaming = useCallback((isStreaming: boolean) => {
    setTerminalLogsData((prev) => {
      if (prev.isStreaming === isStreaming) {
        return prev;
      }

      return {
        ...prev,
        isStreaming,
      };
    });
  }, []);

  const setTerminalXtermInstance = useCallback((instance: any) => {
    setTerminalLogsData((prev) => ({
      ...prev,
      xtermInstance: instance,
    }));
  }, []);

  // Server Logs Management
  const MAX_SERVER_LOGS = 100;

  const getServerLogKey = useCallback((log: any) => {
    if (!log || typeof log !== "object") return String(log);
    const parsedTimestamp =
      typeof log.timestamp === "string" ? Date.parse(log.timestamp) : Number.NaN;
    const timestampKey = Number.isFinite(parsedTimestamp)
      ? Math.floor(parsedTimestamp / 1000)
      : String(log.timestamp ?? "");

    return [
      timestampKey,
      log.ip,
      log.method,
      log.path,
      log.statusCode,
      log.responseTime,
      log.requestSize,
      log.responseSize,
    ].join("|");
  }, []);

  const dedupeServerLogs = useCallback(
    (logs: any[]) => {
      const seen = new Set<string>();
      const merged: any[] = [];

      for (const log of logs) {
        const key = getServerLogKey(log);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(log);
        if (merged.length >= MAX_SERVER_LOGS) break;
      }

      return merged;
    },
    [getServerLogKey],
  );

  const addServerLog = useCallback(
    (log: any) => {
      setServerLogsData((prev) => ({
        ...prev,
        logs: dedupeServerLogs([log, ...prev.logs]),
      }));
    },
    [dedupeServerLogs],
  );

  const mergeServerLogs = useCallback(
    (logs: any[]) => {
      setServerLogsData((prev) => ({
        ...prev,
        logs: dedupeServerLogs([...prev.logs, ...logs]),
      }));
    },
    [dedupeServerLogs],
  );

  const setServerLogs = useCallback(
    (logs: any[]) => {
      setServerLogsData((prev) => ({
        ...prev,
        logs: dedupeServerLogs(logs),
      }));
    },
    [dedupeServerLogs],
  );

  const clearServerLogs = useCallback(() => {
    setServerLogsData((prev) => ({
      ...prev,
      logs: [],
    }));
  }, []);

  // Cleanup on unmount - use refs to avoid re-running on data changes
  const terminalSSERef = useRef(terminalLogsData.sseConnection);
  const serverIntervalRef = useRef(serverLogsData.mockInterval);

  // Keep refs in sync
  useEffect(() => {
    terminalSSERef.current = terminalLogsData.sseConnection;
  }, [terminalLogsData.sseConnection]);

  useEffect(() => {
    serverIntervalRef.current = serverLogsData.mockInterval;
  }, [serverLogsData.mockInterval]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      // Cleanup terminal SSE connection
      if (terminalSSERef.current) {
        terminalSSERef.current.disconnect();
      }
      // Cleanup server mock interval
      if (serverIntervalRef.current) {
        clearInterval(serverIntervalRef.current);
      }
    };
  }, []); // Empty deps - only run on mount/unmount

  // Map legacy tab IDs to new ones
  const resolveTab = (tab?: string) => {
    if (tab === "general") return "overview";
    if (tab === "git") return "source";
    if (tab === "settings" || tab === "build") return "runtime";
    return tab || undefined; // let default be set by tab list below
  };

  // Service-FIRST = the project itself is a compose/services-stack project (no
  // single primary app). Keyed on the framework, NOT on "a service row exists"
  // — a single/static app that had a sidecar service added is still an app and
  // KEEPS its Configuration tab. Only a genuine compose project drops it.
  const isServicesProject = isServicesFramework(projectData.framework);
  // A schema app keeps its Configuration tab even when it's a compose/services
  // project — that tab hosts the "App settings | Deployment" 2-mode surface.
  const isSchemaApp = !!projectData.isApp && isSchemaAppTemplate(projectData.appTemplateId);
  const tabs = useMemo(() => {
    const tl = t.projects.sidebar.tabs;
    const all = [
      { id: "overview", label: tl.overview, icon: "setting-100-1658432731.png" },
      { id: "services", label: tl.services, icon: "layers.png" },
      { id: "domains", label: tl.domains, icon: "server-59-1658435258.png" },
      { id: "deployments", label: tl.deployments, icon: "heart%20rate-118-1658433496.png" },
      { id: "source", label: tl.source, icon: "git%20branch-159-1658431404.png" },
      { id: "runtime", label: tl.runtime, icon: "setting-40-1662364403.png" },
      { id: "logs", label: tl.logs, icon: "terminal-184-1658431404.png" },
      { id: "backup", label: tl.backup, icon: "database.png" },
      { id: "advanced", label: tl.advanced, icon: "error%20triangle-81-1658234612.png" },
    ];
    return all.filter((tab) => {
      // A service-first project has no single-app runtime — config lives per
      // service under Services — so hide the Configuration (runtime) tab there.
      // A schema app keeps it, though: it's the home of the 2-mode config.
      if (isServicesProject && !isSchemaApp && tab.id === "runtime") return false;
      return true;
    });
  }, [t, isServicesProject, isSchemaApp]);

  const defaultTab = tabs[0].id;
  const [activeTab, setActiveTab] = useState(resolveTab(slug?.[0]) || defaultTab);

  useEffect(() => {
    void refreshServices();
  }, [refreshServices]);

  // Sync activeTab with slug changes (for browser back/forward navigation)
  const slugTab = slug?.[0];
  useEffect(() => {
    const resolved = resolveTab(slugTab) || defaultTab;
    // If the resolved tab isn't valid for this project type, fall back to default
    const validIds = tabs.map((t) => t.id);
    const target = validIds.includes(resolved) ? resolved : defaultTab;
    if (target !== activeTab) {
      setActiveTab(target);
    }
  }, [slugTab, defaultTab, tabs]); // Only watch slug[0] to avoid array reference issues

  const value: ProjectSettingsContextType = useMemo(
    () => ({
      projectData,
      setProjectData,
      updateProjectData,

      domainsData,
      updateDomains,

      environmentData,
      updateEnvironment,
      refreshEnvironment,

      gitData,
      refreshGit,

      buildData,
      updateBuild,

      terminalLogsData,
      addTerminalLog,
      clearTerminalLogs,
      setTerminalStreaming,
      setTerminalXtermInstance,

      serverLogsData,
      addServerLog,
      mergeServerLogs,
      setServerLogs,
      clearServerLogs,

      servicesData,
      refreshServices,
      hasMultipleServices,

      projectNotFound,
      errorType,
      id,
      environments,
      createEnvironment,
      domain,
      selectedDomain,
      setSelectedDomain,
      slug,
      activeTab,
      setActiveTab,
      tabs,
    }),
    [
      projectData,
      domainsData,
      updateDomains,
      environmentData,
      updateEnvironment,
      refreshEnvironment,
      gitData,
      refreshGit,
      buildData,
      updateBuild,
      terminalLogsData,
      addTerminalLog,
      clearTerminalLogs,
      setTerminalStreaming,
      setTerminalXtermInstance,
      serverLogsData,
      addServerLog,
      mergeServerLogs,
      setServerLogs,
      clearServerLogs,
      servicesData,
      refreshServices,
      hasMultipleServices,
      projectNotFound,
      errorType,
      id,
      environments,
      createEnvironment,
      domain,
      selectedDomain,
      slug,
      activeTab,
      tabs,
    ],
  );

  return (
    <ProjectSettingsContext.Provider value={value}>{children}</ProjectSettingsContext.Provider>
  );
};

export const useProjectSettings = () => {
  const context = useContext(ProjectSettingsContext);
  if (context === undefined) {
    throw new Error("useProjectSettings must be used within a ProjectSettingsProvider");
  }
  return context;
};
