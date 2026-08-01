/**
 * Object storage for an app — an S3-compatible bucket wired into the project's
 * filesystem config.
 *
 * A container's local disk is the wrong home for user uploads the moment there
 * is more than one replica (two web containers, two upload dirs, intermittent
 * 404s) and it's the wrong home for anything that should outlive the box. The
 * platform already speaks S3 in the backup subsystem; this module is the other
 * half — the mapping from "here is a bucket" to "the framework running in this
 * container will actually use it".
 *
 * The mapping is per-framework on purpose. Laravel reads `FILESYSTEM_DISK` +
 * `AWS_*`, django-storages reads `AWS_STORAGE_BUCKET_NAME` + `AWS_S3_*`, and a
 * generic app gets neutral `S3_*` names. Injecting one shape everywhere would
 * mean the values arrive but nothing reads them, which looks like a broken
 * integration rather than an unmapped one.
 *
 * Credentials are NOT part of the stored binding — they go into the project's
 * encrypted env store, the one place secrets live. See `ProjectObjectStorage`.
 */

import { STACKS, type StackDefinition, type StackId } from "./stacks";

export type ObjectStorageProvider =
  | "minio"
  | "aws"
  | "r2"
  | "wasabi"
  | "b2"
  | "spaces"
  | "custom";

export const OBJECT_STORAGE_PROVIDERS: readonly ObjectStorageProvider[] = [
  "minio",
  "aws",
  "r2",
  "wasabi",
  "b2",
  "spaces",
  "custom",
];

/** What the UI needs to ask for one provider, and what it can assume. */
export interface ObjectStorageProviderSpec {
  id: ObjectStorageProvider;
  label: string;
  /** Shown as the endpoint field's placeholder. Empty = endpoint is derived
   *  (AWS) and the field is hidden. */
  endpointPlaceholder: string;
  /** Pre-filled region. `auto` is what R2 expects. */
  defaultRegion: string;
  /** True when the endpoint is not AWS and therefore needs path-style
   *  addressing. `custom` is decided from the endpoint at bind time. */
  forcePathStyle: boolean;
}

export const OBJECT_STORAGE_PROVIDER_SPECS: Readonly<
  Record<ObjectStorageProvider, ObjectStorageProviderSpec>
> = {
  minio: {
    id: "minio",
    label: "MinIO",
    endpointPlaceholder: "https://minio.example.com",
    defaultRegion: "us-east-1",
    forcePathStyle: true,
  },
  aws: {
    id: "aws",
    label: "Amazon S3",
    endpointPlaceholder: "",
    defaultRegion: "us-east-1",
    forcePathStyle: false,
  },
  r2: {
    id: "r2",
    label: "Cloudflare R2",
    endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com",
    defaultRegion: "auto",
    forcePathStyle: true,
  },
  wasabi: {
    id: "wasabi",
    label: "Wasabi",
    endpointPlaceholder: "https://s3.us-east-1.wasabisys.com",
    defaultRegion: "us-east-1",
    forcePathStyle: true,
  },
  b2: {
    id: "b2",
    label: "Backblaze B2",
    endpointPlaceholder: "https://s3.us-west-004.backblazeb2.com",
    defaultRegion: "us-west-004",
    forcePathStyle: true,
  },
  spaces: {
    id: "spaces",
    label: "DigitalOcean Spaces",
    endpointPlaceholder: "https://nyc3.digitaloceanspaces.com",
    defaultRegion: "nyc3",
    forcePathStyle: true,
  },
  custom: {
    id: "custom",
    label: "Other S3-compatible",
    endpointPlaceholder: "https://s3.example.com",
    defaultRegion: "us-east-1",
    forcePathStyle: true,
  },
};

/**
 * Is this an AWS endpoint (so virtual-hosted addressing works) or something
 * else (R2, MinIO, Ceph… which need path-style)? An absent endpoint means the
 * SDK derives AWS's own. Shared with the backup S3 destination so the two can't
 * disagree about the same bucket.
 */
export function isAwsS3Endpoint(endpoint?: string | null): boolean {
  return !endpoint || endpoint.includes(".amazonaws.com");
}

/** A bucket and how to reach it. No credentials — see the module comment. */
export interface ObjectStorageBinding {
  provider: ObjectStorageProvider;
  /** S3 API endpoint; null/empty for AWS (derived from the region). */
  endpoint?: string | null;
  region?: string | null;
  bucket: string;
  /** Resolved at bind time; falls back to the endpoint rule when absent. */
  forcePathStyle?: boolean | null;
  /** Set when the bucket came from an installed MinIO app in the same org, so
   *  the UI can name it and the consumer graph can show the dependency. */
  sourceProjectId?: string | null;
}

/** Access credentials — passed at bind time, stored ONLY as encrypted env. */
export interface ObjectStorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The binding as persisted on `project.objectStorage`. */
export interface ProjectObjectStorage extends ObjectStorageBinding {
  /** Env keys this binding wrote, so unbinding removes exactly those and
   *  nothing a user added by hand. */
  envKeys: string[];
  /** ISO timestamp of the last successful bind. */
  boundAt: string;
}

