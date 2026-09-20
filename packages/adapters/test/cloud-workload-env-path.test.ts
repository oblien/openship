import { describe, expect, it } from "vitest";

import { CloudRuntime } from "../src/runtime/cloud";
import { droppedRuntimeEnvMessage } from "../src/runtime/runtime-env";
import { DEFAULT_RESOURCE_CONFIG } from "../src/types";
import type { DeployConfig, LogEntry } from "../src/types";
import type { CloudBuiltArtifact } from "../src/runtime/cloud/compose";

/**
 * Covers the two cloud-side follow-ups to openship#623, both inside
 * `CloudRuntime.deploy` (cloud.ts step 4, "create a workload for the
 * application process"):
 *
 *   [D] the project's env is put through `splitRuntimeEnv`, so a project env var
 *       named PATH never reaches the workload — an oblien workload `env` entry is
 *       an absolute literal that REPLACES the image's PATH, which deletes the
 *       `node_modules/.bin` entry the build added and turns a dependency-binary
 *       start command into a runtime exit 127 under a fully green build log.
 *
 *   [E] the `node_modules/.bin` prelude on the workload `cmd` is GATED off the
 *       repo-Dockerfile arm. `builtArtifacts` is populated only by
 *       buildDockerfileWorkspace, so a truthy entry means the user's own
 *       Dockerfile produced the image and both workDir and startCommand came out
 *       of it — that image owns its PATH and our prelude would shadow its
 *       binaries.
 *
 * SEAM: `CloudRuntime.deploy` reaches the Oblien SDK only through the private
 * `ws()` → `this.client.workspace(id)`, so a fake client with a `workspace()`
 * that returns a recording handle drives the real production code end to end —
 * no SDK, no network, no production change. The [E] gate reads the private
 * `builtArtifacts` map, set here with the house-style cast. `publicEndpoints` is
 * left empty on purpose: that takes deploy's "no public endpoint" branch, so the
 * expose/network calls never fire and the only log lines are the ones under test.
 *
 * What this does NOT prove: nothing about the compose path on this runtime
 * (`CloudComposeSupport.deployService`, covered elsewhere), and nothing about the
 * docker/bare surfaces that share `splitRuntimeEnv`.
 */

interface CreatedWorkload {
  name: string;
  cmd?: string[];
  working_dir?: string;
  env?: string[];
  restart_policy?: string;
  max_restarts?: number;
}

function fakeClientRecording(created: CreatedWorkload[]) {
  const handle = {
    lifecycle: { makePermanent: async () => {} },
    resources: { update: async () => {} },
    // Only reached when config.productionPaths is set. Exit 0 with no output, so
    // the staging/move script "succeeds" and emits no stderr (which execAndStream
    // would surface as an extra warn line).
    runtime: async () => ({
      exec: {
        stream: async function* () {
          yield { event: "exit", exit_code: 0 };
        },
      },
    }),
    workloads: {
      create: async (input: CreatedWorkload) => {
        created.push(input);
        return {};
      },
    },
  };
  return { workspace: () => handle };
}

/** Set the private map that gates [E]. Empty map ⇒ buildpack arm. */
function setBuiltArtifact(
  rt: CloudRuntime,
  workspaceId: string,
  runtime: CloudBuiltArtifact["runtime"],
) {
  (rt as unknown as { builtArtifacts: Map<string, CloudBuiltArtifact> }).builtArtifacts.set(
    workspaceId,
    { workspaceId, runtime },
  );
}

const WORKSPACE_ID = "ws_env_path";

const baseConfig: DeployConfig = {
  deploymentId: "dep_1",
  projectId: "proj_1",
  buildSessionId: "bs_1",
  imageRef: WORKSPACE_ID,
  environment: "production",
  port: 3000,
  envVars: {},
  resources: DEFAULT_RESOURCE_CONFIG,
  packageManager: "npm",
  startCommand: "next start",
  // No publicEndpoints and no volumes: keeps the log stream to just the resize
  // info line plus whatever the code under test emits.
  publicEndpoints: [],
};

async function runDeploy(
  overrides: Partial<DeployConfig> = {},
  artifact?: CloudBuiltArtifact["runtime"],
) {
  const created: CreatedWorkload[] = [];
  const logs: LogEntry[] = [];
  const rt = new CloudRuntime(fakeClientRecording(created) as never);
  if (artifact) setBuiltArtifact(rt, WORKSPACE_ID, artifact);

  const result = await rt.deploy({ ...baseConfig, ...overrides }, (entry) => logs.push(entry));

  expect(result.status).toBe("running");
  expect(created).toHaveLength(1);
  return { workload: created[0], logs, warns: logs.filter((l) => l.level === "warn") };
}

