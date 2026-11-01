import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { BareRuntime, LocalExecutor, resolveStaticOutputPath } from "@repo/adapters";

import {
  needsRunningApplication,
  resolveBuildRuntimeModes,
  resolveDeployRouting,
  reusedReleaseRouting,
} from "@repo/platform/engine/modules/deployments/build-execution-plan";

/**
 * Locks the behavior-equivalence tables the pipeline restructure relied on. Each
 * case is one of the deploy "paths"; the expected values are what the pre-restructure
 * inline flips + `instanceof` checks produced. The `web`/`static` cases stand in for
 * the old `hasServer` boolean; `worker` is the new portless-container path (#538-B).
 */

describe("resolveBuildRuntimeModes (pre-resolve flip, as data)", () => {
  it("services → Docker for both build and serve (any target)", () => {
    expect(
      resolveBuildRuntimeModes({
        workload: "web",
        serverId: "srv_1",
        baseTarget: "selfhosted",
        effectiveTarget: "server",
        willRunServices: true,
      }),
    ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "docker" });

    // services win even for a static/cloud-ish shape
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: null,
        baseTarget: "cloud",
        effectiveTarget: "cloud",
        willRunServices: true,
      }),
    ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "docker" });
  });

  it("worker → Docker for both build and serve (portless supervised container)", () => {
    expect(
      resolveBuildRuntimeModes({
        workload: "worker",
        serverId: "srv_1",
        baseTarget: "selfhosted",
        effectiveTarget: "server",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "docker" });

    // a worker never takes the static bare-serve path even on a self-hosted host
    expect(
      resolveBuildRuntimeModes({
        workload: "worker",
        serverId: null,
        baseTarget: "selfhosted",
        effectiveTarget: "local",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "docker" });
  });

  it("static on a remote server → build in Docker sandbox, serve identity bare", () => {
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: "srv_1",
        baseTarget: "desktop",
        effectiveTarget: "server",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "bare" });
  });

  it("static on a self-hosted host (no serverId) → sandbox build, bare serve", () => {
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: null,
        baseTarget: "selfhosted",
        effectiveTarget: "local",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "bare" });
  });

  it("static cloud target → uses its selected runtime mode", () => {
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: null,
        baseTarget: "cloud",
        effectiveTarget: "cloud",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: undefined, serveRuntimeMode: undefined });

    // local-orchestrated cloud (self-hosted base, effective cloud) also no flip
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: null,
        baseTarget: "selfhosted",
        effectiveTarget: "cloud",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: undefined, serveRuntimeMode: undefined });
  });

  it("static on Docker-less desktop 'This Machine' → no flip (build with its own mode)", () => {
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: null,
        baseTarget: "desktop",
        effectiveTarget: "local",
        willRunServices: false,
      }),
    ).toEqual({ buildRuntimeMode: undefined, serveRuntimeMode: undefined });
  });

  it("server app → no flip (use configured runtime)", () => {
    for (const baseTarget of ["desktop", "selfhosted"] as const) {
      expect(
        resolveBuildRuntimeModes({
          workload: "web",
          serverId: "srv_1",
          baseTarget,
          effectiveTarget: "server",
          willRunServices: false,
        }),
      ).toEqual({ buildRuntimeMode: undefined, serveRuntimeMode: undefined });
    }
  });

  it("prebuilt single-app images use Docker on every server transport", () => {
    for (const [baseTarget, effectiveTarget] of [
      ["desktop", "local"],
      ["desktop", "server"],
      ["selfhosted", "local"],
      ["selfhosted", "server"],
    ] as const) {
      expect(
        resolveBuildRuntimeModes({
          workload: "web",
          serverId: effectiveTarget === "server" ? "srv_1" : null,
          baseTarget,
          effectiveTarget,
          willRunServices: false,
          hasPrebuiltImage: true,
        }),
      ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "docker" });
    }

    for (const baseTarget of ["cloud", "selfhosted"] as const) {
      expect(
        resolveBuildRuntimeModes({
          workload: "web",
          serverId: null,
          baseTarget,
          effectiveTarget: "cloud",
          willRunServices: false,
          hasPrebuiltImage: true,
        }),
      ).toEqual({ buildRuntimeMode: "docker", serveRuntimeMode: "docker" });
    }
  });
});

