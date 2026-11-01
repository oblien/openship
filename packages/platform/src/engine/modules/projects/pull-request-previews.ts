import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  safeErrorMessage,
  normalizeCustomHostname,
  isValidCustomHostname,
  inspectCommandEnvironment,
  isHostPathSource,
  parseVolumeMount,
  type ComposeAdvanced,
} from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import {
  repos,
  type Project,
  type Service,
  type PullRequestPreview,
  type NewProject,
  type NewService,
} from "@repo/db";
import type { ExecutionContext } from "@repo/platform";
import { buildBackgroundContext } from "../../lib/background-context";
import { resolveOrgOwner } from "../../lib/org-actor";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { githubFetch } from "../github/github.auth";
import { ensureSharedWebhook } from "./project-git-webhook";
import { withProjectCreationLock, assertProjectQuota } from "./project-crud.service";
import { triggerDeployment } from "../deployments/build.service";
import { teardownProject } from "./project-teardown";
import { addDomain, verifyDomain } from "../domains/domain.service";
import { runtimeTarget } from "../../config/index";
import { syncProjectRouteState } from "../domains/project-route.service";
import {
  readPreviewRouteProtection,
  inheritPreviewRouteProtection,
  syncPreviewRouteProtection,
} from "../../lib/route-protection";