/**
 * What a given env var carries, independent of the framework's name for it.
 *
 * The bind flow routes by role, not by key: the three values that come FROM a
 * source app (endpoint + credentials) are injected as project connections so the
 * consumer joins that app's network and shows up in its dependents list, while
 * the rest are plain env. Matching on `AWS_ENDPOINT` vs `S3_ENDPOINT` vs
 * `AWS_S3_ENDPOINT_URL` to work that out would break the next time a preset is
 * added.
 */
export type ObjectStorageEnvRole =
  | "disk"
  | "endpoint"
  | "region"
  | "bucket"
  | "accessKeyId"
  | "secretAccessKey"
  | "pathStyle";

export interface ObjectStorageEnvVar {
  key: string;
  value: string;
  role: ObjectStorageEnvRole;
  /** Encrypt at rest and mask in the UI. */
  secret?: boolean;
}

/** Which env-var shape a framework understands. */
export type ObjectStorageEnvPreset = "laravel" | "django" | "generic";

/**
 * The preset for a stack. Keyed off the stack's LANGUAGE where the whole
 * language shares a convention, and off the stack id where it doesn't.
 */
export function objectStorageEnvPreset(framework?: string | null): ObjectStorageEnvPreset {
  if (!framework || !(framework in STACKS)) return "generic";
  if (framework === "laravel") return "laravel";
  if (framework === "django") return "django";
  const stack = STACKS[framework as StackId] as StackDefinition;
  // Symfony reads its filesystem config from a DSN, not from AWS_*; the neutral
  // names are what its flysystem bundle interpolates.
  if (stack.language === "php" && framework === "symfony") return "generic";
  return "generic";
}

function trimmed(value?: string | null): string {
  return (value ?? "").trim();
}

/**
 * Env vars that wire `binding` into an app of `framework`.
 *
 * Every returned key is recorded on the binding, so unbinding can remove
 * precisely this set. Path-style is emitted only when it's true — the frameworks
 * default it to false and an explicit `false` would just be noise.
 */
export function buildObjectStorageEnv(
  binding: ObjectStorageBinding,
  credentials: ObjectStorageCredentials,
  framework?: string | null,
): ObjectStorageEnvVar[] {
  const endpoint = trimmed(binding.endpoint);
  const region = trimmed(binding.region) || "us-east-1";
  const bucket = trimmed(binding.bucket);
  const pathStyle = binding.forcePathStyle ?? !isAwsS3Endpoint(endpoint);
  const preset = objectStorageEnvPreset(framework);

  const out: ObjectStorageEnvVar[] = [];
  const push = (key: string, value: string, role: ObjectStorageEnvRole, secret?: boolean) => {
    if (!value) return;
    out.push(secret ? { key, value, role, secret: true } : { key, value, role });
  };

  if (preset === "laravel") {
    // Laravel's s3 disk is already defined in config/filesystems.php — pointing
    // the default disk at it is what actually moves uploads off local disk.
    push("FILESYSTEM_DISK", "s3", "disk");
    push("AWS_ACCESS_KEY_ID", credentials.accessKeyId, "accessKeyId", true);
    push("AWS_SECRET_ACCESS_KEY", credentials.secretAccessKey, "secretAccessKey", true);
    push("AWS_DEFAULT_REGION", region, "region");
    push("AWS_BUCKET", bucket, "bucket");
    push("AWS_ENDPOINT", endpoint, "endpoint");
    if (pathStyle) push("AWS_USE_PATH_STYLE_ENDPOINT", "true", "pathStyle");
    return out;
  }

  if (preset === "django") {
    // django-storages' S3 backend.
    push("AWS_ACCESS_KEY_ID", credentials.accessKeyId, "accessKeyId", true);
    push("AWS_SECRET_ACCESS_KEY", credentials.secretAccessKey, "secretAccessKey", true);
    push("AWS_STORAGE_BUCKET_NAME", bucket, "bucket");
    push("AWS_S3_REGION_NAME", region, "region");
    push("AWS_S3_ENDPOINT_URL", endpoint, "endpoint");
    if (pathStyle) push("AWS_S3_ADDRESSING_STYLE", "path", "pathStyle");
    return out;
  }

  push("S3_ACCESS_KEY_ID", credentials.accessKeyId, "accessKeyId", true);
  push("S3_SECRET_ACCESS_KEY", credentials.secretAccessKey, "secretAccessKey", true);
  push("S3_BUCKET", bucket, "bucket");
  push("S3_REGION", region, "region");
  push("S3_ENDPOINT", endpoint, "endpoint");
  if (pathStyle) push("S3_FORCE_PATH_STYLE", "true", "pathStyle");
  return out;
}

/** Keys a binding for `framework` would write — what unbind removes when the
 *  stored `envKeys` list is missing (a binding written before it was recorded). */
export function objectStorageEnvKeys(framework?: string | null): string[] {
  return buildObjectStorageEnv(
    { provider: "custom", bucket: "b", endpoint: "https://s3.example.com", region: "r" },
    { accessKeyId: "k", secretAccessKey: "s" },
    framework,
  ).map((v) => v.key);
}
