import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ project: vi.fn(), services: vi.fn(), env: vi.fn() }));
vi.mock("@repo/db", async (original) => {
  const actual = await original<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: { ...actual.repos.project, findById: mocks.project, listEnvVars: mocks.env },
      service: { ...actual.repos.service, listByProject: mocks.services },
    },
  };
});
import { listServices } from "@repo/platform/engine/modules/services/service.service";
const project = {
  id: "p",
  organizationId: "org",
  slug: "website",
  framework: "nextjs",
  rootDirectory: ".",
  buildCommand: "bun run build",
  port: 3000,
  hasServer: true,
  workloadType: "web",
};
const app = {
  id: "app",
  projectId: "p",
  name: "website",
  kind: "monorepo",
  enabled: true,
  sortOrder: -1,
  rootDirectory: ".",
  environment: {},
  volumes: [],
  advanced: {},
  buildArgs: {},
};
const database = {
  id: "db",
  projectId: "p",
  name: "postgres",
  kind: "compose",
  image: "postgres:17",
  enabled: true,
  sortOrder: 0,
  exposed: false,
  environment: { PASSWORD: "private-value" },
};
const context = { organizationId: "org" } as never;
beforeEach(() => {
  mocks.project.mockResolvedValue(project);
  mocks.services.mockResolvedValue([app, database]);
  mocks.env.mockResolvedValue([]);
});
it("exposes one stable project application when the first database is added", async () => {
  const rows = await listServices(context, "p");
  expect(rows.map((s) => [s.id, s.applicationMode])).toEqual([
    ["app", "project"],
    ["db", undefined],
  ]);
  expect(mocks.env).toHaveBeenCalledWith("p", undefined, "app");
  expect(JSON.stringify(rows)).not.toContain("private-value");
});
it("preserves the application identity after removing the last companion", async () => {
  mocks.services.mockResolvedValue([app]);
  expect((await listServices(context, "p"))[0].applicationMode).toBe("project");
});
it.each([
  ["saved runtime override", app, [{ key: "CUSTOM", value: "keep" }]],
  ["Compose value", { ...app, environment: { CUSTOM: "keep" } }, []],
  ["custom build", { ...app, buildCommand: "custom-build" }, []],
  ["renamed app", { ...app, name: "renamed" }, []],
  ["disabled app", { ...app, enabled: false }, []],
])("retains service ownership for %s", async (_name, row, env) => {
  mocks.services.mockResolvedValue([row, database]);
  mocks.env.mockResolvedValue(env);
  expect((await listServices(context, "p"))[0].applicationMode).toBe("service");
});
it.each([
  { ...project, framework: "docker-compose" },
  { ...project, composePath: "compose.yml" },
])("does not collapse a real Compose app into the project", async (shape) => {
  mocks.project.mockResolvedValue(shape);
  expect((await listServices(context, "p")).every((s) => s.applicationMode === undefined)).toBe(
    true,
  );
});
it("does not invent an identity for a regular monorepo application", async () => {
  mocks.services.mockResolvedValue([{ ...app, sortOrder: 0 }, database]);
  expect((await listServices(context, "p"))[0].applicationMode).toBeUndefined();
});

it.each([
  { workspaceId: "cloud-workspace" },
  { clusterId: "cluster" },
  { workloadType: "static", hasServer: false },
])("keeps service controls for a runtime outside the primary app pipeline", async (shape) => {
  mocks.project.mockResolvedValue({ ...project, ...shape });
  expect((await listServices(context, "p"))[0].applicationMode).toBe("service");
});
