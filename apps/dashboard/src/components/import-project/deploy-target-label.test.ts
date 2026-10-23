import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DeployTargetSummary } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import { describeBuildStrategy, resolveBuildLocation } from "./deploy-target-label";

vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

const dp = baseDictionary.importProject.deploymentProcessing;

describe("build location", () => {
  it("reports a Docker server build as running on the server even when This Machine was picked", () => {
    const config = { deployTarget: "server", buildStrategy: "local", runtimeMode: "docker" };
    expect(resolveBuildLocation(config)).toBe("target");
    expect(resolveBuildLocation({ deployTarget: "server", buildStrategy: "local" })).toBe("target");
    expect(describeBuildStrategy(config, baseDictionary)).toBe(dp.strategyServer);
  });

  it("keeps a local build where the runtime really builds on this machine", () => {
    const bare = { deployTarget: "server", buildStrategy: "local", runtimeMode: "bare" };
    expect(resolveBuildLocation(bare)).toBe("local");
    expect(describeBuildStrategy(bare, baseDictionary)).toBe(dp.strategyLocal);
    expect(
      resolveBuildLocation({
        deployTarget: "local",
        buildStrategy: "local",
        runtimeMode: "docker",
      }),
    ).toBe("local");
  });

  it("labels a server deployment's build location by its runtime in the target summary", () => {
    const summary = (runtimeMode: "docker" | "bare") =>
      renderToStaticMarkup(
        createElement(DeployTargetSummary, {
          deployTarget: "server",
          buildStrategy: "local",
          runtimeMode,
          serverName: "box-1",
        }),
      );
    expect(summary("docker")).not.toContain(baseDictionary.deploy.summary.buildLocal);
    expect(summary("bare")).toContain(baseDictionary.deploy.summary.buildLocal);
  });

  it.each(["cloud", "cluster"])(
    "does not promise a local %s build from a stale preference",
    (deployTarget) => {
      const config = { deployTarget, buildStrategy: "local", runtimeMode: "bare" };
      expect(resolveBuildLocation(config)).toBe("target");
      expect(describeBuildStrategy(config, baseDictionary)).not.toBe(dp.strategyLocal);
    },
  );

  it.each([
    { projectType: "docker" },
    { projectType: "services", serviceDeploymentMode: "services" },
    { projectType: "monorepo", serviceDeploymentMode: "services" },
    { options: { hasServer: false } },
    { options: { hasServer: true, workloadType: "static" as const } },
  ])("reports forced Docker builds on the server: %j", (config) => {
    expect(
      resolveBuildLocation({
        deployTarget: "server",
        buildStrategy: "local",
        runtimeMode: "bare",
        ...config,
      }),
    ).toBe("target");
  });

  it("preserves local bare workers and single-app mode", () => {
    const config = { deployTarget: "server", buildStrategy: "local", runtimeMode: "bare" };
    expect(
      resolveBuildLocation({ ...config, options: { workloadType: "worker", hasServer: false } }),
    ).toBe("local");
    expect(
      resolveBuildLocation({ ...config, projectType: "services", serviceDeploymentMode: "single" }),
    ).toBe("local");
  });

  it("recognizes the local destination regardless of the legacy strategy", () => {
    expect(
      resolveBuildLocation({
        deployTarget: "local",
        buildStrategy: "server",
        runtimeMode: "docker",
      }),
    ).toBe("local");
  });

  it.each([{ isServices: true }, { hasServer: false }])(
    "uses effective runtime in both target summaries: %j",
    (props) => {
      for (const variant of ["inline", "preview"] as const) {
        const html = renderToStaticMarkup(
          createElement(DeployTargetSummary, {
            deployTarget: "server",
            buildStrategy: "local",
            runtimeMode: "bare",
            variant,
            ...props,
          }),
        );
        expect(html).not.toContain(baseDictionary.deploy.summary.buildLocal);
        expect(html).toContain(
          baseDictionary.deploy.summary.buildAndDeploy.replaceAll("&", "&amp;"),
        );
      }
    },
  );
});
