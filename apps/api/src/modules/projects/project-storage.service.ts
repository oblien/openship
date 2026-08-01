/**
 * Object storage for a project — bind an S3-compatible bucket to the app so its
 * framework writes uploads there instead of to the container's own disk.
 *
 * Two sources, one result. Either an installed MinIO app in the same org, or an
 * external provider (AWS, R2, Wasabi, B2, Spaces, anything S3). Both end as the
 * SAME set of framework-appropriate env vars (`@repo/core` object-storage.ts owns
 * that mapping) plus a non-secret marker on the project so the UI can show what's
 * bound and take it away again.
 *
 * Credentials are never stored here. They land in the project's encrypted env
 * store, which is the one place this codebase keeps secrets — so there's no
 * second credential table to leak, rotate, or forget to delete.
 *
 * The MinIO path deliberately goes through the existing project-connection
 * machinery rather than writing env directly: that's what joins the consumer to
 * the source app's docker network (`attachLinkedNetworks`) and what makes the
 * dependency visible from the MinIO app's own page, so deleting it can't quietly
 * break an app that was reading from it.
 */

import { repos } from "@repo/db";
import {
  ValidationError,
  buildObjectStorageEnv,
  isAwsS3Endpoint,
  objectStorageEnvPreset,
  OBJECT_STORAGE_PROVIDER_SPECS,
  resolveProjectVolumes,
  safeErrorMessage,
  type ObjectStorageBinding,
  type ObjectStorageCredentials,
  type ObjectStorageEnvVar,
  type ObjectStorageProvider,
  type ProjectObjectStorage,
} from "@repo/core";
import type { BackupDestinationRow } from "@repo/adapters";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { env } from "../../config";
import { assertPublicUrl } from "../../lib/ssrf-guard";
import { encryptSecretField } from "../../lib/credential-encryption";
import { runConnectivityCheck } from "../../lib/connectivity";
import "../../lib/connectivity-checks"; // registers the S3 probe used below
import { getAppConnectionView } from "../apps/app-settings.service";
import { mergeEnvVars } from "./project-env.service";
import { createConnection, deleteConnection } from "./project-connection.service";

const ENVIRONMENT = "production";

/** Output ids a storage source must expose. Matches the MinIO catalog entry's
 *  `provides: { id: "s3" }` bundle. */
const SOURCE_OUTPUT_IDS = {
  endpoint: "endpoint",
  accessKeyId: "accessKey",
  secretAccessKey: "secretKey",
} as const;

/** Output id carrying the source app's own default bucket, used to prefill the
 *  bind form (the app's prepare step creates it on first deploy). */
const SOURCE_BUCKET_OUTPUT = "bucket";

/** Roles whose value comes from the SOURCE APP and is therefore injected as a
 *  connection (network attach + dependency graph) rather than as plain env. */
const CONNECTION_ROLES = new Set(["endpoint", "accessKeyId", "secretAccessKey"]);

export interface ObjectStorageView {
  binding: ProjectObjectStorage | null;
  /** Local persistent mounts, alongside the bucket: the same tab shows both, and
   *  reading them here means the editor can refresh from ONE authoritative
   *  answer after a save instead of guessing what the stack default resolved to. */
  volumes: string[] | null;
  resolvedVolumes: string[];
  /** Which env-var shape this project's framework gets. */
  envPreset: string;
  /** The keys a bind would write, so the UI can say so before committing. */
  envKeys: string[];
  /** Installed apps in this org that can provide a bucket. */
  candidates: Array<{
    projectId: string;
    name: string;
    appTemplateId: string | null;
    /** The app's own first bucket, to prefill the form. Empty until it deploys. */
    defaultBucket: string;
  }>;
  providers: typeof OBJECT_STORAGE_PROVIDER_SPECS;
}

