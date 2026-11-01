import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import {
  monorepoAppFromScan,
  reconcileMonorepoApps,
  serializeMonorepoApp,
} from "./monorepo-config";
import { DEFAULT_CONFIG, createPublicEndpoint, syncPublicEndpointState } from "./types";
import { deploymentDnsTargets } from "@/lib/deployment-dns";
import { getModeSwitchUpdates } from "./mode-config";
const scan = {
  id: "apps/api",
  name: "api",
  rootDirectory: "apps/api",
  stack: "node" as const,
  category: "backend",
  packageManager: "bun",
  buildImage: "oven/bun:1.3.14",
  installCommand: "bun install",
  buildCommand: "",
  startCommand: "bun src/index.ts",
  outputDirectory: "",
  productionPaths: [],
  port: 3000,
};
describe("monorepo selection and service-owned routing", () => {
  it("requires selection and round-trips saved private apps and hidden environment values", () => {
    expect(monorepoAppFromScan(scan, "project", "free").enabled).toBe(false);
    const saved = monorepoAppFromScan(
      {
        ...scan,
        enabled: false,
        exposed: false,
        environment: { AUTH_SECRET: ENV_MASK, MODE: "production" },
        publicEndpoints: [{ port: 3000, customDomain: "api.example.com", domainType: "custom" }],
      },
      "project",
      "free",
    );
    expect(saved.envVars[0]).toMatchObject({ value: "", preserveValue: true });
    expect(serializeMonorepoApp(saved)).toMatchObject({
      enabled: false,
      exposed: false,
      environment: { AUTH_SECRET: ENV_MASK, MODE: "production" },
      publicEndpoints: [{ port: 3000, customDomain: "api.example.com", domainType: "custom" }],
    });
  });
  it("retains manual roots and edits across rescans, with new discoveries unselected", () => {
    const previous = {
      ...monorepoAppFromScan(scan, "project", "custom"),
      enabled: true,
      buildCommand: "custom-build",
    };
    const manual = { ...previous, id: ".", rootDirectory: ".", name: "root" };
    const discovered = monorepoAppFromScan(
      { ...scan, rootDirectory: "apps/new", id: "apps/new" },
      "project",
      "free",
    );
    expect(
      reconcileMonorepoApps(
        [previous, manual],
        [monorepoAppFromScan(scan, "project", "free"), discovered],
      ),
    ).toEqual([previous, manual, discovered]);
    expect(discovered.enabled).toBe(false);
  });
  it("applies the shared build and start toggles to the saved commands", () => {
    const app = monorepoAppFromScan({ ...scan, buildCommand: "bun run build" }, "project", "free");
    expect(serializeMonorepoApp({ ...app, hasBuild: false, hasServer: false })).toMatchObject({
      installCommand: "",
      buildCommand: "",
      startCommand: "",
    });
    expect(serializeMonorepoApp(app)).toMatchObject({
      installCommand: scan.installCommand,
      buildCommand: "bun run build",
      startCommand: scan.startCommand,
    });
  });
  it("keeps same-port app domains separate and excludes private apps from DNS", () => {
    const api = {
      ...monorepoAppFromScan(scan, "project", "custom"),
      enabled: true,
      publicEndpoints: [
        createPublicEndpoint({
          port: "3000",
          domainType: "custom",
          customDomain: "api.example.com",
        }),
      ],
    };
    const admin = {
      ...api,
      id: "admin",
      name: "admin",
      exposed: false,
      publicEndpoints: [
        createPublicEndpoint({
          port: "3000",
          domainType: "custom",
          customDomain: "admin.example.com",
        }),
      ],
    };
    const config = syncPublicEndpointState({
      ...DEFAULT_CONFIG,
      projectType: "monorepo",
      serviceDeploymentMode: "services",
      monorepoApps: [api, admin],
    });
    expect(config.publicEndpoints).toEqual([]);
    expect(deploymentDnsTargets(config)).toEqual([
      { hostname: "api.example.com", includeWww: false },
    ]);
    expect(serializeMonorepoApp(admin).publicEndpoints[0].customDomain).toBe("admin.example.com");
    expect(serializeMonorepoApp(api).publicEndpoints[0].customDomain).toBe("api.example.com");
  });
  it("preserves private access, multiple domains and password drafts when switching to single mode", () => {
    const app = {
      ...monorepoAppFromScan(scan, "project", "custom"),
      enabled: true,
      publicEndpoints: [
        createPublicEndpoint({
          domainType: "custom",
          customDomain: "api.example.com",
          port: "3000",
        }),
        createPublicEndpoint({
          domainType: "custom",
          customDomain: "second.example.com",
          port: "3000",
          protectionDraft: {
            action: "protect",
            hostname: "second.example.com",
            password: "example-password",
          },
        }),
      ],
    };
    const config = {
      ...DEFAULT_CONFIG,
      projectType: "monorepo" as const,
      serviceDeploymentMode: "services" as const,
      monorepoApps: [app],
    };
    const single = { ...config, ...getModeSwitchUpdates(config, "single") };
    expect(single.publicEndpoints).toEqual(app.publicEndpoints);
    const edited = {
      ...single,
      publicEndpoints: [
        createPublicEndpoint({
          domainType: "custom",
          customDomain: "single.example.com",
          port: "3000",
        }),
      ],
    };
    expect(deploymentDnsTargets(edited)).toEqual([
      { hostname: "single.example.com", includeWww: false },
    ]);
    const privateSingle = getModeSwitchUpdates(
      { ...config, monorepoApps: [{ ...app, exposed: false }] },
      "single",
    );
    expect(privateSingle).toMatchObject({ noPublicRoute: true, publicEndpoints: [] });
  });
});
