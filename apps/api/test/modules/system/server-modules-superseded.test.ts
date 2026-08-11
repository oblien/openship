import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The openresty module's migrations edit the HOST nginx.conf and reload the host
 * binary. `presenceProbe` only asks whether that binary exists — which stopped
 * being the same question as "is this the edge" once the edge became a container
 * on every box.
 *
 * A legacy box converted to the container edge keeps its host OpenResty. Without a
 * gate the module system reports a row for it (an operator reads that as their
 * edge's version) and offers migration 1.1.0, whose apply would rewrite a config
 * nothing loads, reload a binary serving nothing, and stamp the manifest current.
 *
 * So: a running edge container means skip — not `docker exec` the migration in,
 * because the container's config is baked into its image and an edit inside it is
 * lost on the next recreate. These tests pin both halves (report + apply) and the
 * negative case, since a gate that always fires would silently disable migrations
 * for the bare boxes that still need them.
 */

vi.mock("@repo/db", () => ({
  repos: {
    serverModuleStatus: {
      upsert: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      setInProgress: vi.fn().mockResolvedValue(undefined),
    },
    server: { list: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@repo/adapters", () => ({
  ourEdgeContainerRunning: vi.fn(),
  resolveEnvironment: vi.fn().mockResolvedValue({ distro: "debian" }),
  resolveVerifiedCatalog: vi.fn(),
  reconcileServerModule: vi.fn(),
  readManifest: vi.fn().mockResolvedValue({ migrationVersion: "1.0.0", appliedSteps: [] }),
}));

const executor = { exec: vi.fn().mockResolvedValue("openresty/1.25.3.1") };

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: vi.fn(async (_id: string, fn: (e: unknown) => unknown) => fn(executor)),
  },
}));

import { scanServer, applyServerModule } from "../../../src/modules/system/server-modules.service";
import { repos } from "@repo/db";
import {
  ourEdgeContainerRunning,
  resolveVerifiedCatalog,
  reconcileServerModule,
} from "@repo/adapters";

const mocked = {
  edgeContainer: vi.mocked(ourEdgeContainerRunning),
  catalog: vi.mocked(resolveVerifiedCatalog),
  reconcile: vi.mocked(reconcileServerModule),
  status: vi.mocked(repos.serverModuleStatus),
};

const server = { id: "srv_1", organizationId: "org_1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  executor.exec.mockResolvedValue("openresty/1.25.3.1");
  mocked.catalog.mockResolvedValue({
    ref: "test",
    assets: new Map(),
    catalog: { module: "openresty", schema: 1, serial: 1, latest: "1.1.0", versions: [] },
  } as never);
  mocked.reconcile.mockResolvedValue({
    module: "openresty",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    appliedSteps: [],
    pendingConsent: [],
    skipped: [],
    changed: false,
    ok: true,
  });
});

describe("openresty module vs the container edge", () => {
  it("reports no module — and drops a stale row — when the edge is the container", async () => {
    mocked.edgeContainer.mockResolvedValue(true);

    const views = await scanServer(server);

    expect(views).toEqual([]);
    // The row is REMOVED, not just skipped: a box scanned while it was bare would
    // otherwise keep showing a version and an update prompt forever.
    expect(mocked.status.remove).toHaveBeenCalledWith("srv_1", "openresty");
    expect(mocked.status.upsert).not.toHaveBeenCalled();
  });

  it("refuses to apply migrations to a host config the edge does not load", async () => {
    mocked.edgeContainer.mockResolvedValue(true);

    await expect(applyServerModule(server, "openresty", "all")).rejects.toThrow(
      /do not apply here.*openship-edge container/s,
    );
    // The gate is BEFORE the runner, so nothing is written and nothing is stamped.
    expect(mocked.reconcile).not.toHaveBeenCalled();
  });

  it("still reports and applies on a box with no edge container", async () => {
    // The case bare host OpenResty exists for: a Docker-less server, where there is
    // no container to find. A gate that fired here would disable migrations for
    // exactly the boxes that need them.
    mocked.edgeContainer.mockResolvedValue(false);

    const views = await scanServer(server);
    expect(views).toHaveLength(1);
    expect(views[0]!.module).toBe("openresty");
    expect(mocked.status.remove).not.toHaveBeenCalled();
    expect(mocked.status.upsert).toHaveBeenCalled();

    const result = await applyServerModule(server, "openresty", "all");
    expect(result.ok).toBe(true);
    expect(mocked.reconcile).toHaveBeenCalled();
  });

  it("treats an unanswerable probe as not-superseded", async () => {
    // `ourEdgeContainerRunning` swallows its own shell failures, but if it ever
    // threw, failing closed would silently stop migrating every bare box.
    mocked.edgeContainer.mockRejectedValue(new Error("ssh closed"));

    const views = await scanServer(server);
    expect(views).toHaveLength(1);
    expect(mocked.status.remove).not.toHaveBeenCalled();
  });
});
