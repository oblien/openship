import { afterEach, describe, expect, it, vi } from "vitest";
import { repos, type Domain, type Project } from "@repo/db";
import { domainDiagnostics, withDomainDiagnostics } from "@repo/platform/engine/modules/domains/domain-diagnostics";

const now = new Date("2026-09-23T00:01:00Z");
const project = {
  activeDeploymentId: "dep",
  deletedAt: null,
  disabledAt: null,
  deletionInProgress: false,
};
const schedule = { cron: "*/13 * * * *", unavailable: false };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const domain = (patch: Partial<Domain> = {}): Domain =>
  ({
    id: "domain",
    projectId: "project",
    domainType: "custom",
    hostname: "app.example.com",
    verified: false,
    verifyAttempts: 0,
    lastCheckedAt: null,
    lastVerifyError: null,
    status: "pending",
    sslStatus: "none",
    sslExpiresAt: null,
    createdAt: new Date("2026-09-23T00:00:00Z"),
    ...patch,
  }) as Domain;

describe("domain details reflect the persisted check and actual schedule", () => {
  it.each([
    { pending: true, health: false, action: "verify", next: "2026-09-23T00:15:00.000Z" },
    { pending: false, health: true, action: "verify_ssl", next: "2026-09-23T00:17:00.000Z" },
    { pending: true, health: true, action: "verify", next: "2026-09-23T00:15:00.000Z" },
  ])("uses the earliest enabled Cloud check (pending=$pending, health=$health)", async ({ pending, health, action, next }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(repos.job, "findByKey").mockImplementation(async (key) => ({
      enabled: key === "domains:verify-pending" ? pending : health,
      scheduleType: "recurring",
      cronExpression: key === "domains:verify-pending" ? "*/5 * * * *" : "2-59/5 * * * *",
    }) as NonNullable<Awaited<ReturnType<typeof repos.job.findByKey>>>);
    const row = domain({ verified: true, status: "active", sslStatus: "error", verifyAttempts: 1,
      lastCheckedAt: new Date("2026-09-23T00:00:00Z") });
    const [result] = await withDomainDiagnostics({ ...project, workspaceId: "workspace" } as Project, [row], []);
    expect(result.diagnostics).toMatchObject({ automaticRetry: "scheduled", retryAction: action, nextRetryAt: next });
  });

  it("schedules a failed Cloud observation even while retaining an active certificate", () => {
    const row = domain({ verified: true, status: "active", sslStatus: "active", verifyAttempts: 1,
      lastVerifyError: "HTTPS could not be checked", lastCheckedAt: new Date("2026-09-23T00:00:00Z") });
    expect(domainDiagnostics(row, project, {
      cron: "2-59/5 * * * *", unavailable: false, healthCheckIntervalMs: 300_000,
    }, true, now)).toMatchObject({
      retryAction: "verify_ssl", automaticRetry: "scheduled", nextRetryAt: "2026-09-23T00:17:00.000Z",
    });
  });

  it("respects the Cloud observer's minimum age and disabled job", () => {
    const row = domain({ verified: true, status: "active", sslStatus: "provisioning",
      lastCheckedAt: new Date("2026-09-23T00:00:00Z") });
    const health = { cron: "2-59/5 * * * *", unavailable: false, healthCheckIntervalMs: 300_000 };
    expect(domainDiagnostics(row, project, health, true, now)?.nextRetryAt).toBe("2026-09-23T00:07:00.000Z");
    expect(domainDiagnostics(row, project, { ...health, cron: null }, true, now)).toMatchObject({
      automaticRetry: "disabled", nextRetryAt: null, retryAction: "verify_ssl",
    });
  });

  it("schedules the first check after the grace period on the configured cron", () => {
    expect(domainDiagnostics(domain(), project, schedule, true, now)).toEqual({
      state: "pending",
      reason: "verification",
      retryAction: "verify",
      automaticRetry: "scheduled",
      nextRetryAt: "2026-09-23T00:13:00.000Z",
    });
    expect(
      domainDiagnostics(domain(), project, { cron: "*/5 * * * *", unavailable: false }, true, now)
        ?.nextRetryAt,
    ).toBe("2026-09-23T00:10:00.000Z");
  });

  it("shows a completed failure immediately, including rows saved with the old pending status", () => {
    expect(
      domainDiagnostics(
        domain({
          verifyAttempts: 1,
          lastCheckedAt: new Date("2026-09-23T00:02:00Z"),
          lastVerifyError: "SSH unavailable",
        }),
        project,
        schedule,
        true,
        now,
      ),
    ).toMatchObject({
      state: "failed",
      automaticRetry: "scheduled",
      nextRetryAt: "2026-09-23T00:26:00.000Z",
    });
  });

  it("retains backoff across restarts and never gives up after eight failures", () => {
    expect(
      domainDiagnostics(
        domain({ status: "failed", verifyAttempts: 30, lastCheckedAt: now }),
        project,
        schedule,
        true,
        now,
      ),
    ).toMatchObject({ state: "failed", nextRetryAt: "2026-09-23T06:13:00.000Z" });
  });

  it.each([
    { cron: null, unavailable: false, mode: "disabled" },
    { cron: null, unavailable: true, mode: "unavailable" },
    { cron: "invalid", unavailable: false, mode: "unavailable" },
  ])("does not invent a next run for a $mode schedule", ({ mode, ...job }) => {
    expect(domainDiagnostics(domain(), project, job, true, now)).toMatchObject({
      state: "waiting",
      nextRetryAt: null,
      automaticRetry: mode,
      retryAction: "verify",
    });
  });

  it("waits for deployment or enablement without offering an ineffective retry", () => {
    expect(
      domainDiagnostics(domain(), { ...project, activeDeploymentId: null }, schedule, true, now),
    ).toMatchObject({
      state: "waiting",
      reason: "deployment",
      retryAction: null,
      nextRetryAt: null,
    });
    expect(domainDiagnostics(domain(), project, schedule, false, now)).toMatchObject({
      state: "waiting",
      reason: "disabled",
      retryAction: null,
      nextRetryAt: null,
    });
  });

  it("schedules failed or expired certificates but never issues an uploaded certificate", () => {
    const expired = domain({
      verified: true,
      sslStatus: "active",
      sslExpiresAt: new Date("2026-09-22T00:00:00Z"),
    });
    expect(domainDiagnostics(expired, project, schedule, true, now)).toMatchObject({
      state: "failed",
      reason: "certificate",
      retryAction: "verify",
      nextRetryAt: "2026-09-23T00:13:00.000Z",
    });
    expect(
      domainDiagnostics({ ...expired, manualSsl: true }, project, schedule, true, now),
    ).toMatchObject({
      state: "failed",
      reason: "manual_certificate",
      retryAction: "verify_ssl",
      nextRetryAt: null,
    });
  });

  it("keeps a valid certificate while explaining a failed last check, without promising a pending-SSL retry", () => {
    const valid = domain({
      verified: true,
      status: "active",
      sslStatus: "active",
      sslExpiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    expect(domainDiagnostics(valid, project, schedule, true, now)).toBeNull();
    expect(
      domainDiagnostics(
        { ...valid, lastVerifyError: "SSH unavailable", verifyAttempts: 1 },
        project,
        schedule,
        true,
        now,
      ),
    ).toMatchObject({
      state: "failed",
      reason: "certificate",
      retryAction: "verify",
      nextRetryAt: null,
      automaticRetry: "not_applicable",
    });
  });

  it("offers manual TXT setup and renewal without inventing an automatic retry", () => {
    const manual = domain({ hostname: "*.example.com", sslDnsMode: "manual" });
    expect(domainDiagnostics(manual, project, schedule, true, now)).toMatchObject({
      state: "waiting", reason: "manual_dns", retryAction: "verify", nextRetryAt: null, automaticRetry: "not_applicable",
    });
    const healthy = { ...manual, verified: true, sslStatus: "active", sslExpiresAt: new Date("2027-01-01T00:00:00Z") };
    expect(domainDiagnostics(healthy, project, schedule, true, now)).toBeNull();
    expect(domainDiagnostics({ ...healthy, sslExpiresAt: new Date("2026-09-25T00:00:00Z") }, project, schedule, true, now)).toMatchObject({
      state: "waiting", reason: "manual_dns", nextRetryAt: null,
    });
    expect(domainDiagnostics({ ...healthy, sslExpiresAt: new Date("2026-09-22T00:00:00Z") }, project, schedule, true, now)).toMatchObject({
      state: "failed", reason: "manual_dns", nextRetryAt: null,
    });
  });
});
