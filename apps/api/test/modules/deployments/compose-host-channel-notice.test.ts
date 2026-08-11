import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildLogger, CommandExecutor, MultiServiceRuntimeAdapter } from "@repo/adapters";
import type { Deployment, Project } from "@repo/db";

/**
 * A compose deploy to a box that cannot drive its host must SAY so, once, in the
 * deploy log (#509).
 *
 * With the host channel demoted to refuse-on-use, the #509 repro stops failing and
 * starts silently degrading, which is its own bug: every host touchpoint absorbs the
 * refusal on its own terms. `allocateHostPort` reports "couldn't read occupancy" — and
 * only under `loopback-port` routing — while the routing preflight logs "deploy
 * continues". Neither names the channel or a fix, so the first legible symptom is a
 * container that dies later over a config file that never landed on the host.
 *
 * Driven end-to-end from the real demotion (a `--no-host-control` box resolving its
 * local row) rather than from a stubbed notice, because the bug was never in the
 * wording — it was that nothing carried the fact from the decision to the log.
 */

const h = vi.hoisted(() => ({
  localRow: {
    id: "srv-local",
    isLocal: true,
    sshHost: "127.0.0.1",
    sshPort: 22,
    sshUser: "root",
  },
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      get: async () => h.localRow,
      getInOrganization: async () => h.localRow,
      update: async () => {},
    },
    service: {
      listByProject: async () => [
        { id: "svc-web", name: "web", enabled: true, dependsOn: [], advanced: null },
      ],
    },
  },
}));

// The row IS this box. Keyed off the flag so the test doesn't depend on loopback
// resolution or on which org owns the box.
vi.mock("../../../src/lib/box-org", () => ({
  isLocalHostRow: async (row: { isLocal?: boolean }) => Boolean(row?.isLocal),
  boxOwningOrgId: async () => "org1",
}));

vi.mock("../../../src/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: (f: () => unknown) => f() }),
}));

const { resolveServerExecutor } = await import("../../../src/lib/deployment-runtime");
const { deployComposeServices } = await import(
  "../../../src/modules/deployments/compose/deploy.service"
);

/** Collects what the deploy log was told, in order. */
function recordingLogger() {
  const lines: { message: string; level: string }[] = [];
  const logger = {
    log: (message: string, level = "info") => lines.push({ message, level }),
    step: () => {},
  } as unknown as BuildLogger;
  return { logger, lines };
}

/** Stops the deploy at the first thing after the notice, so the test exercises the
 *  emission point and its ORDER without needing a Docker host. */
function haltingRuntime() {
  return {
    name: "docker",
    ensureServiceGroup: async () => {
      throw new Error("halt: nothing past the notice is under test");
    },
  } as unknown as MultiServiceRuntimeAdapter;
}

const project = { id: "p1", slug: "app", organizationId: "org1" } as unknown as Project;
const dep = { id: "d1", organizationId: "org1", environment: "production" } as unknown as Deployment;

async function demotedExecutor(): Promise<CommandExecutor> {
  const { executor } = await resolveServerExecutor("srv-local", "org1");
  return executor;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("compose deploy — host channel unavailable", () => {
  it("states the skip, the reason and the reassurance, before any host touchpoint", async () => {
    // The real demotion path: host control off is the same typed error an
    // unprovisioned container channel raises, and it is the one a test can produce
    // without a container.
    vi.stubEnv("OPENSHIP_HOST_CONTROL", "false");
    const executor = await demotedExecutor();

    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, { executor }),
    ).rejects.toThrow(/halt/);

    const notice = lines.find((l) => l.message.includes("Host operations are unavailable"));
    expect(notice, `no host-channel notice in the deploy log:\n${lines.map((l) => l.message).join("")}`)
      .toBeDefined();
    expect(notice!.level).toBe("warn");
    // The reason, with the remedy the executor refuses every call with.
    expect(notice!.message).toContain("OPENSHIP_HOST_CONTROL=false");
    // From @repo/core — the deploy in progress still succeeds.
    expect(notice!.message).toContain("Ordinary deploys to this box still work");
    // Said ONCE per deploy, not per touchpoint.
    expect(lines.filter((l) => l.message.includes("Host operations are unavailable"))).toHaveLength(1);
    // Before the first host-touching step, so it reads as the cause of what follows
    // rather than as a footnote to it.
    expect(lines.indexOf(notice!)).toBeLessThan(
      lines.findIndex((l) => l.message.includes("service group")),
    );
  });

  it("is independent of the routing strategy", async () => {
    // The pre-existing hint appeared only under `loopback-port` — the one strategy that
    // pins a host port. Every strategy loses the same host operations.
    vi.stubEnv("OPENSHIP_HOST_CONTROL", "false");
    const executor = await demotedExecutor();

    for (const routeStrategy of ["container-ip", "loopback-port", undefined]) {
      const { logger, lines } = recordingLogger();
      await expect(
        deployComposeServices(
          { ...project, routeStrategy } as unknown as Project,
          dep,
          haltingRuntime(),
          logger,
          { executor },
        ),
      ).rejects.toThrow(/halt/);
      expect(
        lines.some((l) => l.message.includes("Host operations are unavailable")),
        `no notice under routeStrategy=${String(routeStrategy)}`,
      ).toBe(true);
    }
  });

  it("stays quiet when the channel is fine", async () => {
    // Nothing was demoted, so there is nothing to report — a notice here would be a
    // false claim about the box, which is how the dashboard came to name the wrong
    // machine (#490).
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, {
        executor: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) } as unknown as CommandExecutor,
      }),
    ).rejects.toThrow(/halt/);
    expect(lines.some((l) => l.message.includes("Host operations are unavailable"))).toBe(false);
  });

  it("stays quiet on cloud, which has no executor and no host", async () => {
    const { logger, lines } = recordingLogger();
    await expect(
      deployComposeServices(project, dep, haltingRuntime(), logger, { executor: null }),
    ).rejects.toThrow(/halt/);
    expect(lines.some((l) => l.message.includes("Host operations are unavailable"))).toBe(false);
  });
});
