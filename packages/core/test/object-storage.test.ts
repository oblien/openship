import { describe, expect, it } from "vitest";

import {
  buildObjectStorageEnv,
  isAwsS3Endpoint,
  objectStorageEnvKeys,
  objectStorageEnvPreset,
  OBJECT_STORAGE_PROVIDER_SPECS,
  type ObjectStorageBinding,
} from "../src/object-storage";

const CREDS = { accessKeyId: "AKIA123", secretAccessKey: "s3cr3t" };

function binding(over: Partial<ObjectStorageBinding> = {}): ObjectStorageBinding {
  return {
    provider: "minio",
    endpoint: "https://minio.example.com",
    region: "us-east-1",
    bucket: "uploads",
    ...over,
  };
}

function asMap(vars: { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(vars.map((v) => [v.key, v.value]));
}

describe("buildObjectStorageEnv — Laravel", () => {
  const vars = buildObjectStorageEnv(binding(), CREDS, "laravel");
  const env = asMap(vars);

  it("points the default disk at s3 — without it the app still writes locally", () => {
    expect(env.FILESYSTEM_DISK).toBe("s3");
  });

  it("uses the AWS_* names Laravel's s3 disk actually reads", () => {
    expect(env).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIA123",
      AWS_SECRET_ACCESS_KEY: "s3cr3t",
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_BUCKET: "uploads",
      AWS_ENDPOINT: "https://minio.example.com",
    });
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it("forces path-style for a non-AWS endpoint (MinIO/R2 reject virtual-hosted)", () => {
    expect(env.AWS_USE_PATH_STYLE_ENDPOINT).toBe("true");
  });

  it("omits path-style and the endpoint on real AWS", () => {
    const aws = asMap(
      buildObjectStorageEnv(binding({ provider: "aws", endpoint: null }), CREDS, "laravel"),
    );
    expect(aws.AWS_USE_PATH_STYLE_ENDPOINT).toBeUndefined();
    expect(aws.AWS_ENDPOINT).toBeUndefined();
    expect(aws.AWS_BUCKET).toBe("uploads");
  });

  it("marks only the credentials secret", () => {
    const secrets = vars.filter((v) => v.secret).map((v) => v.key).sort();
    expect(secrets).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
  });

  it("tags each var with a role, so the bind flow doesn't match on key names", () => {
    const byRole = Object.fromEntries(vars.map((v) => [v.role, v.key]));
    expect(byRole.endpoint).toBe("AWS_ENDPOINT");
    expect(byRole.accessKeyId).toBe("AWS_ACCESS_KEY_ID");
    expect(byRole.secretAccessKey).toBe("AWS_SECRET_ACCESS_KEY");
  });
});

describe("buildObjectStorageEnv — other presets", () => {
  it("django gets django-storages' own names", () => {
    const env = asMap(buildObjectStorageEnv(binding(), CREDS, "django"));
    expect(env).toMatchObject({
      AWS_STORAGE_BUCKET_NAME: "uploads",
      AWS_S3_REGION_NAME: "us-east-1",
      AWS_S3_ENDPOINT_URL: "https://minio.example.com",
      AWS_S3_ADDRESSING_STYLE: "path",
    });
    expect(env.FILESYSTEM_DISK).toBeUndefined();
  });

  it("anything else gets neutral S3_* names", () => {
    for (const framework of ["nextjs", "symfony", "go", undefined]) {
      const env = asMap(buildObjectStorageEnv(binding(), CREDS, framework));
      expect(env.S3_BUCKET).toBe("uploads");
      expect(env.S3_ENDPOINT).toBe("https://minio.example.com");
      expect(env.S3_FORCE_PATH_STYLE).toBe("true");
      expect(env.AWS_BUCKET).toBeUndefined();
    }
  });

  it("falls back to a default region rather than emitting an empty one", () => {
    const env = asMap(buildObjectStorageEnv(binding({ region: null }), CREDS, "laravel"));
    expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
  });
});

describe("objectStorageEnvPreset", () => {
  it("maps the frameworks with their own conventions, generic for the rest", () => {
    expect(objectStorageEnvPreset("laravel")).toBe("laravel");
    expect(objectStorageEnvPreset("django")).toBe("django");
    expect(objectStorageEnvPreset("symfony")).toBe("generic");
    expect(objectStorageEnvPreset("nextjs")).toBe("generic");
    expect(objectStorageEnvPreset("not-a-stack")).toBe("generic");
    expect(objectStorageEnvPreset(null)).toBe("generic");
  });
});

describe("objectStorageEnvKeys", () => {
  it("lists exactly the keys a bind writes, so unbind can remove them", () => {
    expect(objectStorageEnvKeys("laravel")).toEqual(
      buildObjectStorageEnv(
        { provider: "custom", bucket: "b", endpoint: "https://s3.example.com", region: "r" },
        { accessKeyId: "k", secretAccessKey: "s" },
        "laravel",
      ).map((v) => v.key),
    );
  });
});

describe("isAwsS3Endpoint", () => {
  it("treats an absent endpoint as AWS (the SDK derives it from the region)", () => {
    expect(isAwsS3Endpoint(undefined)).toBe(true);
    expect(isAwsS3Endpoint("")).toBe(true);
  });

  it("recognizes AWS hosts and rejects everything else", () => {
    expect(isAwsS3Endpoint("https://s3.us-east-1.amazonaws.com")).toBe(true);
    expect(isAwsS3Endpoint("https://abc.r2.cloudflarestorage.com")).toBe(false);
    expect(isAwsS3Endpoint("http://minio:9000")).toBe(false);
  });
});

describe("OBJECT_STORAGE_PROVIDER_SPECS", () => {
  it("only AWS addresses buckets virtual-hosted; the rest need path-style", () => {
    expect(OBJECT_STORAGE_PROVIDER_SPECS.aws.forcePathStyle).toBe(false);
    for (const id of ["minio", "r2", "wasabi", "b2", "spaces", "custom"] as const) {
      expect(OBJECT_STORAGE_PROVIDER_SPECS[id].forcePathStyle).toBe(true);
    }
  });

  it("only AWS hides the endpoint field", () => {
    expect(OBJECT_STORAGE_PROVIDER_SPECS.aws.endpointPlaceholder).toBe("");
    expect(OBJECT_STORAGE_PROVIDER_SPECS.r2.endpointPlaceholder).not.toBe("");
  });
});