export type BindObjectStorageInput = {
  bucket: string;
  /** An installed MinIO app in the same org. Mutually exclusive with the
   *  explicit provider fields below. */
  sourceProjectId?: string;
  /** Reachability for a source app: internal (shared docker network) or public. */
  mode?: "internal" | "public";
  provider?: ObjectStorageProvider;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

/** Apps that can hand a bucket to another project. Kept to MinIO for now — the
 *  one S3 server in the catalog — but keyed off the template id, not the name,
 *  so a future MinIO-alike joins by adding its id here. */
const STORAGE_TEMPLATE_IDS = new Set(["minio"]);

export async function getObjectStorage(
  ctx: RequestContext,
  projectId: string,
): Promise<ObjectStorageView> {
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "read" });
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);

  const listed = await repos.project
    .listByOrganization(ctx.organizationId, { perPage: 200 })
    .catch(() => null);
  const sources = (listed?.rows ?? []).filter(
    (p) => p.id !== projectId && !!p.appTemplateId && STORAGE_TEMPLATE_IDS.has(p.appTemplateId),
  );
  const candidates = await Promise.all(
    sources.map(async (p) => ({
      projectId: p.id,
      name: p.name,
      appTemplateId: p.appTemplateId,
      // Best-effort: an app that hasn't deployed yet has published nothing, and
      // that's a prefill, not a requirement.
      defaultBucket: await getAppConnectionView(ctx, p.id)
        .then((v) => v.outputs.find((o) => o.id === SOURCE_BUCKET_OUTPUT)?.value ?? "")
        .catch(() => ""),
    })),
  );

  // Sample keys with a throwaway binding: the caller only needs the NAMES, and
  // building them from the real mapping keeps this from drifting out of sync.
  const envKeys = buildObjectStorageEnv(
    { provider: "custom", bucket: "bucket", endpoint: "https://s3.example.com", region: "auto" },
    { accessKeyId: "k", secretAccessKey: "s" },
    project.framework,
  ).map((v) => v.key);

  return {
    binding: (project.objectStorage as ProjectObjectStorage | null) ?? null,
    volumes: (project.volumes as string[] | null) ?? null,
    resolvedVolumes: resolveProjectVolumes(project.volumes as string[] | null, project.framework),
    envPreset: objectStorageEnvPreset(project.framework),
    envKeys,
    candidates,
    providers: OBJECT_STORAGE_PROVIDER_SPECS,
  };
}

/**
 * Verify the bucket really works before writing anything to the project.
 *
 * Reuses the backup subsystem's S3 probe, which writes, heads and deletes a
 * throwaway object — so a bind can't succeed against read-only credentials or a
 * bucket that doesn't exist, which would otherwise surface as a 500 the first
 * time a user uploaded a file.
 */
async function probeBucket(
  ctx: RequestContext,
  binding: ObjectStorageBinding,
  credentials: ObjectStorageCredentials,
): Promise<void> {
  // SaaS SSRF guard: an authed member must not aim the probe at the control
  // plane's own network. Self-hosted operators legitimately point at their LAN.
  if (env.CLOUD_MODE && binding.endpoint) {
    await assertPublicUrl(binding.endpoint, { allowHttp: true });
  }

  const row = {
    id: "obj_storage_probe",
    organizationId: ctx.organizationId,
    name: "object-storage",
    kind: "s3_compatible",
    endpoint: binding.endpoint ?? null,
    region: binding.region ?? null,
    bucket: binding.bucket,
    pathPrefix: null,
    sshHost: null,
    sshPort: null,
    sshUser: null,
    serverId: null,
    accessKeyIdEnc: encryptSecretField(credentials.accessKeyId),
    secretAccessKeyEnc: encryptSecretField(credentials.secretAccessKey),
    sftpPasswordEnc: null,
    sftpPrivateKeyEnc: null,
    sftpKeyPassphraseEnc: null,
  } as unknown as BackupDestinationRow;

  const result = await runConnectivityCheck("backup-destination", row);
  if (!result.ok) {
    throw new ValidationError(`Could not use that bucket: ${result.message}`);
  }
}

