/**
 * @module @/lib/api
 *
 * Centralised API layer for the Openship dashboard.
 *
 * Usage:
 *   import { projectsApi, deployApi, githubApi } from "@/lib/api";
 *   const { projects, numbers } = await projectsApi.getHome();
 */

/* --- Low-level client (rarely needed directly) -------------------- */
export {
	api,
	ApiError,
	getApiErrorCode,
	getApiErrorMessage,
	isAbortError,
	isNetworkError,
	setNetworkErrorHandler,
	getApiBaseUrl,
} from "./client";
export type { RequestOptions } from "./client";

/* --- Endpoint registry (single source of truth for paths) --------- */
export { endpoints } from "./endpoints";

/* --- Domain services ---------------------------------------------- */
export { projectsApi } from "./projects";
export type {
  RouteRuleRow,
  RouteRuleInput,
  BindObjectStorageBody,
  ObjectStorageBinding,
  ObjectStorageProviderSpec,
  ObjectStorageView,
} from "./projects";
export { appsApi } from "./apps";
export type { AppCatalogEntry, AppCatalogField, InstallAppResult } from "./apps";
export { deployApi } from "./deploy";
export type { RestorePlanUI } from "./deploy";
export { domainsApi } from "./domains";
export {
  jobsApi,
  type JobView,
  type JobRunSummary,
  type JobInput,
  type JobTriggerEvent,
  type JobActionConfig,
  type JobNotifyConfig,
  type JobRetryConfig,
  type JobRunState,
  type BackupScheduleView,
} from "./jobs";
export { tokensApi } from "./tokens";
export type { AccessToken, CreatedAccessToken, McpClient } from "./tokens";
export { githubApi } from "./github";
export type { RepoTreeEntry } from "./github";
export { iconsApi } from "./icons";
export { imagesApi } from "./images";
export type { ImageCatalogEntry, ListImagesResponse } from "./images";
export { aiApi } from "./ai";
export { sandboxApi } from "./sandbox";
export { systemApi } from "./system";
export type { EdgeOrphanScan, UntrackedEdgeSite, ContainerIssues, ContainerIssue } from "./system";
export { issuesApi, runResolution } from "./issues";
export type {
  SystemIssue,
  IssueCounts,
  IssueFeed,
  IssueKind,
  IssueScope,
  IssueSeverity,
  IssueSource,
  IssueResolution,
  IssueInfraFix,
  RescanResult,
} from "./issues";
export { migrationApi } from "./migration";
export { dockerMigrationApi } from "./server-migration";
export type {
  DiscoveredStack,
  DiscoveredGroup,
  DiscoveredService,
  DiscoveredVolumeMount,
  ComposeRepoService,
  OpenshipProjectGroup,
  ReimportResult,
  AdoptResult,
  MigrationPreview,
  MigrationPreviewService,
  MigrationRun,
  MigrationStatus,
  TransferProgress,
  CustomPath,
  PendingItem,
  ConflictAction,
} from "./server-migration";
export type {
  DomainChoice,
  PreflightResult,
  StartServerResult,
  StartCloudResult,
  StartTunnelResult,
  SwitchBackResult,
} from "./migration";
export { dataTransferApi } from "./data-transfer";
export type { DataTransferFile, ImportMode, ImportResult } from "./data-transfer";
export { permissionsApi, RESOURCE_TYPE_LABELS, resourceTypeLabel } from "./permissions";
export type {
  Permission,
  ResourceType,
  PickerGrant,
  ResourceGrant,
  CatalogEntry,
} from "./permissions";
export { settingsApi } from "./settings";
export type {
  BuildMode,
  UserSettingsResponse,
  DefaultDeployTarget,
  DeployDefaultsResponse,
  CloneCredentialsState,
  CloneStrategyPreference,
} from "./settings";
export { cloudApi } from "./cloud";
export type { CloudStatus } from "./cloud";
export { servicesApi, serviceKind } from "./services";
export type { Service, ServiceContainer, ServiceEnvVar, ServiceInput } from "./services";
export { mailApi, isMailEngineUnavailable } from "./mail";
export { mailAdminApi } from "./mail-admin";
export type {
  AdminDomain,
  AdminMailbox,
  AdminAlias,
  CreateDomainPayload,
  UpdateDomainPayload,
  CreateMailboxPayload,
  UpdateMailboxPayload,
  CreateAliasPayload,
  DomainDependents,
  AdditionalDomainDnsState,
  MailServerStats,
  DnsCheck,
  DnsCheckStatus,
  DnsScanResult,
  ComponentAction,
  ComponentActionResult,
  ComponentLogs,
  BulkRestartResult,
  MailBackupPolicy,
  SaveMailBackupPolicyInput,
} from "./mail-admin";
export type {
  MailSetupStep,
  MailStepStatus,
  MailSetupStatus,
  MailCredentials,
  MailEngineState,
  MailWebmailSummary,
  DnsRecord,
  DnsRecords,
  MailSSEEvent,
  PortConflict,
  PortResolution,
  PortUsage,
  MailComponentHealth,
  MailComponentStatus,
  MailComponentDef,
  MailHealthResponse,
  WebmailTargetOption,
} from "./mail";

/* --- Interactive terminal ----------------------------------------- */
export {
  requestTerminalTicket,
  buildTerminalWsUrl,
  TERMINAL_SUBPROTOCOL_PREFIX,
  TERMINAL_RESUME_SUBPROTOCOL_PREFIX,
} from "./terminal";
export type {
  ServerControlMsg,
  ClientControlMsg,
  ReadyMsg,
  ExitMsg,
  ErrorMsg,
  PongMsg,
  ResizeMsg,
  PingMsg,
  TerminalErrorCode,
  TerminalTicketResponse,
} from "./terminal";

/* --- Service terminal --------------------------------------------- */
export {
  requestServiceTerminalTicket,
  buildServiceTerminalWsUrl,
} from "./service-terminal";

/* --- Notifications ------------------------------------------------- */
export { notificationsApi } from "./notifications";
export type {
  NotificationCategory,
  NotificationCategoryGroup,
  NotificationChannel,
  NotificationSubscription,
  NotificationDefault,
  NotificationDelivery,
  ChannelKind,
  DeliveryStatus,
} from "./notifications";

/* --- Audit --------------------------------------------------------- */
export { auditApi } from "./audit";
export type {
  AuditActor,
  AuditEventRow,
  AuditFacets,
  AuditListResponse,
  AuditQuery,
  AuditSettings,
  AuditSource,
} from "./audit";

/* --- Billing ------------------------------------------------------- */
export { billingApi } from "./billing";
export type {
  BillingState,
  CreditPack,
  UsageGroupBy,
  UsageQuery,
  UsageUnits,
  UsageResponse,
  SubscriptionPlanTierId,
  SubscriptionInterval,
} from "./billing";

/* --- Backups ------------------------------------------------------- */
export { backupDestinationsApi, backupsApi } from "./backups";
export {
  serverGithubApi,
  type ServerGithubStatus,
  type ServerGithubMode,
  type ServerGithubDeviceFlow,
} from "./serverGithub";
export type {
  BackupDestinationSummary,
  CreateDestinationInput,
  UpdateDestinationInput,
  BackupPolicy,
  BackupRun,
  BackupRestore,
  DestinationUsage,
  DestinationUsagePolicy,
} from "./backups";

/* --- Auth helpers -------------------------------------------------- */
export { getAuthToken } from "./auth";
