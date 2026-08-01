import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CreateProjectBody, EnsureProjectBody, UpdateProjectBody } from "./project.schema";

/**
 * Mass-assignment guard: `updateProject` builds its DB patch ONLY from the keys
 * of UpdateProjectBody (the PROJECT_UPDATE_KEYS allow-list), so any internal
 * state column absent here can never be set via PATCH /projects/:id. This test
 * fails loudly if someone adds a dangerous field to CreateProjectBody/UpdateProjectBody.
 */
describe("UpdateProjectBody — mass-assignment allow-list", () => {
  const keys = Object.keys(
    (UpdateProjectBody as unknown as { properties: Record<string, unknown> }).properties,
  );

  it("excludes internal/state columns that would enable cross-tenant escalation", () => {
    for (const forbidden of [
      "id",
      "organizationId",
      "activeDeploymentId",
      "groupId",
      "webhookId",
      "serverId",
      "gitUrl",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("still allows the documented editable fields (no accidental over-restriction)", () => {
    for (const allowed of ["name", "gitBranch", "port", "publicEndpoints", "routingConfig"]) {
      expect(keys).toContain(allowed);
    }
  });
});

/**
 * `publicEndpoints: []` is the wire value for "no public route": `updateProject`
 * gates route reconciliation on `data.publicEndpoints !== undefined`, so an
 * explicit empty array has to reach the service to clear a project's routes.
 * All three bodies are wired as `spec.body`, so the schema is what decides.
 */
describe("publicEndpoints — empty set", () => {
  const endpoint = { domain: "my-app", domainType: "free" as const, port: 3000 };
  const create = (endpoints: unknown[]) =>
    Value.Check(CreateProjectBody, { name: "my-app", publicEndpoints: endpoints });
  const update = (endpoints: unknown[]) =>
    Value.Check(UpdateProjectBody, { publicEndpoints: endpoints });
  const ensure = (endpoints: unknown[]) =>
    Value.Check(EnsureProjectBody, { name: "my-app", publicEndpoints: endpoints });

  it("accepts an explicit empty array on create, update, and ensure", () => {
    expect(create([])).toBe(true);
    expect(update([])).toBe(true);
    expect(ensure([])).toBe(true);
  });

  it("still accepts a populated array and rejects more than 20 entries", () => {
    const tooMany = Array.from({ length: 21 }, () => endpoint);
    expect(create([endpoint])).toBe(true);
    expect(create(tooMany)).toBe(false);
    expect(update(tooMany)).toBe(false);
    expect(ensure(tooMany)).toBe(false);
  });
});