interface PullRequest {
  state: "open" | "closed";
  draft?: boolean;
  number: number;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

export function previewEligible(
  pr: PullRequest,
  project: Pick<Project, "gitOwner" | "gitRepo" | "gitBranch">,
): boolean {
  const repo = `${project.gitOwner}/${project.gitRepo}`.toLowerCase();
  return (
    pr.state === "open" &&
    !pr.draft &&
    pr.base.ref === project.gitBranch &&
    pr.head.repo?.full_name.toLowerCase() === repo &&
    pr.base.repo.full_name.toLowerCase() === repo &&
    /^[a-f\d]{40}$/i.test(pr.head.sha)
  );
}

/** Previews inherit build configuration; persistent data and production env are separate. */
export function previewEnvironmentInput(
  source: Project,
  services: Service[],
  number: number,
  branch: string,
) {
  const suffix = createHash("sha256").update(source.id).digest("hex").slice(0, 6);
  const slug = `${source.slug.slice(0, 35)}-pr-${number}-${suffix}`;
  const safeVolumes = (volumes: readonly string[] | null | undefined, deployed = true) => {
    const kept: string[] = [];
    for (const spec of volumes ?? []) {
      const { source } = parseVolumeMount(spec);
      if (isHostPathSource(source) || source === "." || source === "..") {
        // Strip host paths from disabled copies before they can be enabled.
        if (!deployed) continue;
        throw new AppError(
          "PR previews require isolated named volumes; host bind mounts must be removed from the preview template.",
          400,
        );
      }
      kept.push(spec);
    }
    return volumes ? kept : null;
  };
  const commands = (row: {
    installCommand?: string | null;
    buildCommand?: string | null;
    startCommand?: string | null;
  }) => {
    for (const command of [row.installCommand, row.buildCommand, row.startCommand])
      if (inspectCommandEnvironment(command ?? "").keys.length)
        throw new AppError(
          "Move embedded command variables to Environment before enabling previews. Configure preview values separately.",
          400,
        );
  };
  commands(source);
  for (const command of [
    source.workspacePrepareCommand,
    ...(source.releaseCommands ?? []),
    ...(source.roles ?? []).map((role) => role.command),
  ])
    commands({ startCommand: command });
  const fields = [
    "serverId",
    "workspaceId",
    "framework",
    "packageManager",
    "installCommand",
    "buildCommand",
    "outputDirectory",
    "productionPaths",
    "rootDirectory",
    "composePath",
    "startCommand",
    "releaseCommands",
    "roles",
    "buildImage",
    "runtimeVersion",
    "runtimeImage",
    "productionMode",
    "port",
    "hasServer",
    "hasBuild",
    "sourceKind",
    "buildKind",
    "workloadType",
    "runtimeMode",
    "readiness",
    "resources",
    "buildResources",
    "workspacePrepareCommand",
    "gitProvider",
    "gitOwner",
    "gitRepo",
    "gitUrl",
    "installationId",
    "cloneTokenEncrypted",
    "cloneTokenSetAt",
  ] as const;
  const project = Object.fromEntries(
    fields.map((key) => [key, source[key]]),
  ) as Partial<NewProject>;
  return {
    project: {
      ...project,
      organizationId: source.organizationId,
      groupId: source.groupId,
      name: `${source.name} · PR #${number}`,
      slug,
      environmentName: `PR #${number}`,
      environmentSlug: `pr-${number}-${suffix}`,
      environmentType: "preview",
      gitBranch: branch,
      autoDeploy: false,
      volumes: safeVolumes(source.volumes),
      previewSettings: null,
    } as Omit<NewProject, "id">,
    services: services.map((row) => {
      commands(row);
      const advanced = row.advanced ?? {};
      const deployed = row.enabled !== false;
      const externalNamespaceFields = (["networkMode", "pidMode"] as const).filter((field) => {
        const mode = advanced[field]?.trim();
        return mode === "host" || mode?.startsWith("container:");
      });
      if (deployed && (row.namespaceVolumes === false || externalNamespaceFields.length > 0))
        throw new AppError(
          `Service ${row.name} shares host resources. PR previews require isolated services.`,
          400,
        );
      // Copy build/runtime settings, with new infrastructure identities and fresh volumes.
      const { id, projectId, createdAt, updatedAt, ...copy } = row;
      const previewAdvanced: ComposeAdvanced = { ...advanced };
      // Start can enable a disabled service without preview admission. Remove
      // external namespaces from the copy, just like its host bind mounts.
      for (const field of externalNamespaceFields) delete previewAdvanced[field];
      if (advanced.files?.length || advanced.build)
        throw new AppError(
          `Service ${row.name} has generated configuration that may contain production credentials. Use repository source and preview variables for previews.`,
          400,
        );
      // Imported inline environment belongs to the source. Only its unresolved
      // templates survive; preview-scoped rows supply their values on deployment.
      const environment = Object.fromEntries(
        (advanced.environmentTemplateKeys ?? [])
          .filter((key) => row.environment?.[key] !== undefined)
          .map((key) => [key, row.environment![key]!]),
      );
      const ports = row.publicEndpoints?.length
        ? row.publicEndpoints.map((endpoint) => endpoint.port)
        : row.exposed
          ? [Number(row.exposedPort ?? 3000)]
          : [];
      const publicEndpoints = [...new Set(ports)].map((port) => {
        const label = `${source.slug.slice(0, 24)}-pr-${number}-${createHash("sha256").update(`${source.id}:${row.name}`).digest("hex").slice(0, 8)}-${port}`;
        return source.previewSettings?.baseDomain
          ? {
              port,
              domainType: "custom" as const,
              customDomain: `${label}.${source.previewSettings.baseDomain}`,
            }
          : { port, domainType: "free" as const, domain: label };
      });
      return {
        sourceId: id,
        row: {
          ...copy,
          namespaceVolumes: true,
          volumes: safeVolumes(row.volumes, deployed) ?? [],
          ports: (row.ports ?? []).map((port) => port.split(":").at(-1)!),
          hostPort: null,
          domain: publicEndpoints[0]?.domain ?? null,
          customDomain: publicEndpoints[0]?.customDomain ?? null,
          domainType: source.previewSettings?.baseDomain ? "custom" : "free",
          publicEndpoints,
          environment,
          buildArgs: Object.fromEntries(
            (advanced.buildArgTemplateKeys ?? [])
              .filter((key) => row.buildArgs?.[key] !== undefined)
              .map((key) => [key, row.buildArgs![key]!]),
          ),
          importedSpec: null,
          driftSpec: null,
          advanced: previewAdvanced,
        } as Omit<NewService, "id" | "projectId">,
      };
    }),
  };
}

export async function configurePreviews(
  ctx: ExecutionContext,
  projectId: string,
  settings: NonNullable<Project["previewSettings"]>,
) {
  const source = await repos.project.findByIdInOrganization(projectId, ctx.organizationId);
  if (!source) throw new AppError("Project not found", 404);
  if (settings.protectionHostname)
    settings = { ...settings, protectionHostname: settings.protectionHostname.trim().toLowerCase() };
  const baseDomain = settings.baseDomain?.trim()
    ? normalizeCustomHostname(settings.baseDomain)
    : undefined;
  if (baseDomain && (baseDomain.startsWith("*.") || !isValidCustomHostname(baseDomain)))
    throw new AppError("Enter a valid base domain, without '*.'.", 400);
  if (source.previewSettings?.protectionHostname !== settings.protectionHostname &&
      (await repos.pullRequestPreview.list(source.id, ctx.organizationId)).some((row) => row.projectId))
    throw new AppError("Disable previews and finish cleanup before changing their password source.",
      409, "PREVIEW_ROUTE_PROTECTION_MANAGED");
  if (settings.enabled) {
    await readPreviewRouteProtection(ctx, source, { ...settings, baseDomain });
    if (
      source.environmentType === "preview" ||
      source.gitProvider !== "github" ||
      !source.gitOwner ||
      !source.gitRepo
    )
      throw new AppError("Enable previews on a GitHub-backed source environment.", 400);
    if (source.clusterId)
      throw new AppError(
        "PR preview automation requires a Docker or direct server deployment target.",
        400,
      );
    previewEnvironmentInput(
      source,
      await repos.service.listByProject(source.id),
      1,
      source.gitBranch ?? "main",
    );
    await ensureSharedWebhook(ctx, source, source.gitOwner, source.gitRepo);
    // This also verifies that the chosen GitHub identity can read pull requests.
    const open = await githubFetch<PullRequest[]>({
      ctx,
      owner: source.gitOwner,
      repo: source.gitRepo,
      url: `https://api.github.com/repos/${encodeURIComponent(source.gitOwner)}/${encodeURIComponent(source.gitRepo)}/pulls`,
      params: { state: "open", base: source.gitBranch, per_page: 100 },
    });
    await repos.project.update(source.id, { previewSettings: { ...settings, baseDomain } });
    for (const pr of open.filter((pr) => previewEligible(pr, source)))
      await repos.pullRequestPreview.enqueue({
        organizationId: source.organizationId,
        sourceProjectId: source.id,
        owner: source.gitOwner,
        repo: source.gitRepo,
        number: pr.number,
      });
  } else {
    await repos.project.update(source.id, { previewSettings: { ...settings, baseDomain } });
    for (const row of await repos.pullRequestPreview.list(source.id, source.organizationId))
      await repos.pullRequestPreview.enqueue(row);
  }
  return { settings: { ...settings, baseDomain } };
}

export async function enqueuePullRequestPreviews(payload: unknown) {
  const value = payload as { number?: number; repository?: { full_name?: string } };
  if (!Number.isSafeInteger(value.number) || value.number! < 1 || !value.repository?.full_name)
    return;
  const [owner, repo] = value.repository.full_name.split("/");
  if (!owner || !repo) return;
  for (const source of await repos.project.findByGitRepo(owner, repo)) {
    if (
      !source.previewSettings?.enabled ||
      source.deletedAt ||
      source.environmentType === "preview"
    )
      continue;
    await repos.pullRequestPreview.enqueue({
      organizationId: source.organizationId,
      sourceProjectId: source.id,
      owner,
      repo,
      number: value.number!,
    });
  }
}

/** Validate the current PR revision after Compose refresh, before snapshot/admission. */
export async function preparePreviewDeployment(
  ctx: ExecutionContext,
  child: Project,
  admission: { id: string; token: string },
) {
  const intent = await repos.pullRequestPreview.findLeased(admission.id, admission.token);
  if (!intent || intent.projectId !== child.id || intent.organizationId !== ctx.organizationId)
    throw new AppError("Preview admission expired", 409);
  const source = await repos.project.findByIdInOrganization(
    intent.sourceProjectId,
    ctx.organizationId,
  );
  if (!source?.previewSettings?.enabled || source.deletedAt || source.deletionInProgress)
    throw new AppError("Preview deployments are disabled", 409);
  previewEnvironmentInput(child, [], intent.number, child.gitBranch ?? "main");
  const currentServices = await repos.service.listByProject(child.id);
  const sanitized = previewEnvironmentInput(
    source,
    currentServices,
    intent.number,
    child.gitBranch ?? "main",
  );
  const sourceServices = await repos.service.listByProject(source.id);
  const vars = await repos.project.listEnvVars(source.id, "preview");
  for (const item of sanitized.services) {
    await repos.service.update(item.sourceId, item.row);
    const original = sourceServices.find((service) => service.name === item.row.name);
    await repos.project.bulkSetEnvVars(
      child.id,
      "production",
      vars.filter((value) => value.serviceId === original?.id),
      item.sourceId,
    );
  }
  const baseDomain = source.previewSettings?.baseDomain;
  // Persist protection before syncProjectRouteState/addDomain can publish any
  // existing route. The shared registration guard covers later aliases/retries.
  await readPreviewRouteProtection(ctx, source);
  if (baseDomain && child.workloadType !== "worker") {
    const services = await repos.service.listByProject(child.id);
    const publicServices = services.filter((service) => service.exposed && service.customDomain);
    for (const hostname of [
      `${child.slug}.${baseDomain}`,
      ...publicServices.flatMap((service) => (service.publicEndpoints ?? []).map((endpoint) => endpoint.customDomain!)),
    ]) await inheritPreviewRouteProtection(child.id, hostname);
    if (
      !services.some((service) => service.kind === "monorepo") &&
      !["services", "docker-compose", "monorepo"].includes(child.framework ?? "")
    ) {
      const hostname = `${child.slug}.${baseDomain}`;
      await syncProjectRouteState(child, {
        nextPublicEndpoints: [
          {
            domainType: "custom",
            customDomain: hostname,
            ...(child.hasServer ? { port: child.port ?? 3000 } : { targetPath: "/" }),
          },
        ],
      });
    }
    for (const service of publicServices)
      for (const endpoint of service.publicEndpoints ?? []) {
        const hostname = endpoint.customDomain!;
        let domain = (await repos.domain.listByProject(child.id)).find(
          (domain) => domain.hostname === hostname,
        );
        if (!domain) domain = (await addDomain(ctx, { projectId: child.id, hostname })).domain;
        await repos.domain.update(domain.id, {
          serviceId: service.id,
          targetPort: endpoint.port,
        });
      }
    for (const domain of await repos.domain.listByProject(child.id))
      if (!domain.verified) {
        const verified = await verifyDomain(ctx, domain.id);
        if (!verified.verified)
          throw new Error(
            `Preview domain is not ready. Point *.${baseDomain} at the deployment server and retry.`,
          );
      }
  }
}

async function reconcile(row: PullRequestPreview, token: string) {
  const actor = await resolveOrgOwner(row.organizationId);
  if (!actor) throw new Error("Preview automation requires an active organization owner.");
  const ctx = buildBackgroundContext({
    userId: actor.userId,
    organizationId: row.organizationId,
    label: "github:pr-preview",
  });
  const source = await repos.project.findByIdInOrganization(
    row.sourceProjectId,
    row.organizationId,
  );
  const root = `https://api.github.com/repos/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}`;
  const request = <T>(
    url: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    params?: Record<string, unknown>,
  ) =>
    githubFetch<T>({
      ctx,
      owner: row.owner,
      repo: row.repo,
      url,
      method,
      params,
      authorizeAs: "read",
    });
  const assertLease = async () => {
    if (!nativeJobsEnabled() || !(await repos.pullRequestPreview.renew(row.id, token)))
      throw new Error("Preview reconciliation lease ended");
  };
  await assertLease();
  const sameRepository =
    source?.gitOwner?.toLowerCase() === row.owner.toLowerCase() &&
    source?.gitRepo?.toLowerCase() === row.repo.toLowerCase();
  const pr =
    source?.previewSettings?.enabled &&
    sameRepository &&
    !source.deletedAt &&
    !source.deletionInProgress
      ? await request<PullRequest>(`${root}/pulls/${row.number}`)
      : null;
  let child = row.projectId
    ? await repos.project.findByIdInOrganization(row.projectId, row.organizationId)
    : undefined;
  if (!source || !pr || !previewEligible(pr, source)) {
    if (child) {
      await assertLease();
      const deleted = await teardownProject(ctx, child.id, {
        force: true,
        wipeVolumes: true,
        preserveWebhook: true,
      });
      if (!deleted.ok)
        throw new Error(
          "Preview cleanup is incomplete and will retry. Inspect the preview environment for details.",
        );
    }
    await repos.pullRequestPreview.update(row.id, token, {
      status: "closed",
      url: null,
      error: null,
      nextAttemptAt: null,
    });
    if (child || row.commentId) await publishComment("Preview environment removed.", null);
    return;
  }
  if (!child) {
    const services = await repos.service.listByProject(source.id);
    const input = previewEnvironmentInput(source, services, row.number, pr.head.ref);
    child = await withProjectCreationLock(source.organizationId, async () => {
      await assertProjectQuota(source.organizationId, source.workspaceId, source.serverId);
      return repos.pullRequestPreview.createEnvironment(row.id, token, input);
    });
    row = { ...row, projectId: child.id, headSha: null, deploymentId: null };
  }
  const admitted = await repos.pullRequestPreview.admittedDeployment(row.id, token, pr.head.sha);
  if (
    row.headSha !== pr.head.sha ||
    !row.deploymentId ||
    !admitted ||
    admitted.status === "queued"
  ) {
    await assertLease();
    await repos.project.update(child.id, { gitBranch: pr.head.ref });
    const vars = await repos.project.listEnvVars(source.id, "preview");
    await repos.project.bulkSetEnvVars(
      child.id,
      "production",
      vars.filter((v) => !v.serviceId),
    );
    const sourceServices = await repos.service.listByProject(source.id);
    for (const service of await repos.service.listByProject(child.id)) {
      const original = sourceServices.find((item) => item.name === service.name);
      await repos.project.bulkSetEnvVars(
        child.id,
        "production",
        vars.filter((v) => v.serviceId === original?.id),
        service.id,
      );
    }
    const result = await triggerDeployment(ctx, {
      projectId: child.id,
      branch: pr.head.ref,
      commitSha: pr.head.sha,
      trigger: "webhook",
      forceAll: true,
      previewAdmission: { id: row.id, token },
    });
    if (!result.deployment) throw new Error("Preview deployment is awaiting admission.");
    row = (await repos.pullRequestPreview.update(row.id, token, {
      headSha: pr.head.sha,
      deploymentId: result.deployment.id,
      status: "deploying",
      error: null,
    }))!;
  }
  const dep = row.deploymentId ? await repos.deployment.findById(row.deploymentId) : null;
  if (dep?.status === "ready" && source.previewSettings?.protectionHostname)
    await syncPreviewRouteProtection(ctx, child.id);
  const primary = await repos.domain.getPrimaryByProject(child.id);
  const meta = dep?.meta as { edgeUnsynced?: boolean; deployWarning?: string } | null;
  const status =
    dep?.status === "ready"
      ? meta?.edgeUnsynced
        ? "routing"
        : "ready"
      : ["failed", "cancelled", "partial_failure", "rejected"].includes(dep?.status ?? "")
        ? "failed"
        : "deploying";
  const url = status === "ready" && primary ? `https://${primary.hostname}` : null;
  await repos.pullRequestPreview.update(row.id, token, {
    status,
    url,
    error:
      status === "routing" ? (meta?.deployWarning ?? "Preview routing needs attention.") : null,
    nextAttemptAt: new Date(
      Date.now() + (status === "ready" || status === "failed" ? 300_000 : 30_000),
    ),
  });
  await publishComment(
    status === "ready"
      ? "Preview is ready."
      : status === "routing"
        ? "Preview built successfully, but routing needs attention. Open deployment details before using its URL."
        : status === "failed"
          ? "Preview deployment failed. Open deployment details to inspect the failure."
          : "Preview is deploying.",
    url,
  );

  async function publishComment(message: string, url: string | null) {
    if (source?.previewSettings?.comments === false || (!source && !row.commentId)) return;
    const marker = `<!-- openship-preview:${row.id} -->`;
    const details = row.deploymentId
      ? `${runtimeTarget.dashboard.replace(/\/$/, "")}/build/${encodeURIComponent(row.deploymentId)}`
      : null;
    const body = `${marker}\n**Openship preview**\n\n${message}${url ? `\n\n[Open preview](${url})` : ""}${details ? `\n\n[Deployment details](${details})` : ""}`;
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest === row.publishedDigest) return;
    await assertLease();
    let id = row.commentId;
    if (!id) {
      // Recover an accepted POST whose response was lost; never add one comment per commit.
      for (let page = 1; ; page++) {
        const comments = await request<Array<{ id: number; body: string }>>(
          `${root}/issues/${row.number}/comments?per_page=100&page=${page}`,
        );
        const found = comments.find((comment) => comment.body.startsWith(marker));
        if (found) {
          id = String(found.id);
          break;
        }
        if (comments.length < 100) break;
      }
    }
    await assertLease();
    if (id) await request(`${root}/issues/comments/${id}`, "PATCH", { body });
    else
      id = String(
        (await request<{ id: number }>(`${root}/issues/${row.number}/comments`, "POST", { body }))
          .id,
      );
    await repos.pullRequestPreview.update(row.id, token, {
      commentId: id,
      publishedDigest: digest,
    });
  }
}

