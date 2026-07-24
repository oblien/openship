export { createUserRepo, type User, type NewUser } from "./user.repo";
export { createSessionRepo, type Session } from "./session.repo";
export { createAccountRepo, type Account } from "./account.repo";
export {
  createGitInstallationRepo,
  type GitInstallation,
  type NewGitInstallation,
} from "./git-installation.repo";
export {
  createGithubInstallStateRepo,
  type GithubInstallState,
  type NewGithubInstallState,
  type CreateInstallStateInput,
} from "./github-install-state.repo";
export {
  createPersonalAccessTokenRepo,
  type PersonalAccessToken,
  type PublicPersonalAccessToken,
  type NewPersonalAccessToken,
  type CreatePatInput,
} from "./personal-access-token.repo";
export { createOAuthRepo } from "./oauth.repo";
export { createProjectGroupRepo, type ProjectGroup, type NewProjectGroup } from "./project-group.repo";
export {
  createProjectRepo,
  type Project,
  type NewProject,
  type EnvVar,
  type NewEnvVar,
} from "./project.repo";
export {
  createDeploymentRepo,
  type Deployment,
  type NewDeployment,
  type BuildSession,
  type NewBuildSession,
} from "./deployment.repo";
export { createDomainRepo, type Domain, type NewDomain } from "./domain.repo";
export { createRouteRuleRepo, type RouteRule, type NewRouteRule } from "./route-rule.repo";
export { createWebhookSourceRepo, type WebhookSource, type NewWebhookSource } from "./webhook-source.repo";
export { createSystemNoticeRepo, type SystemNotice, type NewSystemNotice } from "./system-notice.repo";
export { createUpdateStatusRepo, type UpdateStatus, type NewUpdateStatus } from "./update-status.repo";
export {
  createServerModuleStatusRepo,
  type ServerModuleStatus,
  type NewServerModuleStatus,
} from "./server-module-status.repo";
export {
  createCloudWebhookBindingRepo,
  type CloudWebhookBinding,
  type NewCloudWebhookBinding,
} from "./cloud-webhook-binding.repo";
export {
  createGithubWebhookEventRepo,
  type GithubWebhookEvent,
  type NewGithubWebhookEvent,
} from "./github-webhook-event.repo";
export {
  createServiceRepo,
  normalizeRoutingFields,
  toComposeSpec,
  composeSpecsEqual,
  composeSpecDiff,
  type Service,
  type NewService,
  type ServiceDeployment,
  type NewServiceDeployment,
} from "./service.repo";
export {
  createServiceDeploymentRepo,
  type ServiceDeploymentStatus,
} from "./service-deployment.repo";
export { createSettingsRepo, type UserSettings, type NewUserSettings } from "./settings.repo";
export {
  createInstanceSettingsRepo,
  type InstanceSettings,
  type NewInstanceSettings,
} from "./instance-settings.repo";
export { createServerRepo, type Server, type NewServer } from "./server.repo";
export {
  createServerGithubAuthRepo,
  type ServerGithubAuth,
  type NewServerGithubAuth,
} from "./server-github-auth.repo";
export {
  createGithubDeployKeyRepo,
  type GithubDeployKey,
  type NewGithubDeployKey,
} from "./github-deploy-key.repo";
export {
  createServerTunnelRepo,
  type ServerTunnel,
  type NewServerTunnel,
} from "./server-tunnel.repo";
export {
  createMailServerRepo,
  type MailServer,
  type NewMailServer,
} from "./mail-server.repo";
export {
  createAnalyticsRepo,
  type ServerAnalyticsRow,
  type NewServerAnalytics,
  type ServerAnalyticsGeoRow,
  type NewServerAnalyticsGeo,
} from "./analytics.repo";
export {
  createTerminalSessionRepo,
  type TerminalSession,
  type NewTerminalSession,
  type TerminalExitReason,
} from "./terminal-session.repo";
export {
  createServiceTerminalSessionRepo,
  type ServiceTerminalSession,
  type NewServiceTerminalSession,
} from "./service-terminal-session.repo";
export {
  createCloudHandoffCodeRepo,
  type HandoffUserData,
  type HandoffCodeRow,
} from "./cloud-handoff-code.repo";
export {
  createBackupDestinationRepo,
  createBackupPolicyRepo,
  createBackupRunRepo,
  createBackupRestoreRepo,
  type BackupDestination,
  type NewBackupDestination,
  type BackupPolicy,
  type NewBackupPolicy,
  type BackupRun,
  type NewBackupRun,
  type BackupRestore,
  type NewBackupRestore,
  type BackupRunStatus,
  type BackupRestoreStatus,
} from "./backup.repo";
export {
  createDockerMigrationRunRepo,
  type DockerMigrationRun,
  type NewDockerMigrationRun,
  type DockerMigrationStatus,
} from "./docker-migration.repo";
export { createMemberRepo, type Member, type MemberRole } from "./member.repo";
export { createInvitationRepo, type Invitation } from "./invitation.repo";
export { createAuditEventRepo, type AuditEvent, type NewAuditEvent } from "./audit-event.repo";
export { createJobRunRepo, type JobRun, type NewJobRun } from "./job-run.repo";
export { createJobRepo, type Job, type NewJob } from "./job.repo";
export {
  createOrphanedResourceRepo,
  type OrphanedResource,
  type NewOrphanedResource,
} from "./orphaned-resource.repo";
export {
  createResourceGrantRepo,
  type ResourceGrant,
  type Permission,
  type ResourceType,
} from "./resource-grant.repo";
export { createOrganizationRepo, type Organization } from "./organization.repo";
export {
  createInvitationPendingGrantRepo,
  type InvitationPendingGrant,
} from "./invitation-pending-grant.repo";
export {
  createNotificationChannelRepo,
  createNotificationSubscriptionRepo,
  createNotificationDefaultRepo,
  createNotificationDeliveryRepo,
  type NotificationChannel,
  type NotificationSubscription,
  type NotificationDefault,
  type NotificationDelivery,
  type ChannelKind,
  type DeliveryStatus,
} from "./notification.repo";
export {
  createStripeTopupGrantRepo,
  type ClaimTopupGrantInput,
  type ClaimTopupGrantResult,
} from "./stripe-topup-grant.repo";
export {
  createBillingAnniversaryGrantRepo,
  type ClaimAnniversaryGrantInput,
  type ClaimAnniversaryGrantResult,
} from "./billing-anniversary-grant.repo";
export {
  createBillingUsageSnapshotRepo,
  type UsageSnapshot,
  type UsageSnapshotInput,
} from "./billing-usage-snapshot.repo";

