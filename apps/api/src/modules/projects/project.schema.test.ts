import { describe, it, expect } from "vitest";
import { UpdateProjectBody } from "./project.schema";

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