export async function runPullRequestPreviewsSweep() {
  if (!nativeJobsEnabled()) return;
  // Discover PRs whose opening delivery was missed while this instance was offline.
  for (const source of await repos.pullRequestPreview.claimSources()) {
    try {
      const actor = await resolveOrgOwner(source.organizationId);
      if (!actor || !source.gitOwner || !source.gitRepo) continue;
      const ctx = buildBackgroundContext({
        userId: actor.userId,
        organizationId: source.organizationId,
        label: "github:preview-discovery",
      });
      for (let page = 1; ; page++) {
        const prs = await githubFetch<PullRequest[]>({
          ctx,
          owner: source.gitOwner,
          repo: source.gitRepo,
          url: `https://api.github.com/repos/${encodeURIComponent(source.gitOwner)}/${encodeURIComponent(source.gitRepo)}/pulls`,
          params: { state: "open", base: source.gitBranch, per_page: 100, page },
        });
        for (const pr of prs.filter((pr) => previewEligible(pr, source)))
          await repos.pullRequestPreview.enqueue({
            organizationId: source.organizationId,
            sourceProjectId: source.id,
            owner: source.gitOwner,
            repo: source.gitRepo,
            number: pr.number,
          });
        if (prs.length < 100) break;
      }
    } catch (error) {
      diagnostics.warn("projects/pr-previews", "Preview discovery will retry", error, {
        projectId: source.id,
      });
    }
  }
  for (const next of await repos.pullRequestPreview.due()) {
    const token = randomUUID();
    const row = await repos.pullRequestPreview.claim(next.id, token);
    if (!row) continue;
    const heartbeat = setInterval(() => {
      void repos.pullRequestPreview
        .renew(row.id, token)
        .catch((error) =>
          diagnostics.warn("projects/pr-previews", "Preview lease renewal failed", error),
        );
    }, 30_000);
    heartbeat.unref?.();
    try {
      await reconcile(row, token);
    } catch (error) {
      diagnostics.warn("projects/pr-previews", "Preview reconciliation will retry", error, {
        previewId: row.id,
      });
      await repos.pullRequestPreview.update(row.id, token, {
        ...(error instanceof AppError && error.code?.includes("ROUTE_PROTECTION")
          ? { status: "routing" as const, url: null } : {}),
        error: safeErrorMessage(error),
        nextAttemptAt: new Date(Date.now() + 60_000),
      });
    } finally {
      clearInterval(heartbeat);
      await repos.pullRequestPreview.release(row.id, token);
    }
  }
}