// ─── Convenience: pre-bound repos using the singleton db ─────────────────────

import { db } from "../client";
import { createUserRepo } from "./user.repo";
import { createSessionRepo } from "./session.repo";
import { createAccountRepo } from "./account.repo";
import { createGitInstallationRepo } from "./git-installation.repo";
import { createGithubInstallStateRepo } from "./github-install-state.repo";
import { createProjectGroupRepo } from "./project-group.repo";
import { createProjectRepo } from "./project.repo";
import { createDeploymentRepo } from "./deployment.repo";
import { createDomainRepo } from "./domain.repo";
import { createRouteRuleRepo } from "./route-rule.repo";
import { createWebhookSourceRepo } from "./webhook-source.repo";
import { createSystemNoticeRepo } from "./system-notice.repo";
import { createUpdateStatusRepo } from "./update-status.repo";
import { createServerModuleStatusRepo } from "./server-module-status.repo";
import { createCloudWebhookBindingRepo } from "./cloud-webhook-binding.repo";
import { createProjectConnectionRepo } from "./project-connection.repo";
import { createGithubWebhookEventRepo } from "./github-webhook-event.repo";
import { createServiceRepo } from "./service.repo";
import { createServiceDeploymentRepo } from "./service-deployment.repo";
import { createSettingsRepo } from "./settings.repo";
import { createInstanceSettingsRepo } from "./instance-settings.repo";
import { createServerRepo } from "./server.repo";
import { createServerGithubAuthRepo } from "./server-github-auth.repo";
import { createGithubDeployKeyRepo } from "./github-deploy-key.repo";
import { createServerTunnelRepo } from "./server-tunnel.repo";
import { createMailServerRepo } from "./mail-server.repo";
import { createAnalyticsRepo } from "./analytics.repo";
import { createTerminalSessionRepo } from "./terminal-session.repo";
import { createServiceTerminalSessionRepo } from "./service-terminal-session.repo";
import { createCloudHandoffCodeRepo } from "./cloud-handoff-code.repo";
import { createPersonalAccessTokenRepo } from "./personal-access-token.repo";
import { createPersonalAccessTokenGrantRepo } from "./personal-access-token-grant.repo";
import { createOAuthRepo } from "./oauth.repo";
import {
  createBackupDestinationRepo,
  createBackupPolicyRepo,
  createBackupRunRepo,
  createBackupRestoreRepo,
} from "./backup.repo";
import { createDockerMigrationRunRepo } from "./docker-migration.repo";
import { createMemberRepo } from "./member.repo";
import { createInvitationRepo } from "./invitation.repo";
import { createAuditEventRepo } from "./audit-event.repo";
import { createJobRunRepo } from "./job-run.repo";
import { createJobRepo } from "./job.repo";
import { createOrphanedResourceRepo } from "./orphaned-resource.repo";
import { createResourceGrantRepo } from "./resource-grant.repo";
import { createInvitationPendingGrantRepo } from "./invitation-pending-grant.repo";
import { createOrganizationRepo } from "./organization.repo";
import {
  createNotificationChannelRepo,
  createNotificationSubscriptionRepo,
  createNotificationDefaultRepo,
  createNotificationDeliveryRepo,
} from "./notification.repo";
import { createStripeTopupGrantRepo } from "./stripe-topup-grant.repo";
import { createBillingAnniversaryGrantRepo } from "./billing-anniversary-grant.repo";
import { createBillingUsageSnapshotRepo } from "./billing-usage-snapshot.repo";

