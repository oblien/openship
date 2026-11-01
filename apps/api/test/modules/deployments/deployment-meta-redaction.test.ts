import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, repos, schema } from "@repo/db";
import { CONFIGURATION_PREFIX } from "@repo/db/configuration-secrets";
import {
  sanitizeDeploymentMeta,
  sanitizeLogsForPersistence,
} from "@repo/platform/engine/modules/deployments/build-log-sanitize";
import { hasRedactedFrozenConfiguration } from "@repo/platform/engine/modules/deployments/compose/redacted-frozen-env";
import { seedDeployment, seedOrg, seedProject } from "../../helpers/seed";

vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: { recordAsync: vi.fn() } }));
vi.mock("@repo/platform/engine/lib/favicon-detector", () => ({ detectAndStoreFavicon: vi.fn() }));
vi.mock("@repo/platform/engine/modules/mail/webmail/webmail-install.service", () => ({
  onWebmailDeployed: vi.fn(),
}));
const { onSuccess, onNoChanges } =
  await import("@repo/platform/engine/modules/deployments/deployment-lifecycle");
const projects: string[] = [];
afterEach(async () => {
  for (const id of projects.splice(0))
    await db.delete(schema.project).where(eq(schema.project.id, id));
});
const DSN = "postgresql://app:release-secret@db:5432/app";
const TOKEN = "ghp_AAAAAAAAAAAAAAAAAAAAAAAA";
const configuration = () => [
  {
    name: "app",
    environment: {
      DATABASE_URL: DSN,
      GITHUB_TOKEN: TOKEN,
      LARGE_CONFIG: "x".repeat(40000),
      EXACT_BYTES: "a\r\nb\u0000\ud800",
    },
    buildArgs: { DATABASE_URL: DSN },
    advanced: { files: [{ path: "/app/config", content: DSN }] },
  },
];

describe("deployment lifecycle preserves encrypted operational configuration (#985)", () => {
  it.each(["success", "no-changes"] as const)(
    "round-trips exact configuration through the %s hook and real storage codec",
    async (outcome) => {
      const org = await seedOrg();
      const project = await seedProject(org.organizationId);
      projects.push(project.id);
      const composeServices = configuration();
      const seed = await seedDeployment(project, { status: "deploying" });
      // Admission uses the repository codec too; never insert plaintext secret
      // fields directly into JSONB, which correctly rejects the NUL fixture.
      await repos.deployment.updateStatus(seed.id, "deploying", { meta: { composeServices } });
      const dep = (await repos.deployment.findById(seed.id))!;
      dep.meta = {
        ...(dep.meta as Record<string, unknown>),
        deployWarning: `failed to clone https://token:secret@github.com/org/repo\u0000`,
      };
      const session = await repos.deployment.createBuildSession({
        deploymentId: dep.id,
        projectId: project.id,
        status: "deploying",
      });
      const ctx = {
        project,
        dep,
        buildSessionId: session.id,
        provisioned: {},
        persistLogs: () =>
          sanitizeLogsForPersistence([
            { timestamp: new Date().toISOString(), message: `Connecting to ${DSN} using ${TOKEN}` },
          ]),
      };
      if (outcome === "success") await onSuccess(ctx, { containerId: "app", durationMs: 1 });
      else await onNoChanges(ctx, { durationMs: 1 });
      const stored = (await repos.deployment.findById(dep.id))!;
      expect(stored.status).toBe(outcome === "success" ? "ready" : "no_changes");
      expect(stored.meta).toMatchObject({ composeServices, configurationSecretsPreserved: true });
      expect((stored.meta as Record<string, unknown>).deployWarning).toBe(
        "failed to clone https://***@github.com/org/repo",
      );
      const [raw] = await db
        .select()
        .from(schema.deployment)
        .where(eq(schema.deployment.id, dep.id));
      expect((raw.meta as Record<string, unknown>).composeServices).toEqual(
        expect.stringMatching(new RegExp(`^${CONFIGURATION_PREFIX}`)),
      );
      expect(JSON.stringify(raw.meta)).not.toContain("release-secret");
      const logs = JSON.stringify(
        (await repos.deployment.findBuildSessionByDeploymentId(dep.id))!.logs,
      );
      expect(logs).not.toContain("release-secret");
      expect(logs).not.toContain(TOKEN);
    },
  );

  it("only exempts fields sealed by the storage codec, not a similarly named diagnostic key", () => {
    const stored = sanitizeDeploymentMeta({
      composeServices: configuration(),
      diagnostics: { composeServices: { warning: DSN } },
    });
    expect(stored.composeServices).toEqual(configuration());
    expect(stored.diagnostics.composeServices.warning).toBe("postgresql://***@db:5432/app");
    expect(sanitizeDeploymentMeta({ warning: DSN })).toEqual({
      warning: "postgresql://***@db:5432/app",
    });
  });

  it("keeps deliberate literal markers in newly captured configuration usable", () => {
    const captured = sanitizeDeploymentMeta({
      composeServices: [
        {
          name: "app",
          environment: {
            MASK_LITERAL: "***",
            URL_LITERAL: "https://***@example.test",
          },
        },
      ],
    });
    expect(hasRedactedFrozenConfiguration(captured)).toBe(false);
    expect(captured.composeServices[0].environment.MASK_LITERAL).toBe("***");
  });

  it("detects unrecoverable legacy DSNs and bare token redaction throughout encrypted configuration", () => {
    for (const composeServices of [
      [{ name: "app", environment: { DATABASE_URL: "postgresql://***@db/app" } }],
      [{ name: "app", environment: { GITHUB_TOKEN: "***" } }],
      [{ name: "app", buildArgs: { TOKEN: "***" } }],
      [{ name: "app", advanced: { files: [{ content: "postgresql://***@db/app" }] } }],
    ])
      expect(hasRedactedFrozenConfiguration({ composeServices })).toBe(true);
    expect(hasRedactedFrozenConfiguration({ composeServices: configuration() })).toBe(false);
    expect(hasRedactedFrozenConfiguration({ warning: "https://***@example.test" })).toBe(false);
  });
});
