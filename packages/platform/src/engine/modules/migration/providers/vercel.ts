import { AppError } from "@repo/core";
import { z } from "zod";
import type { PlatformMigrationSource, PlatformProject } from "@repo/contracts";
import { vercelRequest, type ProviderAccess } from "../../credentials/provider-api";
import type { MigrationSourceProvider, ProviderService } from "./types";
import { providerId, parseProvider, githubRepository, MAX_DISCOVERY_PAGES } from "./common";
import { discoverExternalDatabases } from "./external-databases";

const named = z.object({ id: providerId, name: z.string() });
const pagination = z.object({ next: z.number().nullable() });
const deployment = z.object({
  id: z.string().optional(),
  uid: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
  gitSource: z.object({ sha: z.string(), ref: z.string().optional() }).optional(),
});
const project = named.extend({
  link: z
    .object({
      type: z.string(),
      org: z.string().optional(),
      repo: z.union([z.string(), z.number()]).optional(),
      productionBranch: z.string().optional(),
    })
    .nullable()
    .optional(),
  targets: z.object({ production: deployment.nullable().optional() }).nullable().optional(),
  rootDirectory: z.string().nullable().optional(),
  installCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  outputDirectory: z.string().nullable().optional(),
});

async function projects(access: ProviderAccess): Promise<PlatformProject[]> {
  const result: PlatformProject[] = [];
  let until: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const data = parseProvider(
      z.object({ projects: z.array(named), pagination }),
      await vercelRequest(access, "/v9/projects", { limit: "100", ...(until ? { until } : {}) }),
    );
    result.push(
      ...data.projects.map((p) => ({
        ...p,
        environments: [
          { id: "production", name: "Production" },
          { id: "preview", name: "Latest preview" },
        ],
      })),
    );
    if (data.pagination.next == null) return result;
    if (String(data.pagination.next) === until)
      throw new AppError(
        "Vercel pagination did not advance",
        502,
        "MIGRATION_DISCOVERY_INCOMPLETE",
      );
    until = String(data.pagination.next);
  }
  throw new AppError(
    "Narrow the Vercel connection's project scope before importing",
    400,
    "MIGRATION_DISCOVERY_LIMIT",
  );
}

