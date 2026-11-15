import { describe, expect, it } from "vitest";
import {
  applicationServiceRoute,
  canRefreshProjectEnvironment,
  projectApplication,
} from "./project-application";
import type { Service } from "./api/services";
const project = {
  framework: "nextjs",
  deployTarget: "server",
  options: { workloadType: "web", hasServer: true },
};
const primary = { id: "materialized", kind: "monorepo", applicationMode: "project" } as Service;
const database = { id: "database", kind: "compose" } as Service;
describe("the primary application navigation identity", () => {
  it("keeps one project-backed application before, during and after adding infrastructure", () => {
    expect(projectApplication(project, [])).toEqual({ mode: "project" });
    expect(projectApplication(project, [primary, database])).toEqual({
      mode: "project",
      service: primary,
    });
    expect(projectApplication(project, [primary])).toEqual({ mode: "project", service: primary });
    expect(applicationServiceRoute(primary)).toBe("application");
    expect(applicationServiceRoute(database)).toBe("database");
  });
  it("preserves the route but selects service ownership when overrides exist", () => {
    const service = { ...primary, applicationMode: "service" as const };
    expect(projectApplication(project, [service, database])).toEqual({ mode: "service", service });
    expect(applicationServiceRoute(service)).toBe("application");
  });
  it.each([{ framework: "docker-compose" }, { framework: "docker", composePath: "compose.yml" }])(
    "never inserts a synthetic primary into an explicit Compose project",
    (shape) => {
      expect(projectApplication(shape, [database])).toBeNull();
    },
  );
  it("keeps ordinary monorepo services independent", () => {
    expect(projectApplication(project, [{ ...primary, applicationMode: undefined }])).toBeNull();
  });
  it("keeps a static site beside infrastructure without inventing a runtime process", () => {
    const site = { ...project, options: { workloadType: "static", hasServer: false } };
    expect(projectApplication(site, [database])).toEqual({ mode: "project" });
    expect(canRefreshProjectEnvironment(site, [database])).toBe(false);
  });
  it("uses runtime capabilities even when a primary service row exists", () => {
    expect(canRefreshProjectEnvironment(project, [primary, database])).toBe(true);
    expect(
      canRefreshProjectEnvironment({ ...project, deployTarget: "cloud" }, [primary, database]),
    ).toBe(false);
  });
});
