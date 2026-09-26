import type { Deployment, Project, Service, Domain, DomainDnsChallenge, DnsCredential, PublicCredential, ServerDetail, ServerContainerStatus, SystemInfo, SystemOperations } from "../src";

export function credentialFixture(id = "credential-a"): PublicCredential {
  return { id, provider: "docker-registry", providerLabel: "Container registry", name: "Production registry", selector: "ghcr.io",
    publicFields: { username: "operator" }, secretsMasked: { secret: "••••••••" }, status: "active",
    lastVerifiedAt: null, lastError: null, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" };
}

export function domainFixture(id = "domain-a", projectId = "project-a"): Domain {
  return {
    id, projectId, ownerType: "project", webhookSourceId: null, serviceId: null,
    hostname: "app.example.com", targetPort: null, targetPath: null, domainType: "custom",
    isPrimary: false, redirectTo: null, redirectStatus: null, externalIngress: false,
    manualSsl: false, status: "pending", verificationToken: "verify-this-domain",
    verified: false, verifiedAt: null, verifyAttempts: 0, lastVerifyError: null,
    lastCheckedAt: null, sslStatus: "none", sslChallenge: "http-01", sslIssuer: null,
    sslExpiresAt: null, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
  };
}
export function dnsCredentialFixture(id = "dns-a", organizationId = "org-a"): DnsCredential {
  return {
    id, organizationId, provider: "cloudflare", name: "Production DNS", status: "active",
    tokenMasked: "••••••••", lastVerifiedAt: null,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

export function domainDnsChallengeFixture(): DomainDnsChallenge {
  return {
    id: "dns-attempt", domainId: "domain-a", mode: "manual", status: "waiting",
    record: { type: "TXT", name: "_acme-challenge.example.com", value: "public-ACME-proof" },
    expiresAt: "2026-09-27T00:00:00.000Z", logs: "Add the TXT record.", error: null,
    createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z",
  };
}

export function serviceFixture(id = "service-a", projectId = "project-a"): Service {
  return {
    id,
    projectId,
    kind: "compose",
    name: "web",
    image: "nginx:alpine",
    build: null,
    dockerfile: null,
    buildArgs: {},
    ports: [],
    dependsOn: [],
    environment: {},
    volumes: [],
    namespaceVolumes: true,
    command: null,
    commandArgv: null,
    restart: "unless-stopped",
    advanced: {},
    exposed: false,
    exposedPort: null,
    domain: null,
    customDomain: null,
    domainType: "free",
    publicEndpoints: [],
    rootDirectory: null,
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    framework: null,
    packageManager: null,
    buildImage: null,
    alwaysRebuildGlobs: null,
    enabled: true,
    sortOrder: 0,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    drift: null,
  };
}

export function projectFixture(
  id = "project-a",
  name = "Example",
  organizationId = "org-a",
): Project {
  return {
    id,
    organizationId,
    groupId: `group-${id}`,
    name,
    slug: name.toLowerCase(),
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

export function deploymentFixture(projectId = "project-a", organizationId = "org-a"): Deployment {
  return {
    id: `dep-${projectId}`,
    projectId,
    organizationId,
    branch: "main",
    commitSha: null,
    commitMessage: null,
    commitShaBefore: null,
    trigger: "manual",
    environment: "production",
    framework: null,
    status: "queued",
    imageRef: null,
    buildDurationMs: null,
    version: 1,
    releaseVersion: null,
    containerId: null,
    url: null,
    meta: null,
    envVars: null,
    errorMessage: null,
    errorCode: null,
    errorDetails: null,
    changedPaths: null,
    changedPathsTruncated: false,
    forceAll: false,
    rollbackStrategy: "snapshot",
    artifactRetainedAt: null,
    pinned: false,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

export function serverFixture(id = "server-a"): ServerDetail {
  return { id, name: "Production", isLocal: false, sshHost: "203.0.113.10", sshPort: 22, sshUser: "root",
    sshAuthMethod: "key", sshKeyPath: null, hasStoredKeyMaterial: true, sshJumpHost: null, sshArgs: null, sshTransport: "direct",
    createdAt: "2026-09-12T00:00:00.000Z", country: null, projectCount: 0, hostChannel: null };
}

export function serverContainerFixture(serverId = "server-a", organizationId = "org-a"): ServerContainerStatus {
  return { id: `container-${serverId}`, serverId, organizationId, component: "edge", runningLabel: "edge:old", pinnedLabel: "edge:new",
    runningVersion: "old", pinnedVersion: "new", behind: true, latestInProgress: false, detail: null,
    checkedAt: "2026-09-12T00:00:00.000Z", createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" };
}

export function systemInfoFixture(): SystemInfo {
  return { selfHosted: true, deployMode: "docker", isServerHost: true, hostControlEnabled: true, version: "0.7.2", authMode: "local",
    productMode: "platform", teamMode: "single_user", migrationTargetUrl: null, migrationInProgress: false,
    cloudAuthUrl: "https://openship.test", cloudApiUrl: "https://api.openship.test" };
}

export function instanceSettingsFixture(): Awaited<ReturnType<SystemOperations["getSettings"]>> {
  return { configured: true, authMode: "local", tunnelProvider: null, defaultBuildMode: "auto", defaultRollbackWindow: 3,
    invitationMailSource: "platform", teamMode: "single_user", migrationTargetUrl: null, migratedAt: null,
    autoUpdateInfra: false, autoScanInfra: true, productMode: null, productModeEffective: "platform", hostControl: null,
    hostControlEffective: true, teamReachability: null };
}

export function backupDestinationFixture(id = "destination-a"): import("../src").BackupDestination {
  return { id, name: "Backups", kind: "s3_compatible", endpoint: "https://storage.example.test", region: "auto", bucket: "backups", pathPrefix: null,
    sshHost: null, sshPort: null, sshUser: null, serverId: null,
    hasAccessKeyId: true, hasSecretAccessKey: true, hasSftpPassword: false, hasSftpPrivateKey: false, hasSftpKeyPassphrase: false,
    lastVerifiedAt: null, lastVerifyError: null, isDefault: false,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z", stats: null };
}

export function backupPolicyFixture(id = "policy-a", projectId = "project-a", destinationId = "destination-a"): import("../src").BackupPolicy {
  return { id, sourceKind: "service", projectId, serviceId: "service-a", mailServerId: null, destinationId,
    enabled: true, cronExpression: null, triggerOnPreDeploy: false, webhookToken: null, webhookLastFiredAt: null,
    retainCount: 7, retainDays: null, payloadKind: "auto", payloadConfig: {}, preHook: null, postHook: null, hookTimeoutSeconds: 300,
    compressionAlgo: "zstd", encryptionAtRest: false, createdBy: "alice", deletedAt: null,
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" };
}
export function backupRunFixture(id = "run-a", projectId = "project-a", destinationId = "destination-a"): import("../src").BackupRun {
  return { id, batchId: "batch-a", policyId: "policy-a", destinationId, sourceKind: "service", projectId, serviceId: "service-a", mailServerId: null,
    organizationId: "org-a", status: "succeeded", triggeredBy: "manual", triggeredByUserId: "alice", clientIp: null,
    startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:01:00.000Z", lastEventAt: "2026-09-12T00:01:00.000Z",
    executionStartedAt: "2026-09-12T00:00:00.000Z", executionFinishedAt: "2026-09-12T00:01:00.000Z",
    objectKeyPrefix: "backup/run-a", manifestKey: "backup/run-a/manifest.json", bytesTransferred: 1024,
    artifacts: [], errorMessage: null, hookLog: null, retentionLockedUntil: null, deletedAt: null };
}
export function backupRestoreFixture(id = "restore-a"): import("../src").BackupRestore {
  return { id, runId: "run-a", destinationId: "destination-a", projectId: "project-a", serviceId: "service-a", organizationId: "org-a",
    status: "prepared", mode: "in_place", forkServiceId: null, forkMailServerId: null, startedAt: "2026-09-12T00:00:00.000Z", finishedAt: null,
    lastEventAt: "2026-09-12T00:01:00.000Z", bytesRestored: null, errorMessage: null, clientIp: null, meta: {},
    cancelRequested: false, cancelRequestedAt: null, cancelledAt: null, confirmationToken: null };
}
