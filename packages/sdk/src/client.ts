import { isCreateDeploymentResult, parseCreateDeploymentInput, parseInput, isRecord, PrepareDeployBody, BuildAccessBody, ResourceIdSchema, type PreparedProject, type DeploymentOperations } from "@repo/contracts";
import { ApiError } from "./errors";
import { HttpClient, type HttpClientOptions } from "./http";
import { snapshotSourceInput, type DeploySourceInput, type SourceDeploymentResult } from "./source-input";
import { createRemoteDeploymentResources } from "./deployment-client";
import { createDeploymentHandle, type DeploymentHandle } from "./deployment-handle";
import { createRemoteProjectOperations } from "./project-client";
import { createRemoteSourceOperations } from "./source-client";
import { createRemoteServiceOperations } from "./service-client";
import { createRemoteDomainOperations } from "./domain-client";
import { createRemoteDnsOperations } from "./dns-client";
import { createRemoteCredentialOperations } from "./credential-client";
import { createRemoteServerOperations } from "./server-client";
import { createRemoteSystemOperations } from "./system-client";
import { createRemoteAppOperations } from "./app-client";
import { createRemoteBackupDestinationOperations } from "./backup-destination-client";
import { createRemoteBackupOperations } from "./backup-client";
import { createRemoteJobOperations } from "./job-client";
import type { JobOperations } from "@repo/contracts";
import { createRemoteAnalyticsOperations } from "./analytics-client";
import type { AnalyticsOperations } from "@repo/contracts";
import { createRemoteIssueOperations } from "./issues-client";
import type { IssueOperations } from "@repo/contracts";
import { createRemoteNotificationOperations } from "./notifications-client";
import type { NotificationOperations } from "@repo/contracts";
import { createRemoteUserSettingsOperations } from "./settings-client";
import type { UserSettingsOperations } from "@repo/contracts";
import { createRemoteAuditOperations } from "./audit-client";
import type { AuditOperations } from "@repo/contracts";
import { createRemoteUpdateOperations } from "./updates-client";
import type { UpdateOperations } from "@repo/contracts";
import { createRemoteWebhookOperations } from "./webhooks-client";
import type { WebhookOperations } from "@repo/contracts";
import { createRemoteTokenOperations } from "./tokens-client";
import type { TokenOperations } from "@repo/contracts";
import { createRemotePermissionOperations } from "./permissions-client";
import type { PermissionOperations } from "@repo/contracts";
import { createRemoteGitHubOperations } from "./github-client";
import type { GitHubOperations } from "@repo/contracts";
import { createRemoteNoticeOperations } from "./notices-client";
import type { NoticeOperations } from "@repo/contracts";
import { createRemoteBillingOperations } from "./billing-client";
import type { BillingOperations } from "@repo/contracts";
import type { BackupOperations } from "@repo/contracts";
import type { BackupDestinationOperations } from "@repo/contracts";
import { deploySourceWorkflow } from "./source-workflow";
import type { ProjectOperations, SourceOperations, ServiceOperations, DomainOperations, DnsOperations, CredentialOperations, ServerOperations, SystemOperations, AppOperations } from "@repo/contracts";

export { ApiError } from "./errors";
export { OpenshipOperatorClient, type OpenshipOperatorClientOptions } from "./operator-client";
export { OperationError, ValidationError, parseOptionalEnvironmentScope } from "@repo/contracts";
export { normalizeComposeServices } from "./compose";
export { HttpClient, type HttpClientOptions, type HttpRequestOptions, type PaginateOptions } from "./http";
export { parseSSE, type SSEEvent } from "./events";
export { iteratePages, type Page, type PageRequest, type PageIteratorOptions } from "./pagination";
export { createDeploymentHandle, waitForDeployment, consumeDeploymentEvents, type DeploymentHandle, type DeploymentOutcome, type WaitForDeploymentOptions, type DecodedDeploymentEvent, type DeploymentStreamResult } from "./deployment-handle";
export type { DeploySourceInput, SourceDeploymentResult } from "./source-input";
export type * from "@repo/contracts";

export interface OpenshipClientOptions extends Omit<HttpClientOptions, "internalToken"> {}

