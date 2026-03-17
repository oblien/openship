"use client";
import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef, useMemo } from "react";
import { projectsApi } from "@/lib/api";

interface BasicProjectData {
  name: string;
  description: string;
  framework: string;
  [key: string]: any;
}

interface AnalyticsData {
  success: boolean;
  domain: string;
  summary: {
    totalRequests: number;
    uniqueIPs: number;
    uniqueRequests: number;
    totalIPs: number;
    uniqueIPsPercentage: string;
    firstRequest: string;
    lastRequest: string;
    timeRangeHours: number;
    avgRequestsPerHour: number;
  };
  performance: {
    avgResponseTime: number;
    avgResponseTimeMs: number;
    totalResponseTime: number;
    minResponseTime: string;
    maxResponseTime: string;
  };
  bandwidth: {
    totalIn: number;
    totalOut: number;
    totalInFormatted: string;
    totalOutFormatted: string;
    avgRequestSize: number;
    avgResponseSize: number;
  };
  topPaths: Array<{
    path: string;
    count: number;
    percentage: string;
  }>;
  trafficByHour: Array<{
    hour: number;
    requests: number;
  }>;
  limited: boolean;
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
  autoDeployEnabled?: boolean;
  webhookActive?: boolean;
}

interface BuildData {
  buildCommand: string;
  outputDirectory: string;
  productionPaths: string;
  installCommand: string;
  startCommand: string;
  productionPort: string;
  hasServer: boolean;
  isLoading: boolean;
  error: string | null;
}

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

interface ProjectSettingsContextType {
  // Project basic data (for general settings only)
  projectData: BasicProjectData;
  deploymentsLoading: boolean;
  setProjectData: React.Dispatch<React.SetStateAction<BasicProjectData>>;
  updateProjectData: (updates: Partial<BasicProjectData>) => Promise<void>;
  updateProjectActive: (active: boolean) => Promise<void>;
  // Analytics
  analyticsData: AnalyticsData | null;
  isLoadingAnalytics: boolean;
  analyticsError: string | null;
  refreshAnalytics: () => Promise<void>;

  // Domains
  domainsData: DomainsData;
  updateDomains: (domains: any[]) => Promise<void>;
  refreshDomains: () => Promise<void>;

  // Environment
  environmentData: EnvironmentData;
  updateEnvironment: (envVars: any) => Promise<void>;
  refreshEnvironment: () => Promise<void>;

  // Git
  gitData: GitData;
  updateGit: (gitInfo: any) => Promise<void>;
  refreshGit: () => Promise<void>;

  // Build
  buildData: BuildData;
  updateBuild: (buildInfo: any) => Promise<void>;
  refreshBuild: () => Promise<void>;

  // Terminal Logs
  terminalLogsData: TerminalLogsData;
  addTerminalLog: (log: string) => void;
  clearTerminalLogs: () => void;
  setTerminalStreaming: (isStreaming: boolean) => void;
  setTerminalSSEConnection: (connection: { disconnect: () => void } | null) => void;
  setTerminalXtermInstance: (instance: any) => void;

  // Server Logs
  serverLogsData: ServerLogsData;
  addServerLog: (log: any) => void;
  setServerLogs: (logs: any[]) => void;
  clearServerLogs: () => void;
  setServerMockInterval: (interval: NodeJS.Timeout | null) => void;