/**
 * Pre-bound repository instances using the singleton `db`.
 *
 * Usage:
 *   import { repos } from "@repo/db";
 *   const user = await repos.user.findByEmail("test@example.com");
 *
 * For testing, create isolated repos with `createUserRepo(testDb)` etc.
 */
export const repos = {
  user: createUserRepo(db),
  session: createSessionRepo(db),
  account: createAccountRepo(db),
  gitInstallation: createGitInstallationRepo(db),
  githubInstallState: createGithubInstallStateRepo(db),
  projectGroup: createProjectGroupRepo(db),
  project: createProjectRepo(db),
  deployment: createDeploymentRepo(db),
  domain: createDomainRepo(db),
  routeRule: createRouteRuleRepo(db),
  webhookSource: createWebhookSourceRepo(db),
  notice: createSystemNoticeRepo(db),
  updateStatus: createUpdateStatusRepo(db),
  serverModuleStatus: createServerModuleStatusRepo(db),
  cloudWebhookBinding: createCloudWebhookBindingRepo(db),
  projectConnection: createProjectConnectionRepo(db),
  githubWebhookEvent: createGithubWebhookEventRepo(db),
  service: createServiceRepo(db),
  serviceDeployment: createServiceDeploymentRepo(db),
  settings: createSettingsRepo(db),
  instanceSettings: createInstanceSettingsRepo(db),
  server: createServerRepo(db),
  serverGithubAuth: createServerGithubAuthRepo(db),
  githubDeployKey: createGithubDeployKeyRepo(db),
  serverTunnel: createServerTunnelRepo(db),
  mailServer: createMailServerRepo(db),
  analytics: createAnalyticsRepo(db),
  terminalSession: createTerminalSessionRepo(db),
  serviceTerminalSession: createServiceTerminalSessionRepo(db),
  cloudHandoffCode: createCloudHandoffCodeRepo(db),
  personalAccessToken: createPersonalAccessTokenRepo(db),
  patGrant: createPersonalAccessTokenGrantRepo(db),
  oauth: createOAuthRepo(db),
  backupDestination: createBackupDestinationRepo(db),
  backupPolicy: createBackupPolicyRepo(db),
  backupRun: createBackupRunRepo(db),
  backupRestore: createBackupRestoreRepo(db),
  dockerMigrationRun: createDockerMigrationRunRepo(db),
  member: createMemberRepo(db),
  invitation: createInvitationRepo(db),
  auditEvent: createAuditEventRepo(db),
  jobRun: createJobRunRepo(db),
  job: createJobRepo(db),
  orphanedResource: createOrphanedResourceRepo(db),
  resourceGrant: createResourceGrantRepo(db),
  invitationPendingGrant: createInvitationPendingGrantRepo(db),
  organization: createOrganizationRepo(db),
  notificationChannel: createNotificationChannelRepo(db),
  notificationSubscription: createNotificationSubscriptionRepo(db),
  notificationDefault: createNotificationDefaultRepo(db),
  notificationDelivery: createNotificationDeliveryRepo(db),
  stripeTopupGrant: createStripeTopupGrantRepo(db),
  billingAnniversaryGrant: createBillingAnniversaryGrantRepo(db),
  billingUsageSnapshot: createBillingUsageSnapshotRepo(db),
} as const;
