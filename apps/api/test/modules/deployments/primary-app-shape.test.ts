import { expect, it } from "vitest";
import type { Project, Service } from "@repo/db";
import { primaryAppWithInfrastructure } from "@repo/platform/engine/modules/deployments/compose/project-services";

const project = {
  slug: "app",
  framework: "laravel",
  rootDirectory: ".",
  buildCommand: "composer install",
} as Project;
const app = {
  id: "web",
  name: "app",
  kind: "monorepo",
  enabled: true,
  sortOrder: -1,
  rootDirectory: ".",
  environment: {},
  volumes: [],
  advanced: {},
} as Service;
const database = {
  id: "db",
  name: "database",
  kind: "compose",
  enabled: true,
  image: "postgres:16-alpine",
  exposed: false,
} as Service;
it("recognizes only one inherited primary source app with private image infrastructure", () => {
  expect(primaryAppWithInfrastructure(project, [app, database])).toMatchObject({
    app,
    infrastructure: [database],
  });
  expect(
    primaryAppWithInfrastructure({ ...project, framework: "docker" }, [app, database]),
  ).not.toBeNull();
  expect(
    primaryAppWithInfrastructure(project, [
      app,
      database,
      { ...app, id: "disabled", enabled: false },
    ]),
  ).not.toBeNull();
});
it.each([
  ["second app", [app, database, { ...app, id: "second", name: "other" }]],
  ["built infrastructure", [app, { ...database, build: "." }]],
  [
    "inline-built infrastructure",
    [app, { ...database, advanced: { build: { dockerfile: "FROM postgres:16-alpine" } } }],
  ],
  ["public infrastructure", [app, { ...database, exposed: true }]],
  ["custom app environment", [{ ...app, environment: { SECRET: "must-not-drop" } }, database]],
  ["custom app command", [{ ...app, startCommand: "php artisan serve" }, database]],
  ["custom app directory", [{ ...app, rootDirectory: "other" }, database]],
  ["custom app build arguments", [{ ...app, buildArgs: { CUSTOM: "keep-me" } }, database]],
  ["literal app volumes", [{ ...app, namespaceVolumes: false }, database]],
  ["custom app restart policy", [{ ...app, restart: "no" }, database]],
  ["unavailable primary dependency", [{ ...app, dependsOn: ["missing"] }, database]],
  ["additional app port", [{ ...app, ports: ["9000"] }, database]],
  ["custom app volume", [{ ...app, volumes: ["data:/data"] }, database]],
  ["infrastructure depends on app", [app, { ...database, dependsOn: [app.name] }]],
  [
    "infrastructure shares app namespace",
    [app, { ...database, advanced: { networkMode: `service:${app.name}` } }],
  ],
] as const)("keeps %s in the existing service pipeline", (_name, rows) => {
  expect(primaryAppWithInfrastructure(project, [...rows] as Service[])).toBeNull();
});
it("retains a materialized app after infrastructure is removed or disabled", () => {
  expect(primaryAppWithInfrastructure(project, [app])).toEqual({ app, infrastructure: [] });
  expect(primaryAppWithInfrastructure(project, [app, { ...database, enabled: false }])).toEqual({
    app,
    infrastructure: [],
  });
  expect(primaryAppWithInfrastructure(project, [{ ...app, sortOrder: 0 }])).toBeNull();
  expect(
    primaryAppWithInfrastructure(project, [{ ...app, environment: { CUSTOM: "keep" } }]),
  ).toBeNull();
});
it("rejects explicit Compose projects, image-only and ambiguous app identities", () => {
  expect(
    primaryAppWithInfrastructure({ ...project, composePath: "compose.yml" }, [app, database]),
  ).toBeNull();
  expect(
    primaryAppWithInfrastructure({ ...project, framework: "docker-compose" }, [app, database]),
  ).toBeNull();
  expect(
    primaryAppWithInfrastructure({ ...project, framework: "unknown", buildCommand: null }, [
      app,
      database,
    ]),
  ).toBeNull();
  expect(
    primaryAppWithInfrastructure(
      {
        ...project,
        compositeRoutes: [
          {
            hostname: "app.example.test",
            isCustomDomain: true,
            rootServiceId: app.id,
            locations: [],
          },
        ],
      },
      [app, database],
    ),
  ).toBeNull();
  expect(primaryAppWithInfrastructure(project, [database])).toBeNull();
});
