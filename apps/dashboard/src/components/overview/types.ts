// =============================================================================
// Overview Dashboard Types
// =============================================================================

export interface OverviewStats {
  totalTokenUsage: number;
  creditsBalance: string | number; // Can be formatted string (K/M) or number
  creditsSpent: string | number; // Can be formatted string (K/M) or number
  totalApiRequests: number;
  activeProjects: number;
  totalDeployments: number;
  successfulDeployments: number;
  failedDeployments: number;
  totalSandboxes: number;
  activeSandboxes: number;
  totalAgents: number;
}

export interface DailyMetric {
  date: string;
  value: number;
  label?: string;
}

export interface TokenUsageData {
  daily: DailyMetric[];
  total: number;
  trend: number;
  breakdown: TokenBreakdown[];
}

export interface TokenBreakdown {
  service: string;
  tokens: number;
  percentage: number;
  color: string;
}

export interface DeploymentData {
  daily: DailyMetric[];
  total: number;
  success: number;
  failed: number;
  building: number;
}

export interface CreditData {
  balance: string | number; // Can be formatted string (K/M) or number
  spent: string | number; // Can be formatted string (K/M) or number
  daily: DailyMetric[];
  trend: number;
}

export interface AgentData {
  total: number;
  active: number;
  production: number;
  testing: number;
  daily: DailyMetric[];
  trend: number;
}

export interface SandboxData {
  total: number;
  active: number;
  inactive: number;
  recent: RecentSandbox[];
}

export interface RecentSandbox {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  createdAt: string;
}

export interface ProjectData {
  total: number;
  live: number;
  building: number;
  failed: number;
  recent: RecentProject[];
}

export interface RecentProject {
  id: string;
  name: string;
  framework: string;
  status: 'live' | 'building' | 'failed' | 'paused';
  lastDeployed: string;
}

export interface ApiRequestData {
  total: number;
  daily: DailyMetric[];
  trend: number;
  endpoints: EndpointUsage[];
}

export interface EndpointUsage {
  endpoint: string;
  calls: number;
  percentage: number;
}

export interface QuickLink {
  title: string;
  description: string;
  href: string;
  icon: string;
  color: string;
}

export type ChartType = 'bar' | 'area' | 'line';
export type TimePeriod = 7 | 14 | 30;