/** Pull endpoint + credentials out of a source app's connection outputs. */
async function readSourceCredentials(
  ctx: RequestContext,
  sourceProjectId: string,
): Promise<{ endpoint: string; credentials: ObjectStorageCredentials }> {
  const view = await getAppConnectionView(ctx, sourceProjectId);
  const value = (id: string): string => {
    const output = view.outputs.find((o) => o.id === id);
    return (output?.value ?? "").trim();
  };
  const endpoint = value(SOURCE_OUTPUT_IDS.endpoint);
  const accessKeyId = value(SOURCE_OUTPUT_IDS.accessKeyId);
  const secretAccessKey = value(SOURCE_OUTPUT_IDS.secretAccessKey);
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new ValidationError(
      "That app hasn't published its S3 endpoint and keys yet — deploy it first, then connect.",
    );
  }
  return { endpoint, credentials: { accessKeyId, secretAccessKey } };
}

/**
 * Bind a bucket to the project: probe it, write the env, record the marker.
 *
 * Any previous binding is removed first — one bucket per project, so a rebind
 * can't leave half of the old provider's keys behind (an app reading a stale
 * AWS_ENDPOINT with fresh keys fails in a way that looks like a credentials bug).
 */
export async function bindObjectStorage(
  ctx: RequestContext,
  projectId: string,
  input: BindObjectStorageInput,
): Promise<{ binding: ProjectObjectStorage; requiresRedeploy: true }> {
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "write" });
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);

  const bucket = input.bucket?.trim();
  if (!bucket) throw new ValidationError("Enter the bucket name.");

  let binding: ObjectStorageBinding;
  let credentials: ObjectStorageCredentials;

  if (input.sourceProjectId) {
    const source = await repos.project.findById(input.sourceProjectId);
    assertResourceInOrg(source, "Project", ctx.organizationId, input.sourceProjectId);
    const resolved = await readSourceCredentials(ctx, input.sourceProjectId);
    credentials = resolved.credentials;
    binding = {
      provider: "minio",
      endpoint: resolved.endpoint,
      region: OBJECT_STORAGE_PROVIDER_SPECS.minio.defaultRegion,
      bucket,
      forcePathStyle: true,
      sourceProjectId: input.sourceProjectId,
    };
  } else {
    const provider = input.provider;
    if (!provider || !(provider in OBJECT_STORAGE_PROVIDER_SPECS)) {
      throw new ValidationError("Pick a storage provider.");
    }
    if (!input.accessKeyId?.trim() || !input.secretAccessKey?.trim()) {
      throw new ValidationError("Enter the access key and secret.");
    }
    const spec = OBJECT_STORAGE_PROVIDER_SPECS[provider];
    const endpoint = input.endpoint?.trim() || "";
    if (provider !== "aws" && !endpoint) {
      throw new ValidationError(`${spec.label} needs its S3 endpoint URL.`);
    }
    credentials = {
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey: input.secretAccessKey.trim(),
    };
    binding = {
      provider,
      endpoint: endpoint || null,
      region: input.region?.trim() || spec.defaultRegion,
      bucket,
      // Derived, not taken from the client: an AWS endpoint must not be forced to
      // path-style (deprecated there) and everything else requires it.
      forcePathStyle: !isAwsS3Endpoint(endpoint),
    };
  }

  await probeBucket(ctx, binding, credentials);

  const vars = buildObjectStorageEnv(binding, credentials, project.framework);
  // Clear the previous binding BEFORE writing, so a provider swap can't leave a
  // key from the old shape behind (e.g. AWS_ENDPOINT after moving to real AWS).
  await clearBinding(ctx, projectId, { defer: true });
  await writeBinding(ctx, projectId, project.organizationId, binding, vars, input.mode);

  const stored: ProjectObjectStorage = {
    ...binding,
    envKeys: vars.map((v) => v.key),
    boundAt: new Date().toISOString(),
  };
  await repos.project.update(projectId, { objectStorage: stored });

  await applyToTarget(ctx, projectId);
  return { binding: stored, requiresRedeploy: true };
}

