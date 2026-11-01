import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { OpenshipClient } from "../packages/sdk/src/client";
import { buildCatalog } from "../packages/core/scripts/gen-catalog";

type RepairClient = Pick<OpenshipClient, "projects" | "services" | "deployments" | "deployment">;

/** Exact static recipe identity; unknown recipe fields are not a retired default. */
export function catalogBuildRecipeHash(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const build = input as Record<string, unknown>;
  if (
    Object.keys(build).some((key) => !["dockerfile", "files"].includes(key)) ||
    typeof build.dockerfile !== "string"
  )
    return null;
  const files = build.files ?? [];
  if (
    !Array.isArray(files) ||
    files.some(
      (file) =>
        !file ||
        typeof file !== "object" ||
        Array.isArray(file) ||
        Object.keys(file).some((key) => !["path", "content"].includes(key)) ||
        typeof file.path !== "string" ||
        typeof file.content !== "string",
    )
  )
    return null;
  const canonical = {
    dockerfile: build.dockerfile,
    files: files
      .map((file) => ({ path: file.path, content: file.content }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function hasRecipeOverrides(service: Awaited<ReturnType<RepairClient["services"]["get"]>>) {
  const advanced = service.advanced as Record<string, unknown> | null;
  return !!(
    service.build ||
    service.dockerfile ||
    service.installCommand ||
    service.buildCommand ||
    service.startCommand ||
    service.buildImage ||
    service.command ||
    service.commandArgv?.length ||
    Object.keys(service.buildArgs ?? {}).length ||
    (Array.isArray(advanced?.files) ? advanced.files.length : advanced?.files)
  );
}

/** Opt-in operator repair. Only catalog-authored retired defaults are eligible;
 * installed recipes are never substituted automatically in the engine. */
export async function repairCatalogImage(
  ship: RepairClient,
  projectId: string,
  serviceId: string,
  apply = false,
) {
  const project = await ship.projects.get(projectId);
  const service = await ship.services.get(projectId, serviceId);
  const template = buildCatalog().apps.find((app) => app.id === project.appTemplateId);
  const spec = template?.services?.find((item) => item.name === service.name);
  if (!spec?.image || service.projectId !== projectId)
    throw new Error("This service does not match an installed catalog app");
  const storedBuild = (service.advanced as Record<string, unknown> | null)?.build as
    | { dockerfile?: string }
    | undefined;
  const buildHash = catalogBuildRecipeHash(storedBuild);
  const finalBase = buildHash
    ? [...storedBuild!.dockerfile!.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].at(
        -1,
      )?.[1]
    : undefined;
  const fromBuild =
    !service.image &&
    !!buildHash &&
    !!spec.replacesBuilds?.includes(buildHash) &&
    finalBase === spec.image;
  const files = (template?.files ?? [])
    .filter((file) => file.service === service.name)
    .map(({ path, content }) => ({ path, content }));
  const plan = {
    projectId,
    serviceId,
    from: service.image ?? "inline catalog build",
    to: spec.image,
    ...(fromBuild
      ? { setupFiles: files.map((file) => file.path), commandArgv: spec.commandArgv ?? null }
      : {}),
  };
  if (service.image === spec.image) return { ...plan, status: "already_current" };
  if (!fromBuild && (!service.image || !spec.replacesImages?.includes(service.image)))
    throw new Error("This is not a retired catalog default; the configured image was preserved");
  if (
    fromBuild &&
    (hasRecipeOverrides(service) || files.some((file) => file.content.includes("{{config:")))
  )
    throw new Error(
      "This recipe has custom settings; review it through the normal service update flow",
    );
  if (!apply)
    return { ...plan, status: "preview", hasActiveDeployment: !!project.activeDeploymentId };
  // Replacement distributions may use a different UID or on-disk format. A
  // running distribution replacement needs a storage/upgrade review. A retired
  // recipe conversion is permitted only with the exact same official base.
  if (project.activeDeploymentId && !fromBuild)
    throw new Error(
      "This project has an active deployment. Review image and volume compatibility before using the normal service update flow",
    );
  const siblings = await ship.services.list(projectId);
  if (!fromBuild && (siblings.length !== 1 || siblings[0]?.id !== serviceId))
    throw new Error(
      "Automatic repair is limited to failed single-service installs. Review a multi-service project through its normal deployment flow",
    );
  const latest = await ship.services.get(projectId, serviceId);
  const currentProject = await ship.projects.get(projectId);
  if (
    latest.image !== service.image ||
    (fromBuild
      ? currentProject.activeDeploymentId !== project.activeDeploymentId ||
        catalogBuildRecipeHash((latest.advanced as Record<string, unknown> | null)?.build) !==
          buildHash ||
        hasRecipeOverrides(latest)
      : !!currentProject.activeDeploymentId)
  )
    throw new Error("The service changed during the preview; no repair was applied");
  const [lastDeployment] = (await ship.deployments.list({ projectId, perPage: 1 })).data;
  if (
    !lastDeployment ||
    lastDeployment.projectId !== projectId ||
    !(fromBuild ? ["ready", "failed", "partial_failure"] : ["failed", "partial_failure"]).includes(
      lastDeployment.status,
    )
  )
    throw new Error(
      fromBuild
        ? "Finish the current deployment before repairing its recipe"
        : "The latest deployment must have failed before an automatic repair can run",
    );
  await ship.services.update(
    projectId,
    serviceId,
    fromBuild
      ? {
          image: spec.image,
          commandArgv: spec.commandArgv ?? null,
          advanced: { build: null, files },
        }
      : { image: spec.image },
  );
  // Distribution repairs remain image-only. A reviewed recipe conversion also
  // replaces its baked startup helper with mounted files. The advanced patch
  // removes only build and sets files; the service API preserves other keys.
  const run = await ship.deployments.create({ projectId, serviceIds: [serviceId], forceAll: true });
  const outcome = await ship.deployment(run.deployment_id).wait({ timeoutMs: 600_000 });
  return { ...plan, ...outcome };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      service: { type: "string" },
      apply: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "OPENSHIP_URL=https://api.openship.io OPENSHIP_TOKEN=... bun scripts/catalog-image-repair.ts --project <id> --service <id> [--apply]\nDefaults to preview. --apply uses the normal service update and deployment flow. Image distribution replacements require a failed single-service install. Exact catalog-authored retired recipes can switch to their declared image and setup files while preserving data and unrelated settings.",
    );
  } else {
    try {
      if (
        !values.project ||
        !values.service ||
        !process.env.OPENSHIP_URL ||
        !process.env.OPENSHIP_TOKEN
      )
        throw new Error("Set OPENSHIP_URL and OPENSHIP_TOKEN, and pass --project and --service");
      const ship = new OpenshipClient({
        baseUrl: process.env.OPENSHIP_URL,
        token: process.env.OPENSHIP_TOKEN,
      });
      const result = await repairCatalogImage(ship, values.project, values.service, values.apply);
      console.log(JSON.stringify(result, null, 2));
      if ("success" in result && !result.success) process.exitCode = 1;
    } catch (error) {
      // Print a message, never the SDK response body or stored environment.
      console.error(error instanceof Error ? error.message : "Catalog repair failed");
      process.exitCode = 1;
    }
  }
}