describe("[D] CloudRuntime.deploy — a project PATH never reaches the workload env", () => {
  it("drops PATH, keeps the other vars in order, and appends PORT", async () => {
    const { workload, warns } = await runDeploy({
      envVars: { FIRST: "1", PATH: "/attacker/bin", SECOND: "2" },
    });

    // Exact, not a `not.toContain("PATH=")`: this pins the surviving keys AND
    // their order AND the appended PORT, so deleting the filter at this one call
    // site fails here even though the other three surfaces still filter.
    expect(workload.env).toEqual(["FIRST=1", "SECOND=2", "PORT=3000"]);

    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("PATH");
    expect(warns[0].message).toBe(droppedRuntimeEnvMessage(["PATH"]));
  });

  it("emits no warning when the project sets no PATH", async () => {
    const { workload, warns } = await runDeploy({
      envVars: { FIRST: "1", SECOND: "2" },
    });

    expect(workload.env).toEqual(["FIRST=1", "SECOND=2", "PORT=3000"]);
    expect(warns).toEqual([]);
  });

  it("keeps the whole env when it is only a PATH (workload still gets PORT)", async () => {
    const { workload, warns } = await runDeploy({ envVars: { PATH: "/usr/bin" } });

    expect(workload.env).toEqual(["PORT=3000"]);
    expect(warns).toHaveLength(1);
  });

  it("does not confuse a PATH-prefixed key with PATH itself", async () => {
    const { workload, warns } = await runDeploy({
      envVars: { PATHOLOGY: "keep", PYTHONPATH: "keep", PATH: "/nope" },
    });

    expect(workload.env).toEqual(["PATHOLOGY=keep", "PYTHONPATH=keep", "PORT=3000"]);
    expect(warns).toHaveLength(1);
  });
});

describe("[E] CloudRuntime.deploy — the #623 prelude is gated off the repo-Dockerfile arm", () => {
  it("BUILDPACK arm: the workload cmd carries the node_modules/.bin prelude", async () => {
    const { workload } = await runDeploy({ startCommand: "next start" });

    // workDir is /app (no productionPaths, no built artifact), so both prelude
    // roots collapse to one deduped dir.
    expect(workload.cmd).toEqual([
      "sh",
      "-c",
      `export PATH='/app/node_modules/.bin':"$PATH" && cd '/app' && next start`,
    ]);
    expect(workload.working_dir).toBe("/app");
  });

  it("BUILDPACK arm with productionPaths: both roots are on the prelude, nearest first", async () => {
    // The roots are [workDir, "/app"], not [workDir]: a stack with
    // productionPaths runs from /app/production while node_modules stays at /app.
    const { workload } = await runDeploy({
      productionPaths: [".next", "package.json"],
      startCommand: "next start",
    });

    expect(workload.cmd).toEqual([
      "sh",
      "-c",
      `export PATH='/app/production/node_modules/.bin':'/app/node_modules/.bin':"$PATH" && cd '/app/production' && next start`,
    ]);
    expect(workload.working_dir).toBe("/app/production");
  });

  it("DOCKERFILE arm: the workload cmd carries NO prelude", async () => {
    // The load-bearing new case. A built artifact means the user's own Dockerfile
    // produced this image, and workdir + startCommand both came out of it — so the
    // image owns its PATH and we must not prepend ours.
    const { workload } = await runDeploy(
      // packageManager still says "npm" (the project column defaults to it), so a
      // gate that keyed off the package manager alone would NOT catch this.
      { packageManager: "npm", startCommand: "ignored-by-the-artifact" },
      {
        workdir: "/srv/app",
        env: {},
        exposedPorts: [],
        startCommand: "node dist/server.js",
      },
    );

    expect(workload.cmd).toEqual(["sh", "-c", "cd '/srv/app' && node dist/server.js"]);
    expect(workload.working_dir).toBe("/srv/app");
  });

  it("DOCKERFILE arm: the image's own PATH survives while the project's is dropped", async () => {
    // The exclusion is about the PROJECT's env. A PATH captured from the user's
    // Dockerfile `ENV` is the image's own value — stripping it would be the very
    // regression #623 is about, just from the other direction.
    const { workload, warns } = await runDeploy(
      { envVars: { APP_ENV: "prod", PATH: "/attacker/bin" } },
      {
        workdir: "/srv/app",
        env: { PATH: "/srv/app/node_modules/.bin:/usr/local/bin:/usr/bin" },
        exposedPorts: [],
        startCommand: "node dist/server.js",
      },
    );

    expect(workload.env).toEqual([
      "PATH=/srv/app/node_modules/.bin:/usr/local/bin:/usr/bin",
      "APP_ENV=prod",
      "PORT=3000",
    ]);
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toBe(droppedRuntimeEnvMessage(["PATH"]));
  });

  it("BUILDPACK arm with a non-node package manager: still no prelude", async () => {
    // nodeBinPathExport returns "" for anything outside npm/yarn/pnpm/bun, so the
    // gate is not the only thing keeping the prelude off a Go/Python workload.
    const { workload } = await runDeploy({
      packageManager: "pip",
      startCommand: "python app.py",
    });

    expect(workload.cmd).toEqual(["sh", "-c", "cd '/app' && python app.py"]);
  });

  it("BUILDPACK arm with no package manager at all: still no prelude", async () => {
    const { workload } = await runDeploy({
      packageManager: undefined,
      startCommand: "./server",
    });

    expect(workload.cmd).toEqual(["sh", "-c", "cd '/app' && ./server"]);
  });
});
