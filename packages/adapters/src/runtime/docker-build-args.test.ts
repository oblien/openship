import { describe, expect, it } from "vitest";

import { resolveDockerBuildArgs } from "./docker-build-args";

describe("resolveDockerBuildArgs (#689)", () => {
  it("#795 forwards project env to Dockerfile ARG without a duplicate service map", () => {
    expect(
      resolveDockerBuildArgs({
        envVars: {
          DATABASE_URI: "postgres://db/app",
          PAYLOAD_SECRET: "payload-secret",
          SERVER_URL: "https://admin.example.com",
          R4_SECRET_KEY: "r4-secret",
        },
      }),
    ).toEqual({
      DATABASE_URI: "postgres://db/app",
      PAYLOAD_SECRET: "payload-secret",
      SERVER_URL: "https://admin.example.com",
      R4_SECRET_KEY: "r4-secret",
      NODE_ENV: "production",
    });
  });

  it("keeps compatibility defaults while explicit service args win", () => {
    expect(
      resolveDockerBuildArgs({
        envVars: { SHARED: "project", NODE_ENV: "preview", INVALID_KEY_DASH: "ok" },
        buildArgs: { SHARED: "service", NODE_ENV: "test", APP_PACKAGE: "@myorg/api" },
      }),
    ).toEqual({
      SHARED: "service",
      NODE_ENV: "test",
      INVALID_KEY_DASH: "ok",
      APP_PACKAGE: "@myorg/api",
    });
  });

  it("filters invalid legacy env names but rejects invalid explicit service args", () => {
    expect(
      resolveDockerBuildArgs({ envVars: { "LEGACY-BAD": "x", GOOD_KEY: "y" } }),
    ).toEqual({ NODE_ENV: "production", GOOD_KEY: "y" });
    expect(() =>
      resolveDockerBuildArgs({ envVars: {}, buildArgs: { "BAD-KEY": "x" } }),
    ).toThrow(/BAD-KEY/);
  });
});

describe("OPENSHIP_COMMIT_SHA (#1495)", () => {
  const head = "9f2c4e1a7b3d5f6e8a0c2b4d6f8e0a1c3b5d7f9e";

  it("passes the deployment's commit to the build", () => {
    expect(resolveDockerBuildArgs({ envVars: {}, commitSha: head })).toEqual({
      NODE_ENV: "production",
      OPENSHIP_COMMIT_SHA: head,
    });
  });

  it("overrides a stale stored value of the same name", () => {
    const stale = "0000000aaaaaaabbbbbbbcccccccdddddddeeeee";
    expect(
      resolveDockerBuildArgs({
        envVars: { OPENSHIP_COMMIT_SHA: stale },
        buildArgs: { OPENSHIP_COMMIT_SHA: stale, REVISION: stale },
        commitSha: head,
      }),
    ).toMatchObject({ OPENSHIP_COMMIT_SHA: head, REVISION: stale });
  });

  it("is omitted when the source has no commit or the value is not a commit hash", () => {
    expect(resolveDockerBuildArgs({ envVars: {} })).not.toHaveProperty("OPENSHIP_COMMIT_SHA");
    expect(resolveDockerBuildArgs({ envVars: {}, commitSha: "main; rm -rf /" })).not.toHaveProperty(
      "OPENSHIP_COMMIT_SHA",
    );
  });
});