async function discover(access: ProviderAccess, source: PlatformMigrationSource) {
  if (!["production", "preview"].includes(source.environmentId))
    throw new AppError("Select Production or Latest preview", 400, "MIGRATION_ENVIRONMENT_INVALID");
  const path = encodeURIComponent(source.projectId);
  const p = parseProvider(project, await vercelRequest(access, `/v9/projects/${path}`));
  let selected = p.targets?.production ?? undefined;
  if (source.environmentId === "preview") {
    const data = parseProvider(
      z.object({ deployments: z.array(deployment) }),
      await vercelRequest(access, "/v6/deployments", {
        projectId: p.id,
        target: "preview",
        state: "READY",
        limit: "1",
      }),
    );
    selected = data.deployments[0];
  }
  const repo = githubRepository(
    p.link?.type === "github" && p.link.org && typeof p.link.repo === "string"
      ? `${p.link.org}/${p.link.repo}`
      : selected?.meta?.githubOrg && selected?.meta?.githubRepo
        ? `${selected.meta.githubOrg}/${selected.meta.githubRepo}`
        : undefined,
  );
  const commit = selected?.gitSource?.sha ?? selected?.meta?.githubCommitSha;
  const branch =
    selected?.gitSource?.ref ?? selected?.meta?.githubCommitRef ?? p.link?.productionBranch;
  const variable = z.object({
    id: z.string().optional(),
    key: z.string(),
    type: z.string(),
    value: z.string().optional(),
    target: z.union([z.array(z.string()), z.string()]).optional(),
    gitBranch: z.string().nullable().optional(),
  });
  const listed = parseProvider(
    z.object({ envs: z.array(variable) }),
    await vercelRequest(
      access,
      `/v10/projects/${path}/env`,
      source.environmentId === "preview" && branch ? { gitBranch: branch } : {},
    ),
  );
  const selectedVars = listed.envs
    .filter(
      (v) =>
        (Array.isArray(v.target) ? v.target : [v.target]).includes(source.environmentId) &&
        (!v.gitBranch || (source.environmentId === "preview" && v.gitBranch === branch)),
    )
    .sort((a, b) => Number(!!a.gitBranch) - Number(!!b.gitBranch));
  const byKey = new Map(selectedVars.map((v) => [v.key, v]));
  const env: Record<string, string> = {};
  for (const v of byKey.values()) {
    // Secret/Sensitive values are explicitly non-exportable. Never copy their
    // opaque ciphertext or a legacy secret reference into the runtime.
    if (["secret", "sensitive"].includes(v.type.toLowerCase())) continue;
    if (["config", "plain"].includes(v.type.toLowerCase()) && typeof v.value === "string")
      env[v.key] = v.value;
    else if (v.id && v.type === "encrypted") {
      const value = parseProvider(
        z.object({ value: z.string() }),
        await vercelRequest(access, `/v1/projects/${path}/env/${encodeURIComponent(v.id)}`),
      );
      env[v.key] = value.value;
    }
  }
  const domains: Array<{ hostname: string; portable: boolean }> = [];
  let until: string | undefined;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const data = parseProvider(
      z.object({
        domains: z.array(
          z.object({
            name: z.string(),
            gitBranch: z.string().nullable().optional(),
            customEnvironmentId: z.string().nullable().optional(),
          }),
        ),
        pagination,
      }),
      await vercelRequest(access, `/v9/projects/${path}/domains`, {
        limit: "100",
        ...(until ? { until } : {}),
      }),
    );
    domains.push(
      ...data.domains
        .filter(
          (d) =>
            !d.customEnvironmentId &&
            (source.environmentId === "production" ? !d.gitBranch : d.gitBranch === branch),
        )
        .map((d) => ({ hostname: d.name, portable: !d.name.endsWith(".vercel.app") })),
    );
    if (data.pagination.next == null) break;
    if (String(data.pagination.next) === until || page === MAX_DISCOVERY_PAGES - 1)
      throw new AppError(
        "Vercel domain discovery is incomplete",
        502,
        "MIGRATION_DISCOVERY_INCOMPLETE",
      );
    until = String(data.pagination.next);
  }
  const app: ProviderService = {
    id: p.id,
    name: p.name,
    kind: "app",
    repository: repo,
    commit,
    branch,
    rootDirectory: p.rootDirectory || ".",
    installCommand: p.installCommand ?? undefined,
    buildCommand: p.buildCommand ?? undefined,
    outputDirectory: p.outputDirectory ?? undefined,
    env,
    rawEnv: { ...env },
    variables: [...byKey.keys()].map((key) => ({ key, required: !(key in env) })),
    volumes: [],
    domains,
    warnings: [
      "Vercel functions, Edge Config, Blob and provider-specific APIs need compatibility review. External services remain connected unless you choose to copy them.",
    ],
    blockers: [
      ...(!repo ? ["Connect this application's GitHub repository before importing."] : []),
      ...(!commit || !/^[a-f0-9]{40}$/i.test(commit)
        ? ["No deployed Git revision was found for this environment."]
        : []),
    ],
  };
  const services: ProviderService[] = [app];
  // Connections sharing a database become one imported dependency. Other
  // providers' databases remain external; a Vercel token is not their export API.
  discoverExternalDatabases(app, services);
  return {
    provider: "vercel" as const,
    source,
    projectName: p.name,
    environmentName:
      source.environmentId === "production" ? "Production" : `Preview · ${branch ?? "latest"}`,
    services,
    warnings: [
      "Repository access is checked through your existing Openship GitHub connection. Custom domains move only after you verify the new deployment.",
    ],
  };
}
export const vercelMigrationProvider: MigrationSourceProvider = { projects, discover };