/** Write the resolved env: source-app values as connections, the rest as env. */
async function writeBinding(
  ctx: RequestContext,
  projectId: string,
  organizationId: string,
  binding: ObjectStorageBinding,
  vars: ObjectStorageEnvVar[],
  mode: "internal" | "public" | undefined,
): Promise<void> {
  const plain = binding.sourceProjectId
    ? vars.filter((v) => !CONNECTION_ROLES.has(v.role))
    : vars;

  if (plain.length > 0) {
    await mergeEnvVars(projectId, organizationId, {
      environment: ENVIRONMENT,
      upserts: plain.map((v) => ({ key: v.key, value: v.value, isSecret: !!v.secret })),
      deletes: [],
    });
  }

  if (!binding.sourceProjectId) return;

  const sourceProjectId = binding.sourceProjectId;
  const connectionVars = vars.filter((v) => CONNECTION_ROLES.has(v.role));
  const link = async (chosen: "internal" | "public") => {
    for (const v of connectionVars) {
      const outputId = SOURCE_OUTPUT_IDS[v.role as keyof typeof SOURCE_OUTPUT_IDS];
      await createConnection(
        ctx,
        projectId,
        { sourceProjectId, outputId, envKey: v.key, mode: chosen },
        // One redeploy at the end of the bind, not one per injected key.
        { defer: true },
      );
    }
  };

  if (mode) {
    await link(mode);
    return;
  }

  // Nothing chosen → prefer internal: upload traffic between two containers on
  // the same box has no reason to leave through the edge. Internal isn't always
  // available (a cloud-hosted source has no attachable shared network) and the
  // connection layer is the authority on that, so try it and fall back instead of
  // re-deriving the rule here. Its internal check runs before it writes anything,
  // so a rejected attempt leaves nothing behind — and only THAT rejection is
  // retried; any other failure is the caller's to see.
  try {
    await link("internal");
  } catch (err) {
    if (!/internal mode isn't available/i.test(safeErrorMessage(err))) throw err;
    await link("public");
  }
}

/**
 * Remove whatever this project had bound: the connection rows first (they own
 * their env key), then any plain keys the binding wrote, then the marker.
 *
 * Driven by the marker's recorded `envKeys` so it can never delete a variable a
 * user set by hand — even if the framework's preset has changed since the bind.
 */
async function clearBinding(
  ctx: RequestContext,
  projectId: string,
  opts?: { defer?: boolean },
): Promise<boolean> {
  const project = await repos.project.findById(projectId);
  const existing = (project?.objectStorage as ProjectObjectStorage | null) ?? null;
  if (!existing) return false;

  const keys = new Set(existing.envKeys ?? []);
  const links = await repos.projectConnection.listByTarget(projectId).catch(() => []);
  for (const link of links) {
    if (!keys.has(link.envKey)) continue;
    if (existing.sourceProjectId && link.sourceProjectId !== existing.sourceProjectId) continue;
    await deleteConnection(ctx, projectId, link.id, { defer: true }).catch((err) => {
      console.warn(`[object-storage] unlink ${link.envKey} failed: ${safeErrorMessage(err)}`);
    });
    keys.delete(link.envKey);
  }

  if (keys.size > 0 && project) {
    await mergeEnvVars(projectId, project.organizationId, {
      environment: ENVIRONMENT,
      upserts: [],
      deletes: [...keys],
    });
  }

  await repos.project.update(projectId, { objectStorage: null });
  if (!opts?.defer) await applyToTarget(ctx, projectId);
  return true;
}

export async function unbindObjectStorage(
  ctx: RequestContext,
  projectId: string,
): Promise<{ removed: boolean }> {
  await permission.assert(ctx, { resourceType: "project", resourceId: projectId, action: "write" });
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const removed = await clearBinding(ctx, projectId);
  return { removed };
}

/**
 * Best-effort redeploy so the env actually reaches the RUNNING container (env is
 * baked at deploy time). Non-fatal — mirrors the service-connection apply: if the
 * project was never deployed there's nothing to refresh and it lands on the first
 * deploy anyway.
 */
async function applyToTarget(ctx: RequestContext, projectId: string): Promise<void> {
  const project = await repos.project.findById(projectId).catch(() => null);
  if (!project?.activeDeploymentId) return;
  try {
    const { triggerDeployment } = await import("../deployments/build.service");
    await triggerDeployment(ctx, { projectId, trigger: "service-connection" });
  } catch (err) {
    console.warn(
      `[object-storage] apply-redeploy of ${projectId} failed (non-fatal): ${safeErrorMessage(err)}`,
    );
  }
}