/** Remote facade. The client entry has no native platform or database dependency. */
export class OpenshipClient {
  readonly deployments: DeploymentOperations;
  readonly projects: ProjectOperations;
  readonly sources: SourceOperations;
  readonly services: ServiceOperations;
  readonly domains: DomainOperations;
  readonly dns: DnsOperations;
  readonly credentials: CredentialOperations;
  readonly servers: ServerOperations;
  readonly system: SystemOperations;
  readonly apps: AppOperations;
  readonly backupDestinations: BackupDestinationOperations;
  readonly backups: BackupOperations;
  readonly billing: BillingOperations;
  readonly notices: NoticeOperations;
  readonly github: GitHubOperations;
  readonly permissions: PermissionOperations;
  readonly tokens: TokenOperations;
  readonly webhooks: WebhookOperations;
  readonly updates: UpdateOperations;
  readonly audit: AuditOperations;
  readonly settings: UserSettingsOperations;
  readonly notifications: NotificationOperations;
  readonly issues: IssueOperations;
  readonly analytics: AnalyticsOperations;
  readonly jobs: JobOperations;
  readonly http: HttpClient;
  private readonly options: Readonly<OpenshipClientOptions>;

  constructor(options: OpenshipClientOptions) {
    this.options = Object.freeze({ ...options });
    const http = this.http = new HttpClient(options);
    this.projects = createRemoteProjectOperations(http);
    this.sources = createRemoteSourceOperations(http);
    this.services = createRemoteServiceOperations(http);
    this.domains = createRemoteDomainOperations(http);
    this.dns = createRemoteDnsOperations(http);
    this.credentials = createRemoteCredentialOperations(http);
    this.servers = createRemoteServerOperations(http);
    this.system = createRemoteSystemOperations(http);
    this.apps = createRemoteAppOperations(http);
    this.backupDestinations = createRemoteBackupDestinationOperations(http);
    this.backups = createRemoteBackupOperations(http);
    this.billing = createRemoteBillingOperations(http);
    this.notices = createRemoteNoticeOperations(http);
    this.github = createRemoteGitHubOperations(http);
    this.permissions = createRemotePermissionOperations(http);
    this.tokens = createRemoteTokenOperations(http);
    this.webhooks = createRemoteWebhookOperations(http);
    this.updates = createRemoteUpdateOperations(http);
    this.audit = createRemoteAuditOperations(http);
    this.settings = createRemoteUserSettingsOperations(http);
    this.notifications = createRemoteNotificationOperations(http);
    this.issues = createRemoteIssueOperations(http);
    this.analytics = createRemoteAnalyticsOperations(http);
    this.jobs = createRemoteJobOperations(http);
    this.deployments = Object.freeze({
      ...createRemoteDeploymentResources(http),
      async prepare(value) {
        const response = await http.request("/deployments/prepare", { method: "POST", body: JSON.stringify(parseInput(PrepareDeployBody, value)) });
        if (!isRecord(response) || typeof response.stack !== "string" || !isRecord(response.repository)) throw new ApiError("Invalid preparation response", 502, response);
        return response as PreparedProject;
      },
      async buildAccess(value) {
        const response = await http.request("/deployments/build/access", { method: "POST", body: JSON.stringify(parseInput(BuildAccessBody, value)) });
        if (!isCreateDeploymentResult(response)) throw new ApiError("Invalid build response", 502, response);
        return response;
      },
      async start(value) {
        const id = parseInput(ResourceIdSchema, value);
        // The HTTP start route streams after dispatch; the first event contains
        // the durable ids and closing the transport does not cancel the build.
        for await (const event of http.events(`/deployments/${encodeURIComponent(id)}/build`, { method: "POST" })) {
          if (event.event !== "started") continue;
          let response: unknown;
          try { response = JSON.parse(event.data); } catch { throw new ApiError("Invalid build response", 502, null); }
          if (!isCreateDeploymentResult(response)) throw new ApiError("Invalid build response", 502, response);
          return response;
        }
        throw new ApiError("Build start did not return a deployment", 502, null);
      },
      async create(value) {
        const input = parseCreateDeploymentInput(value);
        const body = await http.request<{ data?: unknown }>("/deployments", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!isCreateDeploymentResult(body?.data))
          throw new ApiError("Invalid deployment response", 502, body);
        return body.data;
      },
    } satisfies DeploymentOperations);
  }

  /** A new fixed tenant view; other views retain their credentials and organization. */
  scope(organizationId: string): OpenshipClient {
    return new OpenshipClient({ ...this.options, organizationId });
  }

  deployment(id: string): DeploymentHandle {
    return createDeploymentHandle(this.deployments, id);
  }

  async deploy(input: DeploySourceInput): Promise<SourceDeploymentResult> {
    const command = snapshotSourceInput(input);
    return deploySourceWorkflow(this, command);
  }
}