  // Global state
  projectNotFound: boolean;
  errorType: 'project-not-found' | 'repo-not-found' | 'access-denied' | null;
  id: string;
  domain: string;
  slug?: string[]; // Optional array for catch-all routes
  activeTab: string;
  setActiveTab: (tab: string) => void;
  tabs: { id: string; label: string; icon: string }[];
  deployments: any[];
  fetchDeployments: () => Promise<void>;
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
  initialProjectData
}) => {
  const [projectData, setProjectData] = useState<BasicProjectData>(initialProjectData || {
    name: '',
    description: '',
    framework: ''
  });

  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [domainsData, setDomainsData] = useState<DomainsData>({
    domains: [],
    isLoading: false,
    error: null,
  });

  const [environmentData, setEnvironmentData] = useState<EnvironmentData>({
    envVars: {},
    isLoading: false,
    error: null,
  });

  const [gitData, setGitData] = useState<GitData>({
    repository: null,
    branch: '',
    recentCommits: [],
    isLoading: false,
    error: null,
  });

  const [buildData, setBuildData] = useState<BuildData>({
    buildCommand: '',
    outputDirectory: '.',
    productionPaths: '',
    installCommand: 'bun install',
    startCommand: 'npm start',
    productionPort: '3000',
    hasServer: true,
    isLoading: false,
    error: null,
  });

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

  const [projectNotFound, setProjectNotFound] = useState(false);
  const [errorType, setErrorType] = useState<'project-not-found' | 'repo-not-found' | 'access-denied' | null>(null);
  const [domain, setDomain] = useState('');
  const isLoadingAnalyticsRef = useRef<boolean>(false);
  const hasFetchedRef = useRef<boolean>(false);
  const lastFetchedIdRef = useRef<string>('');

  // Fetch analytics - memoized to prevent recreating on every render
  const refreshAnalytics = useCallback(async () => {
    try {
      // Prevent duplicate fetches for the same project
      if (isLoadingAnalyticsRef.current) return;
      if (hasFetchedRef.current && lastFetchedIdRef.current === id) {
        console.log('[ProjectSettings] Already fetched for this project, skipping');
        return;
      }

      isLoadingAnalyticsRef.current = true;
      setIsLoadingAnalytics(true);
      setAnalyticsError(null);
      setProjectNotFound(false);
      setErrorType(null);

      if (!id) return;

      console.log('[ProjectSettings] Fetching project info for:', id);
      const response = await projectsApi.getInfo(id);
      
      if (response.success) {
        setAnalyticsData(response.data.analytics);
        setProjectData(response.data.project);
        setBuildData(response.data.project.options);
        setDomainsData({
          domains: response.data.project.domains || [],
          isLoading: false,
          error: null
        });
        setDomain(response.data.project.domains?.[0]?.domain || '');

        // Mark as fetched for this id
        hasFetchedRef.current = true;
        lastFetchedIdRef.current = id;
      } else {
        setProjectNotFound(true);
        setErrorType('project-not-found');
        setAnalyticsError('Project not found');
      }
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
      setProjectNotFound(true);
      setErrorType('project-not-found');
      setAnalyticsError('Failed to load analytics');
    } finally {
      setIsLoadingAnalytics(false);
      isLoadingAnalyticsRef.current = false;
    }
  }, [id]); // Only recreate when id changes

  // Fetch domains
  const refreshDomains = async () => {
    try {
      setDomainsData(prev => ({ ...prev, isLoading: true, error: null }));
      // Add your API call here
      // const response = await request(`projects/${domain}/domains`, {}, 'GET');
      // setDomainsData({ domains: response.domains, isLoading: false, error: null });
    } catch (error) {
      setDomainsData(prev => ({ ...prev, isLoading: false, error: 'Failed to load domains' }));
    }
  };

  const isLoadingEnvironmentRef = useRef(false);
  // Fetch environment
  const refreshEnvironment = useCallback(async () => {
    try {
      if (isLoadingEnvironmentRef.current) return;
      isLoadingEnvironmentRef.current = true;
      setEnvironmentData(prev => ({ ...prev, isLoading: true, error: null }));

      if (!id) {
        setEnvironmentData(prev => ({ ...prev, isLoading: false }));
        return;
      }

      const response = await projectsApi.getEnv(id);

      if (response.success) {
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
        setEnvironmentData(prev => ({
          ...prev,
          isLoading: false,
        }));
      }
    } catch (error) {
      console.error('Failed to fetch environment variables:', error);
      setEnvironmentData(prev => ({
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
      setGitData(prev => ({ ...prev, isLoading: true, error: null }));

      if (!id) {
        setGitData(prev => ({ ...prev, isLoading: false }));
        return;
      }

      const response = await projectsApi.getGit(id);

      if (response.success) {
        // Map commits from API response
        const mappedCommits = (response.commits || []).map((commit: any) => ({
          id: commit.commit_id,
          status: commit.status, // 'success', 'failed', 'pending'
          message: commit.commit_info?.message || 'No message',
          author: commit.created_by || 'Unknown',
          avatar: (commit.created_by || 'U').charAt(0).toUpperCase() + (commit.created_by?.split(' ')[1]?.[0]?.toUpperCase() || ''),
          time: new Date(commit.created_at).toLocaleString(),
          timestamp: commit.commit_info?.timestamp,
          url: commit.commit_info?.url,
          files: (commit.commit_info?.added?.length || 0) + (commit.commit_info?.modified?.length || 0) + (commit.commit_info?.removed?.length || 0),
          changedFiles: [
            ...(commit.commit_info?.added || []).map((f: string) => ({ name: f, type: 'added' })),
            ...(commit.commit_info?.modified || []).map((f: string) => ({ name: f, type: 'modified' })),
            ...(commit.commit_info?.removed || []).map((f: string) => ({ name: f, type: 'removed' })),
          ],
        }));

        setGitData({
          repository: {
            name: `${response.owner}/${response.repo}`,
            provider: 'GitHub',
            url: `https://github.com/${response.owner}/${response.repo}`,
          },
          branch: 'main', // Can be updated if API provides branch info
          recentCommits: mappedCommits,
          isLoading: false,
          error: null,
          autoDeployEnabled: response.auto_deploy,
          webhookActive: response.webhook_active,
        });
      } else {
        // Check if it's a repo not found error
        const isRepoError = response.error?.toLowerCase().includes('repository') ||
          response.error?.toLowerCase().includes('repo');

        if (isRepoError) {
          setProjectNotFound(true);
          setErrorType('repo-not-found');
        }

        setGitData(prev => ({
          ...prev,
          isLoading: false,
          error: response.error || 'Failed to load git data',
          repository: null,
          recentCommits: [],
        }));
      }
    } catch (error) {
      console.error('Failed to fetch git data:', error);
      setGitData(prev => ({
        ...prev,
        isLoading: false,
        error: 'Failed to load git data',
        repository: null,
        recentCommits: [],
      }));
    } finally {
      isLoadingGitRef.current = false;
    }
  }, []);

  // Fetch build
  const isLoadingBuildRef = useRef(false);

  const refreshBuild = useCallback(async () => {
    if (isLoadingBuildRef.current) return;
    isLoadingBuildRef.current = true;
    try {
      setBuildData(prev => ({ ...prev, isLoading: true, error: null }));
      // Add your API call here
    } catch (error) {
      setBuildData(prev => ({ ...prev, isLoading: false, error: 'Failed to load build data' }));
    } finally {
      isLoadingBuildRef.current = false;
    }
  }, [id]);

  // Update functions
  const updateProjectData = async (updates: Partial<BasicProjectData>) => {
    setProjectData(prev => ({ ...prev, ...updates }));
    // Add your API call here to persist changes
  };

  const updateDomains = async (domains: any[]) => {
    setDomainsData(prev => ({ ...prev, domains }));
    // Add your API call here to persist changes
  };

  const updateEnvironment = async (envVars: any) => {
    setEnvironmentData(prev => ({ ...prev, envVars }));
    // Add your API call here to persist changes
  };

  const updateGit = async (gitInfo: any) => {
    // setGitData(prev => ({ ...prev, ...gitInfo }));
    // Add your API call here to persist changes
  };

  const updateBuild = async (buildInfo: any) => {
    setBuildData(prev => ({ ...prev, ...buildInfo }));
    // Add your API call here to persist changes
  };

  const updateProjectActive = async (active: boolean) => {
    setProjectData(prev => ({ ...prev, active }));
    // Add your API call here to persist changes
  };

  // Terminal Logs Management
  const addTerminalLog = useCallback((log: string) => {
    setTerminalLogsData(prev => ({
      ...prev,
      logs: [...prev.logs, log],
    }));
  }, []);

  const clearTerminalLogs = useCallback(() => {
    setTerminalLogsData(prev => ({
      ...prev,
      logs: [],
    }));
  }, []);

  const setTerminalStreaming = useCallback((isStreaming: boolean) => {
    setTerminalLogsData(prev => ({
      ...prev,
      isStreaming,
    }));
  }, []);

  const setTerminalSSEConnection = useCallback((connection: { disconnect: () => void } | null) => {
    setTerminalLogsData(prev => ({
      ...prev,
      sseConnection: connection,
    }));
  }, []);

  const setTerminalXtermInstance = useCallback((instance: any) => {
    setTerminalLogsData(prev => ({
      ...prev,
      xtermInstance: instance,
    }));
  }, []);

  // Server Logs Management
  const addServerLog = useCallback((log: any) => {
    setServerLogsData(prev => ({
      ...prev,
      logs: [log, ...prev.logs].slice(0, 50), // Keep last 50 logs
    }));
  }, []);

  const setServerLogs = useCallback((logs: any[]) => {
    setServerLogsData(prev => ({
      ...prev,
      logs,
    }));
  }, []);

  const clearServerLogs = useCallback(() => {
    setServerLogsData(prev => ({
      ...prev,
      logs: [],
    }));
  }, []);

  const setServerMockInterval = useCallback((interval: NodeJS.Timeout | null) => {
    // Clear previous interval if exists
    if (serverLogsData.mockInterval) {
      clearInterval(serverLogsData.mockInterval);
    }
    setServerLogsData(prev => ({
      ...prev,
      mockInterval: interval,
    }));
  }, [serverLogsData.mockInterval]);

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

  const [activeTab, setActiveTab] = useState(slug?.[0] || "error");

  // Initial load - only fetch once on mount since id shouldn't change
  useEffect(() => {
    refreshAnalytics();
  }, [refreshAnalytics]); // refreshAnalytics is memoized with id as dependency

  // Sync activeTab with slug changes (for browser back/forward navigation)
  const slugTab = slug?.[0];
  useEffect(() => {
    if (slugTab && slugTab !== activeTab) {
      setActiveTab(slugTab);
    }
  }, [slugTab]); // Only watch slug[0] to avoid array reference issues

  const tabs = [
    { id: "general", label: "General", icon: 'setting-100-1658432731.png' },
    { id: "domains", label: "Domains", icon: 'server-59-1658435258.png' },
    { id: "deployments", label: "Deployments", icon: 'heart%20rate-118-1658433496.png' },
    // { id: "git", label: "Git", icon: 'git%20branch-159-1658431404.png' },
    { id: "settings", label: "Settings", icon: 'setting-40-1662364403.png' },
    { id: "logs", label: "Logs", icon: 'terminal-184-1658431404.png' },
    { id: "advanced", label: "Advanced", icon: 'error%20triangle-81-1658234612.png' },
  ];

  const [deployments, setDeployments] = useState([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);
  const isLoadingDeploymentsRef = useRef(false);
  
  const fetchDeployments = useCallback(async () => {
    if (deploymentsLoading || isLoadingDeploymentsRef.current) return;
    if (!id) return;
    try {
      setDeploymentsLoading(true);
      isLoadingDeploymentsRef.current = true;
      const response = await projectsApi.getDeployments(id);
      if (response.success) {
        // Add project info to each deployment
        const deploymentsWithProject = (response.deployments || []).map((deployment: any) => ({
          ...deployment,
          projectId: id,
          projectName: projectData.name,
        }));
        setDeployments(deploymentsWithProject);
      }
    } catch (error) {
      console.error("Error fetching deployments:", error);
    } finally {
      setDeploymentsLoading(false);
      isLoadingDeploymentsRef.current = false;
    }
  }, [id]);

  const value: ProjectSettingsContextType = useMemo(() => ({
    fetchDeployments,
    deployments,
    deploymentsLoading,
    projectData,
    setProjectData,
    updateProjectData,
    updateProjectActive,

    analyticsData,
    isLoadingAnalytics,
    analyticsError,
    refreshAnalytics,

    domainsData,
    updateDomains,
    refreshDomains,

    environmentData,
    updateEnvironment,
    refreshEnvironment,

    gitData,
    updateGit,
    refreshGit,

    buildData,
    updateBuild,
    refreshBuild,

    terminalLogsData,
    addTerminalLog,
    clearTerminalLogs,
    setTerminalStreaming,
    setTerminalSSEConnection,
    setTerminalXtermInstance,

    serverLogsData,
    addServerLog,
    setServerLogs,
    clearServerLogs,
    setServerMockInterval,

    projectNotFound,
    errorType,
    id,
    domain,
    slug,
    activeTab,
    setActiveTab,
    tabs,
  }), [
    projectData,
    analyticsData,
    isLoadingAnalytics,
    analyticsError,
    refreshAnalytics,
    domainsData,
    updateDomains,
    refreshDomains,
    environmentData,
    updateEnvironment,
    refreshEnvironment,
    gitData,
    updateGit,
    refreshGit,
    buildData,
    updateBuild,
    refreshBuild,
    terminalLogsData,
    addTerminalLog,
    clearTerminalLogs,
    setTerminalStreaming,
    setTerminalSSEConnection,
    setTerminalXtermInstance,
    serverLogsData,
    addServerLog,
    setServerLogs,
    clearServerLogs,
    setServerMockInterval,
    projectNotFound,
    errorType,
    id,
    domain,
    slug,
    activeTab,
    tabs,
  ]);

  return (
    <ProjectSettingsContext.Provider value={value}>
      {children}
    </ProjectSettingsContext.Provider>
  );
};

export const useProjectSettings = () => {
  const context = useContext(ProjectSettingsContext);
  if (context === undefined) {
    throw new Error('useProjectSettings must be used within a ProjectSettingsProvider');
  }
  return context;
};