describe("resolveDeployRouting (post-resolve, keyed off runtime.name)", () => {
  it("server app → normal build, server deploy", () => {
    expect(
      resolveDeployRouting({ workload: "web", runtimeName: "docker", outputDirectory: "dist" }),
    ).toEqual({ buildMode: "normal", deployMode: "server", staticServeOutputDir: "" });
    expect(
      resolveDeployRouting({ workload: "web", runtimeName: "bare", outputDirectory: "dist" }),
    ).toEqual({ buildMode: "normal", deployMode: "server", staticServeOutputDir: "" });
  });

  it("worker → normal build, worker deploy (no extraction, no route, any runtime)", () => {
    for (const runtimeName of ["docker", "bare"]) {
      expect(
        resolveDeployRouting({ workload: "worker", runtimeName, outputDirectory: "dist" }),
      ).toEqual({ buildMode: "normal", deployMode: "worker", staticServeOutputDir: "" });
    }
  });

  it("static + docker runtime → sandbox build, file-serve, doc-root already extracted", () => {
    expect(
      resolveDeployRouting({ workload: "static", runtimeName: "docker", outputDirectory: "dist" }),
    ).toEqual({
      buildMode: "static-sandbox",
      deployMode: "static-file-serve",
      staticServeOutputDir: "",
    });
  });

  it("static + bare runtime → bare build, file-serve from the output directory", () => {
    expect(
      resolveDeployRouting({ workload: "static", runtimeName: "bare", outputDirectory: "dist" }),
    ).toEqual({
      buildMode: "static-bare",
      deployMode: "static-file-serve",
      staticServeOutputDir: "dist",
    });
  });

  it("publishes a bare monorepo's built site without exposing the repository root", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "openship-static-monorepo-"));
    const release = join(workDir, "releases", "dep_static");
    const runtime = new BareRuntime({ workDir, executor: new LocalExecutor() });
    try {
      await mkdir(join(release, "apps/site/out"), { recursive: true });
      await writeFile(join(release, "private-source.txt"), "source must not be published");
      await writeFile(join(release, "apps/site/out/index.html"), "built site");
      const routing = resolveDeployRouting({
        workload: "static", runtimeName: "bare", managedServer: true,
        rootDirectory: "apps/site", outputDirectory: "out",
      });
      const deployed = await runtime.deployStatic({
        projectId: "proj_static", deploymentId: "dep_static", imageRef: release,
        outputDirectory: routing.staticServeOutputDir,
      } as Parameters<BareRuntime["deployStatic"]>[0]);
      expect(deployed.containerId).toBe(release);
      const docRoot = resolveStaticOutputPath(deployed.containerId!, routing.staticServeOutputDir);
      expect(await readFile(join(docRoot, "index.html"), "utf8")).toBe("built site");
      await expect(readFile(join(docRoot, "private-source.txt"))).rejects.toMatchObject({ code: "ENOENT" });

      // Rollback uses the saved offset even if today's build settings differ.
      const next = resolveDeployRouting({
        workload: "static", runtimeName: "bare", rootDirectory: "other", outputDirectory: "dist",
      });
      expect(reusedReleaseRouting(next, routing.staticServeOutputDir).staticServeOutputDir)
        .toBe("apps/site/out");
    } finally {
      await runtime.dispose();
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["apps/site", "out", "apps/site/out"],
    [" /apps/site/ ", "out", "apps/site/out"],
    ["apps/site", ".", "apps/site"],
    ["apps/site", "", "apps/site"],
    ["apps/site", "build/../out", "apps/site/out"],
    [".", "out", "out"],
  ])("keeps bare output relative to its build root: %s + %s", (rootDirectory, outputDirectory, expected) => {
    expect(resolveDeployRouting({ workload: "static", runtimeName: "bare", rootDirectory, outputDirectory })
      .staticServeOutputDir).toBe(expected);
  });

  it.each([
    ["../outside", "out"],
    ["apps/site", "../private"],
    ["apps/site", "/etc"],
  ])("rejects static output escaping the project: %s + %s", (rootDirectory, outputDirectory) => {
    expect(() => resolveDeployRouting({ workload: "static", runtimeName: "bare", rootDirectory, outputDirectory }))
      .toThrow(/escapes|absolute/);
  });

  it("does not prepend the monorepo path to an extracted Docker artifact", () => {
    expect(resolveDeployRouting({
      workload: "static", runtimeName: "docker", rootDirectory: "apps/site", outputDirectory: "out",
    }).staticServeOutputDir).toBe("");
  });

  it("keeps managed Docker static sites in the generated web image", () => {
    expect(resolveDeployRouting({
      workload: "static", runtimeName: "docker", managedServer: true,
      rootDirectory: "apps/site", outputDirectory: "out",
    })).toEqual({ buildMode: "normal", deployMode: "server", staticServeOutputDir: "" });
  });
});

/**
 * A reused release's doc-root offset must come from the release, not from today's
 * runtime resolution. Wiring is pinned alongside the behaviour on purpose: the
 * correction is a no-op unless the pipeline feeds it the REUSE branch and passes
 * the corrected routing to the deploy phase, and neither is visible from a unit
 * test of the function.
 */
