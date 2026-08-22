import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `applyBackupDefaults` is the one click. Its whole value is that it can be
 * called from an install (where it must never be able to fail the install) and
 * from a button on an already-configured project (where it must never touch a
 * policy the user tuned by hand).
 *
 * So the properties under test are the safety ones, not the happy path: it
 * doesn't invent a destination, it doesn't double up on a service that already
 * has a policy, and it doesn't reach into another org's destinations.
 */

const {
  createPolicyMock,
  listDestinationsMock,
  findDestinationMock,
  findOverrideMock,
  listServicesMock,
  auditRecordMock,
} = vi.hoisted(() => ({
  createPolicyMock: vi.fn(),
  listDestinationsMock: vi.fn(),
  findDestinationMock: vi.fn(),
  findOverrideMock: vi.fn(),
  listServicesMock: vi.fn(),
  auditRecordMock: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupDestination: {
      listByOrganization: listDestinationsMock,
      findById: findDestinationMock,
    },
    backupPolicy: { findServiceOverride: findOverrideMock },
    service: { listByProject: listServicesMock },
  },
}));

vi.mock("../../../src/lib/audit", () => ({
  audit: { record: auditRecordMock, recordAsync: auditRecordMock },
}));

vi.mock("../../../src/modules/backups/backup.service", () => ({
  createPolicy: createPolicyMock,
}));

import { applyBackupDefaults } from "../../../src/modules/backups/apply-defaults.service";
import type { AppTemplate } from "@repo/core";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = { organizationId: "org1", userId: "u1" } as RequestContext;

/** An app with one stateful service and one stateless one. */
const template = {
  id: "ghost",
  name: "Ghost",
  description: "",
  kind: "template",
  logo: "ghost",
  category: "cms",
  services: [
    { name: "db", image: "mysql:8.0", volumes: ["ghost_db:/var/lib/mysql"] },
    { name: "web", image: "ghost:5-alpine" },
  ],
} as AppTemplate;

beforeEach(() => {
  vi.clearAllMocks();
  createPolicyMock.mockResolvedValue({ id: "bkp_1" });
  findOverrideMock.mockResolvedValue(undefined);
  listServicesMock.mockResolvedValue([
    { id: "svc-db", name: "db" },
    { id: "svc-web", name: "web" },
  ]);
  listDestinationsMock.mockResolvedValue([
    { id: "dst-old", organizationId: "org1", isDefault: false },
    { id: "dst-default", organizationId: "org1", isDefault: true },
  ]);
});

describe("applyBackupDefaults", () => {
  it("creates one policy per stateful service, on the org's default destination", async () => {
    const result = await applyBackupDefaults(ctx, "proj1", template);

    expect(result).toMatchObject({ applied: 1, services: ["db"] });
    expect(createPolicyMock).toHaveBeenCalledTimes(1);
    expect(createPolicyMock.mock.calls[0][1]).toMatchObject({
      projectId: "proj1",
      serviceId: "svc-db",
      destinationId: "dst-default",
      payloadKind: "auto",
      enabled: true,
    });
    // Enabled WITH a schedule — an idle policy would look configured and back
    // nothing up, which is the failure mode this whole feature exists to remove.
    expect(createPolicyMock.mock.calls[0][1].cronExpression).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it("does nothing, and says why, when the org has no destination", async () => {
    // `destination_id` is NOT NULL and local destinations are gated off by
    // default, so there is nothing safe to fall back to. Reporting beats both
    // throwing (fails an install) and silently succeeding (looks covered).
    listDestinationsMock.mockResolvedValue([]);

    const result = await applyBackupDefaults(ctx, "proj1", template);

    expect(result).toEqual({ applied: 0, skipped: 1, reason: "no-destination", services: [] });
    expect(createPolicyMock).not.toHaveBeenCalled();
    expect(auditRecordMock).not.toHaveBeenCalled();
  });

  it("is idempotent — a service that already has a policy is left alone", async () => {
    findOverrideMock.mockResolvedValue({ id: "bkp_existing" });

    const result = await applyBackupDefaults(ctx, "proj1", template);

    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it("skips a planned service whose row isn't there", async () => {
    listServicesMock.mockResolvedValue([{ id: "svc-web", name: "web" }]);

    const result = await applyBackupDefaults(ctx, "proj1", template);

    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it("reports nothing-to-back-up for an app with no stateful services", async () => {
    const stateless = { ...template, services: [{ name: "web", image: "nginx" }] } as AppTemplate;

    const result = await applyBackupDefaults(ctx, "proj1", stateless);

    expect(result).toMatchObject({ applied: 0, reason: "nothing-to-back-up" });
    expect(listDestinationsMock).not.toHaveBeenCalled();
  });

  it("honours an explicit destination in the caller's own org", async () => {
    findDestinationMock.mockResolvedValue({ id: "dst-x", organizationId: "org1" });

    const result = await applyBackupDefaults(ctx, "proj1", template, { destinationId: "dst-x" });

    expect(result.applied).toBe(1);
    expect(createPolicyMock.mock.calls[0][1].destinationId).toBe("dst-x");
    // Explicit choice means the default-resolution list is never consulted.
    expect(listDestinationsMock).not.toHaveBeenCalled();
  });

  it("refuses a destination belonging to another org, without falling back", async () => {
    // Falling back to this org's default would quietly do something the caller
    // didn't ask for; treating it as absent keeps the blast radius at zero.
    findDestinationMock.mockResolvedValue({ id: "dst-evil", organizationId: "org2" });

    const result = await applyBackupDefaults(ctx, "proj1", template, { destinationId: "dst-evil" });

    expect(result).toMatchObject({ applied: 0, reason: "no-destination" });
    expect(createPolicyMock).not.toHaveBeenCalled();
  });

  it("takes the only destination when none is flagged default", async () => {
    listDestinationsMock.mockResolvedValue([
      { id: "dst-only", organizationId: "org1", isDefault: false },
    ]);

    const result = await applyBackupDefaults(ctx, "proj1", template);

    expect(result.applied).toBe(1);
    expect(createPolicyMock.mock.calls[0][1].destinationId).toBe("dst-only");
  });

  it("records one audit event for the whole apply, not one per policy", async () => {
    const twoStateful = {
      ...template,
      services: [
        { name: "db", image: "mysql:8.0", volumes: ["a:/var/lib/mysql"] },
        { name: "web", image: "ghost:5-alpine", volumes: ["b:/content"] },
      ],
    } as AppTemplate;

    await applyBackupDefaults(ctx, "proj1", twoStateful);

    expect(createPolicyMock).toHaveBeenCalledTimes(2);
    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    expect(auditRecordMock.mock.calls[0][1]).toMatchObject({
      eventType: "backup_policy.defaults_applied",
      resourceType: "project",
      resourceId: "proj1",
      after: { appId: "ghost", destinationId: "dst-default", services: ["db", "web"] },
    });
  });
});
