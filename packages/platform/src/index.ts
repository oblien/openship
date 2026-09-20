export * from "./context";
export * from "./authorization";
export * from "./instance-authorization";
export * from "./deployments";
export * from "./deployment-resources";
export * from "./projects";
export * from "./sources";
export * from "./services";
export * from "./domains";
export * from "./dns";
export * from "./credentials";
export * from "./servers";
export * from "./system";
export * from "./apps";
export * from "./backup-destinations";
export * from "./backups";
export * from "./billing";
export * from "./notices";
export * from "./github";
export * from "./permissions";
export * from "./tokens";
export * from "./webhooks";
export * from "./updates";
export * from "./audit";
export * from "./settings";
export * from "./notifications";
export * from "./issues";
export * from "./analytics";
export * from "./jobs";
export * from "./builds";
export * from "./deployments/session-manager";
export * from "./deployments/build-steps";
export * from "./state/cache";
export * from "./state/prompt-registry";
export * from "./state/encryption";

import { createDeploymentOperations, type DeploymentDependencies, type PlatformDeploymentOperations } from "./deployments";
import type { Authorization } from "./authorization";
import { createProjectOperations, type PlatformProjectOperations, type ProjectDependencies } from "./projects";
import { createSourceOperations, type PlatformSourceOperations, type SourceDependencies } from "./sources";
import { createServiceOperations, type PlatformServiceOperations, type ServiceDependencies } from "./services";
import { createDomainOperations, type PlatformDomainOperations, type DomainDependencies } from "./domains";
import { createDnsOperations, type PlatformDnsOperations, type DnsDependencies } from "./dns";
import { createCredentialOperations, type PlatformCredentialOperations, type CredentialDependencies } from "./credentials";
import { createServerOperations, type PlatformServerOperations, type ServerDependencies } from "./servers";
import { createSystemOperations, type PlatformSystemOperations, type SystemDependencies } from "./system";
import { createAppOperations, type PlatformAppOperations, type AppDependencies } from "./apps";
import { createBackupDestinationOperations, type PlatformBackupDestinationOperations, type BackupDestinationDependencies } from "./backup-destinations";
import { createBackupOperations, type PlatformBackupOperations, type BackupDependencies } from "./backups";

import { createJobOperations, type PlatformJobOperations, type JobDependencies } from "./jobs";

import { createAnalyticsOperations, type PlatformAnalyticsOperations, type AnalyticsDependencies } from "./analytics";

import { createIssueOperations, type PlatformIssueOperations, type IssueDependencies } from "./issues";

import { createNotificationOperations, type PlatformNotificationOperations, type NotificationDependencies } from "./notifications";

import { createUserSettingsOperations, type PlatformUserSettingsOperations, type UserSettingsDependencies } from "./settings";

import { createAuditOperations, type PlatformAuditOperations, type AuditDependencies } from "./audit";

import { createUpdateOperations, type PlatformUpdateOperations, type UpdateDependencies } from "./updates";

import { createWebhookOperations, type PlatformWebhookOperations, type WebhookDependencies } from "./webhooks";

import { createTokenOperations, type PlatformTokenOperations, type TokenDependencies } from "./tokens";

import { createPermissionOperations, type PlatformPermissionOperations, type PermissionDependencies } from "./permissions";

import { createGitHubOperations, type PlatformGitHubOperations, type GitHubDependencies } from "./github";

import { createNoticeOperations, type PlatformNoticeOperations, type NoticeDependencies } from "./notices";

import { createBillingOperations, type PlatformBillingOperations, type BillingDependencies } from "./billing";

export interface PlatformKernel {
  readonly resolveScope: Authorization["resolveScope"];
  readonly deployments: PlatformDeploymentOperations;
  readonly projects: PlatformProjectOperations;
  readonly sources: PlatformSourceOperations;
  readonly services: PlatformServiceOperations;
  readonly domains: PlatformDomainOperations;
  readonly dns: PlatformDnsOperations;
  readonly credentials: PlatformCredentialOperations;
  readonly servers: PlatformServerOperations;
  readonly system: PlatformSystemOperations;
  readonly apps: PlatformAppOperations;
  readonly backupDestinations: PlatformBackupDestinationOperations;
  readonly backups: PlatformBackupOperations;
  readonly billing: PlatformBillingOperations;
  readonly notices: PlatformNoticeOperations;
  readonly github: PlatformGitHubOperations;
  readonly permissions: PlatformPermissionOperations;
  readonly tokens: PlatformTokenOperations;
  readonly webhooks: PlatformWebhookOperations;
  readonly updates: PlatformUpdateOperations;
  readonly audit: PlatformAuditOperations;
  readonly settings: PlatformUserSettingsOperations;
  readonly notifications: PlatformNotificationOperations;
  readonly issues: PlatformIssueOperations;
  readonly analytics: PlatformAnalyticsOperations;
  readonly jobs: PlatformJobOperations;
}

/** Composition boundary. It acquires no resources and owns no implicit global state. */
export function createPlatform(deps: DeploymentDependencies & { projects?: ProjectDependencies; sources?: SourceDependencies; services?: ServiceDependencies; domains?: DomainDependencies; dns?: DnsDependencies; credentials?: CredentialDependencies; servers?: ServerDependencies; system?: SystemDependencies; apps?: AppDependencies; backupDestinations?: BackupDestinationDependencies; backups?: BackupDependencies; billing?: BillingDependencies; notices?: NoticeDependencies; github?: GitHubDependencies; permissions?: PermissionDependencies; tokens?: TokenDependencies; webhooks?: WebhookDependencies; updates?: UpdateDependencies; audit?: AuditDependencies; settings?: UserSettingsDependencies; notifications?: NotificationDependencies; issues?: IssueDependencies; analytics?: AnalyticsDependencies; jobs?: JobDependencies }): PlatformKernel {
  return Object.freeze({
    resolveScope: deps.authorization.resolveScope,
    deployments: createDeploymentOperations(deps),
    projects: createProjectOperations(deps.authorization, deps.projects),
    sources: createSourceOperations(deps.authorization, deps.sources),
    services: createServiceOperations(deps.authorization, deps.services),
    domains: createDomainOperations(deps.authorization, deps.domains),
    dns: createDnsOperations(deps.authorization, deps.dns),
    credentials: createCredentialOperations(deps.authorization, deps.credentials),
    servers: createServerOperations(deps.authorization, deps.servers),
    system: createSystemOperations(deps.authorization, deps.system),
    apps: createAppOperations(deps.authorization, deps.apps),
    backupDestinations: createBackupDestinationOperations(deps.authorization, deps.backupDestinations),
    backups: createBackupOperations(deps.authorization, deps.backups),
    billing: createBillingOperations(deps.authorization, deps.billing),
    notices: createNoticeOperations(deps.authorization, deps.notices),
    github: createGitHubOperations(deps.authorization, deps.github),
    permissions: createPermissionOperations(deps.authorization, deps.permissions),
    tokens: createTokenOperations(deps.authorization, deps.tokens),
    webhooks: createWebhookOperations(deps.authorization, deps.webhooks),
    updates: createUpdateOperations(deps.authorization, deps.updates),
    audit: createAuditOperations(deps.authorization, deps.audit),
    settings: createUserSettingsOperations(deps.authorization, deps.settings),
    notifications: createNotificationOperations(deps.authorization, deps.notifications),
    issues: createIssueOperations(deps.authorization, deps.issues),
    analytics: createAnalyticsOperations(deps.authorization, deps.analytics),
    jobs: createJobOperations(deps.authorization, deps.jobs),
  });
}