describe("reusedReleaseRouting (a release that already exists)", () => {
  const staticBare = resolveDeployRouting({
    workload: "static",
    runtimeName: "bare",
    outputDirectory: "dist",
  });
  const staticSandbox = resolveDeployRouting({
    workload: "static",
    runtimeName: "docker",
    outputDirectory: "dist",
  });

  it("keeps a sandbox-built release's release-root doc-root when the runtime now resolves bare", () => {
    // "" is the frozen answer and must survive: re-derived it would be "dist",
    // which the promote aborts on with a build-config error for a restore that
    // ran no build.
    expect(reusedReleaseRouting(staticBare, "").staticServeOutputDir).toBe("");
  });

  it("keeps a bare-built release's output dir when the runtime now resolves docker", () => {
    // Re-derived this would be "", publishing the promoted source tree as the
    // site and reporting success.
    expect(reusedReleaseRouting(staticSandbox, "dist").staticServeOutputDir).toBe("dist");
  });

  it("leaves buildMode and deployMode alone — it corrects one field", () => {
    expect(reusedReleaseRouting(staticSandbox, "dist")).toEqual({
      ...staticSandbox,
      staticServeOutputDir: "dist",
    });
  });

  it("falls back to the derived answer for a release predating the field", () => {
    expect(reusedReleaseRouting(staticBare, undefined)).toBe(staticBare);
  });

  it("never touches a non-static deploy", () => {
    for (const routing of [
      resolveDeployRouting({ workload: "web", runtimeName: "docker", outputDirectory: "dist" }),
      resolveDeployRouting({ workload: "worker", runtimeName: "docker", outputDirectory: "dist" }),
    ]) {
      expect(reusedReleaseRouting(routing, "dist")).toBe(routing);
    }
  });

  it("is wired to the REUSE branch, and its answer is what the deploy phase gets", () => {
    const src = readFileSync(new URL("../../../../../packages/platform/src/engine/modules/deployments/build-pipeline.ts", import.meta.url), "utf8");
    // Gated on the reuse actually happening: a pin whose artifact is gone rebuilds
    // from source, and then the BUILD's answer is the correct one.
    expect(src).toMatch(
      /const servedRouting = reusedArtifact\s*\?\s*reusedReleaseRouting\(deployRouting, snapshot\.staticServeOutputDir\)\s*:\s*deployRouting;/,
    );
    // The deploy phase reads `deployRouting` off `phase`; handing it the
    // uncorrected object is exactly how this would silently stop working.
    expect(src).toMatch(/deployRouting: servedRouting,/);
  });
});

describe("Cloud static hosting selection", () => {
  it.each(["pages", "server"] as const)(
    "freezes %s serving independently of the build runtime",
    (cloudStaticHosting) => {
      const modes = resolveBuildRuntimeModes({
        workload: "static",
        serverId: "managed",
        baseTarget: "cloud",
        effectiveTarget: "cloud",
        willRunServices: false,
        runtimeMode: "bare",
        cloudStaticHosting,
      });
      expect(modes).toEqual({
        buildRuntimeMode: "docker",
        serveRuntimeMode: cloudStaticHosting === "pages" ? "bare" : "docker",
      });
      const routing = resolveDeployRouting({
        workload: "static",
        runtimeName: "docker",
        managedServer: true,
        cloudStaticHosting,
        outputDirectory: "dist",
      });
      expect(routing).toEqual(
        cloudStaticHosting === "pages"
          ? {
              buildMode: "static-sandbox",
              deployMode: "static-file-serve",
              staticServeOutputDir: "",
            }
          : { buildMode: "normal", deployMode: "server", staticServeOutputDir: "" },
      );
    },
  );
  it("keeps legacy Docker releases on containers and ignores Cloud hosting for server apps", () => {
    expect(
      resolveDeployRouting({
        workload: "static",
        runtimeName: "docker",
        managedServer: true,
        outputDirectory: "dist",
      }).deployMode,
    ).toBe("server");
    expect(
      resolveDeployRouting({
        workload: "web",
        runtimeName: "docker",
        managedServer: true,
        cloudStaticHosting: "pages",
        outputDirectory: "dist",
      }).deployMode,
    ).toBe("server");
    expect(
      resolveBuildRuntimeModes({
        workload: "static",
        serverId: "managed",
        baseTarget: "cloud",
        effectiveTarget: "cloud",
        willRunServices: false,
        hasPrebuiltImage: true,
        cloudStaticHosting: "pages",
      }).serveRuntimeMode,
    ).toBe("docker");
  });
});


it("counts server-hosted static containers even with a saved Direct runtime, but not Pages builds", () => {
  for (const runtimeMode of ["bare", "docker"] as const) {
    expect(
      needsRunningApplication({ workload: "static", runtimeMode, cloudStaticHosting: "server" }),
    ).toBe(true);
    expect(
      needsRunningApplication({ workload: "static", runtimeMode, cloudStaticHosting: "pages" }),
    ).toBe(false);
    expect(
      needsRunningApplication({ workload: "web", runtimeMode, cloudStaticHosting: "pages" }),
    ).toBe(true);
    expect(
      needsRunningApplication({
        workload: "static",
        runtimeMode,
        cloudStaticHosting: "pages",
        hasPrebuiltImage: true,
      }),
    ).toBe(true);
  }
});
