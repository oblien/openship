import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Managed-container drift (edge / mail images pinned to APP_VERSION). The sibling
 * of `server-modules-superseded.test.ts`, but for CONTAINERS: detection compares
 * the running image ref to the pinned ref, apply reuses the rollback-guarded
 * swaps, and the instance sweep only applies under the `autoUpdateInfra` toggle.
 *
 * These pin the seams that would silently break the loop: the pure tag parser
 * (a registry port must not be read as a tag), the detect → upsert/remove cache
 * writes, the Docker-absent no-op, apply's down/updated mapping, and the toggle
 * gating the auto-apply.
 *
 * Mail carries one extra seam: it is not necessarily a container. A legacy
 * pre-containerization box runs systemd Postfix/Dovecot, so its probe runs OUTSIDE
 * the Docker gate and its row is versionless-and-never-behind — asking Docker about
 * it is what made a box that was quietly delivering mail render as "Stopped ·
 * container missing" with no way out.
 */

vi.mock("@repo/db", () => ({
  repos: {
    serverContainerStatus: {
      upsert: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      setInProgress: vi.fn().mockResolvedValue(undefined),
      listByServer: vi.fn().mockResolvedValue([]),
      listByOrg: vi.fn().mockResolvedValue([]),
    },
    mailServer: { get: vi.fn().mockResolvedValue(undefined) },
    server: {
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      listByOrganization: vi.fn().mockResolvedValue([]),
    },
    instanceSettings: { get: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock("@repo/adapters", () => ({
  dockerAvailable: vi.fn().mockResolvedValue(true),
  detectEdgeContainer: vi
    .fn()
    .mockResolvedValue({ name: null, running: false, image: null, exists: false }),
  // Mail detection goes through the ONE topology probe, never a container lookup —
  // a legacy host-native box has no container and must not read as "gone".
  detectMailEngine: vi
    .fn()
    .mockResolvedValue({ flavor: "none", running: false, exists: false, image: null }),
}));

vi.mock("../../../src/lib/edge-image", () => ({
  pinnedEdgeImage: vi.fn(() => "ghcr.io/oblien/openship-edge:0.5.0"),
}));

vi.mock("../../../src/lib/mail-image", () => ({
  pinnedMailImage: vi.fn(() => "ghcr.io/oblien/openship-mail:0.5.0"),
}));

vi.mock("../../../src/lib/edge-reconcile", () => ({
  reconcileServerEdge: vi.fn().mockResolvedValue({ converted: false, updated: true, edgeDown: false }),
}));

vi.mock("../../../src/lib/mail-reconcile", () => ({
  reconcileServerMail: vi.fn().mockResolvedValue({ updated: true, mailDown: false, ran: true }),
  repairServerMail: vi.fn().mockResolvedValue({ started: true, mailDown: false }),
}));

const executor = { exec: vi.fn() };

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: vi.fn(async (_id: string, fn: (e: unknown) => unknown) => fn(executor)),
  },
}));

import {
  imageTag,
  classifyContainerIssues,
  detectServerContainers,
  applyServerContainer,
  refreshServerContainer,
  scanInstanceContainers,
  scanOrgContainers,
} from "../../../src/modules/system/server-containers.service";
import { repos } from "@repo/db";
import { dockerAvailable, detectEdgeContainer, detectMailEngine } from "@repo/adapters";
import { reconcileServerEdge } from "../../../src/lib/edge-reconcile";
import { reconcileServerMail, repairServerMail } from "../../../src/lib/mail-reconcile";

/** An installed edge probe result, running the given image (or stopped). */
function edgeContainer(image: string | null, running = true) {
  return { name: "openship-edge", running, image, exists: true };
}
const edgeAbsent = { name: null, running: false, image: null, exists: false };

/** A containerized mail engine that exists, running the given image (or stopped). */
function mailContainerEngine(image: string | null, running = true) {
  return { flavor: "container" as const, running, image, exists: true };
}
/** A LEGACY host-native engine: systemd units, no container and no image at all. */
function mailHostEngine(running = true) {
  return { flavor: "host" as const, running, image: null, exists: true };
}
const mailEngineAbsent = { flavor: "none" as const, running: false, image: null, exists: false };

const mocked = {
  status: vi.mocked(repos.serverContainerStatus),
  mailServer: vi.mocked(repos.mailServer),
  server: vi.mocked(repos.server),
  settings: vi.mocked(repos.instanceSettings),
  docker: vi.mocked(dockerAvailable),
  edge: vi.mocked(detectEdgeContainer),
  mailEngine: vi.mocked(detectMailEngine),
  reconcileEdge: vi.mocked(reconcileServerEdge),
  reconcileMail: vi.mocked(reconcileServerMail),
  repairMail: vi.mocked(repairServerMail),
};

const server = { id: "srv_1", organizationId: "org_1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.docker.mockResolvedValue(true);
  mocked.edge.mockResolvedValue(edgeAbsent as never);
  mocked.mailEngine.mockResolvedValue(mailEngineAbsent as never);
  mocked.mailServer.get.mockResolvedValue(undefined as never);
  mocked.server.get.mockResolvedValue(undefined as never);
  mocked.server.list.mockResolvedValue([] as never);
  mocked.server.listByOrganization.mockResolvedValue([] as never);
  mocked.settings.get.mockResolvedValue(undefined as never);
  mocked.reconcileEdge.mockResolvedValue({ converted: false, updated: true, edgeDown: false } as never);
  mocked.reconcileMail.mockResolvedValue({ updated: true, mailDown: false, ran: true } as never);
  mocked.repairMail.mockResolvedValue({ started: true, mailDown: false } as never);
});

describe("imageTag", () => {
  it("reads the tag from a normal ref", () => {
    expect(imageTag("ghcr.io/oblien/openship-edge:0.5.0")).toBe("0.5.0");
  });
  it("does not mistake a registry port for the tag", () => {
    expect(imageTag("registry.local:5000/img")).toBeNull();
    expect(imageTag("registry.local:5000/img:1.2.3")).toBe("1.2.3");
  });
  it("returns the tag before a digest, or null for a bare digest", () => {
    expect(imageTag("ghcr.io/o/img:0.4.0@sha256:abc")).toBe("0.4.0");
    expect(imageTag("img@sha256:abc")).toBeNull();
  });
  it("returns null for an untagged ref or nullish input", () => {
    expect(imageTag("nginx")).toBeNull();
    expect(imageTag(null)).toBeNull();
    expect(imageTag(undefined)).toBeNull();
  });
});

describe("detectServerContainers", () => {
  it("marks the edge behind when its running image differs from the pin, and caches it", async () => {
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.4.0") as never);

    const views = await detectServerContainers(server);

    const edge = views.find((v) => v.component === "edge");
    expect(edge).toMatchObject({
      behind: true,
      down: false,
      runningVersion: "0.4.0",
      pinnedVersion: "0.5.0",
    });
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge", behind: true }),
    );
    // No edge container found would remove; here it's present, so no removal.
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "edge");
    // No mail row provisioned → the mail cache row is dropped.
    expect(mocked.status.remove).toHaveBeenCalledWith("srv_1", "mail");
  });

  it("is not behind when the running image already matches the pin", async () => {
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0") as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "edge")).toMatchObject({ behind: false, down: false });
  });

  it("tracks an installed-but-stopped edge as down, never behind or removed", async () => {
    // exists:true, running:false — the box has an edge, it just isn't up.
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.4.0", false) as never);

    const views = await detectServerContainers(server);
    const edge = views.find((v) => v.component === "edge");
    expect(edge).toMatchObject({ down: true, behind: false });
    // The row is kept (upserted), not dropped — "track if installed".
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge", detail: expect.objectContaining({ down: true }) }),
    );
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "edge");
  });

  it("drops the edge row only when no edge container exists at all", async () => {
    mocked.edge.mockResolvedValue(edgeAbsent as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "edge")).toBeUndefined();
    expect(mocked.status.remove).toHaveBeenCalledWith("srv_1", "edge");
  });

  it("leaves the edge row untouched when the probe is inconclusive (no removal on a transient failure)", async () => {
    // detectEdgeContainer returns null when `docker ps -a` couldn't run — a probe
    // failure, NOT a confirmed absence. The cached row must survive: neither
    // upserted (no fresh truth) nor removed (that's the scan-wiped-my-row bug).
    mocked.edge.mockResolvedValue(null as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "edge")).toBeUndefined();
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "edge");
    expect(mocked.status.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge" }),
    );
  });

  it("leaves the edge row untouched when the probe throws (SSH hiccup)", async () => {
    mocked.edge.mockRejectedValue(new Error("ssh channel closed") as never);

    await detectServerContainers(server);
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "edge");
    expect(mocked.status.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge" }),
    );
  });

  it("reports a provisioned-but-stopped mail engine as down, never behind", async () => {
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(mailContainerEngine(null, false) as never);

    const views = await detectServerContainers(server);
    const mail = views.find((v) => v.component === "mail");
    expect(mail).toMatchObject({ down: true, behind: false, containerMissing: false });
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ component: "mail", detail: expect.objectContaining({ down: true }) }),
    );
  });

  // A LEGACY pre-containerization box (systemd Postfix/Dovecot) is the flavor every
  // mail server in the field has while the engine image is unpublished. It has no
  // image, so it can never be "behind", and reading Docker about it is what used to
  // render a box that is quietly delivering mail as "Stopped · container missing".
  it("tracks a serving LEGACY host engine as healthy, with no version and no drift", async () => {
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(mailHostEngine() as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "mail")).toMatchObject({
      down: false,
      behind: false,
      containerMissing: false,
      runningLabel: null,
      runningVersion: null,
      flavor: "host",
    });
    // The flavor is persisted even on a healthy row — it's what the UI reads to
    // label the box instead of rendering a blank running version.
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "mail",
        behind: false,
        detail: { flavor: "host" },
      }),
    );
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "mail");
  });

  it("reports a stopped LEGACY host engine as down but startable in place", async () => {
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(mailHostEngine(false) as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "mail")).toMatchObject({
      down: true,
      behind: false,
      containerMissing: false, // systemctl start fixes it — offer the one-click Fix
      flavor: "host",
    });
  });

  it("marks a provisioned box with no engine at all as missing (Docker answered)", async () => {
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(mailEngineAbsent as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "mail")).toMatchObject({
      down: true,
      containerMissing: true,
      flavor: "container",
    });
  });

  it("keeps a provisioned mail row when Docker is unreachable (no wrong deletions)", async () => {
    // With no reachable daemon the container probe can't conclude, so "no engine"
    // is a failed read — writing it would flip a live mail box to "container gone".
    mocked.docker.mockResolvedValue(false);
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(mailEngineAbsent as never);

    const views = await detectServerContainers(server);
    expect(views).toEqual([]);
    expect(mocked.status.upsert).not.toHaveBeenCalled();
    expect(mocked.status.remove).not.toHaveBeenCalled();
  });

  it("still sees a LEGACY host engine on a box with no Docker at all", async () => {
    // The whole point of running mail's probe outside the Docker gate: a bare host
    // that never installed Docker is exactly where the legacy flavor lives.
    mocked.docker.mockResolvedValue(false);
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(mailHostEngine() as never);

    const views = await detectServerContainers(server);
    expect(views.find((v) => v.component === "mail")).toMatchObject({ flavor: "host", down: false });
    // The edge probe is skipped (nothing to conclude), so its row survives.
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "edge");
    expect(mocked.status.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge" }),
    );
  });

  it("leaves the edge row untouched when Docker is unreachable", async () => {
    mocked.docker.mockResolvedValue(false);
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.4.0") as never);

    const views = await detectServerContainers(server);
    expect(views).toEqual([]);
    expect(mocked.status.upsert).not.toHaveBeenCalled();
    expect(mocked.status.remove).not.toHaveBeenCalledWith("srv_1", "edge");
  });
});

describe("applyServerContainer", () => {
  it("maps a successful edge swap to updated:true, down:false", async () => {
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0") as never);

    const result = await applyServerContainer(server, "edge");
    expect(result).toMatchObject({ component: "edge", updated: true, down: false });
    expect(mocked.reconcileEdge).toHaveBeenCalled();
    // in-progress is set and cleared around the swap.
    expect(mocked.status.setInProgress).toHaveBeenCalledWith("srv_1", "edge", true);
    expect(mocked.status.setInProgress).toHaveBeenCalledWith("srv_1", "edge", false);
  });

  it("surfaces a failed-and-unrolled-back edge swap as down, with an error detail", async () => {
    mocked.reconcileEdge.mockResolvedValue({ converted: false, updated: false, edgeDown: true } as never);
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.4.0") as never);

    const result = await applyServerContainer(server, "edge");
    expect(result).toMatchObject({ down: true });
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ lastError: expect.any(String) }) }),
    );
  });

  it("throws when asked to update mail on a box with no provisioned mail server", async () => {
    mocked.mailServer.get.mockResolvedValue(undefined as never);
    await expect(applyServerContainer(server, "mail")).rejects.toThrow(/no mail server/i);
    expect(mocked.reconcileMail).not.toHaveBeenCalled();
  });

  it("swaps mail with the persisted domain when the box is provisioned", async () => {
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(
      mailContainerEngine("ghcr.io/oblien/openship-mail:0.5.0") as never,
    );

    const result = await applyServerContainer(server, "mail");
    expect(result).toMatchObject({ component: "mail", updated: true, down: false });
    expect(mocked.reconcileMail).toHaveBeenCalledWith(
      executor,
      expect.objectContaining({ domain: "mail.example.com" }),
    );
  });

  it("routes intent=repair for mail to the start-only path, never the swap", async () => {
    // Repair must not touch reconcileServerMail: that path can rewrite the secret
    // env-files on a first-boot run, which would destroy a live mailbox. It also
    // doesn't share update's "no mail server provisioned" throw — starting a
    // container that's already there needs no DB record.
    mocked.mailServer.get.mockResolvedValue(undefined as never);

    const result = await applyServerContainer(server, "mail", undefined, "repair");
    expect(result).toMatchObject({ component: "mail", updated: true, down: false });
    expect(mocked.repairMail).toHaveBeenCalledWith(executor, expect.anything());
    expect(mocked.reconcileMail).not.toHaveBeenCalled();
  });

  it("reports a repair that could not start the engine as down", async () => {
    mocked.repairMail.mockResolvedValue({ started: false, mailDown: true } as never);
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(
      mailContainerEngine("ghcr.io/oblien/openship-mail:0.5.0", false) as never,
    );

    const result = await applyServerContainer(server, "mail", undefined, "repair");
    expect(result).toMatchObject({ updated: false, down: true });
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "mail",
        detail: expect.objectContaining({ lastError: expect.stringMatching(/could not be started/i) }),
      }),
    );
  });

  it("routes intent=repair for edge to the same reconcile (it recreates a stopped edge)", async () => {
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0") as never);

    const result = await applyServerContainer(server, "edge", undefined, "repair");
    expect(result).toMatchObject({ component: "edge", updated: true, down: false });
    expect(mocked.reconcileEdge).toHaveBeenCalled();
    expect(mocked.repairMail).not.toHaveBeenCalled();
  });

  // ── The apply must not report a REFUSED convergence as "nothing to do" ──
  //
  // A box whose 80/443 are held by a foreign proxy needs takeover consent, which this
  // path has no way to ask for, so `reconcileServerEdge` returns a reason and leaves
  // the old proxy serving: `edgeDown:false` (something IS serving), `updated:false`.
  // That is byte-identical to a healthy already-current edge, and reading it as such
  // is what put a green "edge installed" banner over an edge that had never bound :80.
  it("reports a refused edge convergence as an error even though the box is still served", async () => {
    mocked.reconcileEdge.mockResolvedValue({
      converted: false,
      updated: false,
      edgeDown: false,
      error: "Ports 80, 443 are in use by another service (openresty). Accept a migrate or takeover to continue.",
    } as never);
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0", false) as never);

    const result = await applyServerContainer(server, "edge");
    expect(result).toMatchObject({ updated: false, down: false });
    expect(result.error).toMatch(/takeover to continue/i);
    // The operator-actionable reason reaches the cached row, so the attention card
    // names the conflict instead of repeating a generic failure.
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "edge",
        detail: expect.objectContaining({ lastError: expect.stringMatching(/takeover to continue/i) }),
      }),
    );
  });

  it("prefers the reconcile's own reason over the generic sentence when the edge is also down", async () => {
    mocked.reconcileEdge.mockResolvedValue({
      converted: false,
      updated: false,
      edgeDown: true,
      error: 'bind() to 0.0.0.0:80 failed (98: Address already in use)',
    } as never);
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0", false) as never);

    const result = await applyServerContainer(server, "edge");
    expect(result).toMatchObject({ down: true });
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ lastError: expect.stringContaining("Address already in use") }),
      }),
    );
    expect(mocked.status.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ lastError: expect.stringMatching(/see logs/i) }),
      }),
    );
  });

  it("carries a failed mail image swap's reason out of the apply", async () => {
    mocked.reconcileMail.mockResolvedValue({
      updated: false,
      mailDown: false,
      ran: true,
      error: "manifest unknown: manifest tagged by 0.5.0 is not found",
    } as never);
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(
      mailContainerEngine("ghcr.io/oblien/openship-mail:0.4.0") as never,
    );

    const result = await applyServerContainer(server, "mail");
    expect(result).toMatchObject({ updated: false, down: false });
    expect(result.error).toMatch(/manifest unknown/);
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "mail",
        detail: expect.objectContaining({ lastError: expect.stringMatching(/manifest unknown/) }),
      }),
    );
  });

  it("carries a mail repair's own reason instead of the generic start failure", async () => {
    mocked.repairMail.mockResolvedValue({
      started: false,
      mailDown: true,
      reason: "There is no mail engine on this server — run mail setup on it first.",
    } as never);
    mocked.mailServer.get.mockResolvedValue({ domain: "mail.example.com" } as never);
    mocked.mailEngine.mockResolvedValue(
      mailContainerEngine("ghcr.io/oblien/openship-mail:0.5.0", false) as never,
    );

    const result = await applyServerContainer(server, "mail", undefined, "repair");
    expect(result.error).toMatch(/run mail setup/i);
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ lastError: expect.stringMatching(/run mail setup/i) }),
      }),
    );
  });

  it("leaves the cached row alone when the post-apply probe cannot conclude", async () => {
    // An inconclusive re-read must not rewrite the row: the pre-action state is the
    // best thing known, and guessing here is how a live component's row gets clobbered.
    mocked.edge.mockRejectedValue(new Error("docker daemon not reachable") as never);

    const result = await applyServerContainer(server, "edge");
    expect(result).toMatchObject({ updated: true });
    expect(mocked.status.upsert).not.toHaveBeenCalled();
  });
});

describe("refreshServerContainer", () => {
  // The install stream ("Fix edge" on a box needing 80/443 consent) acts on the box
  // and then has to write what it did back to the cache — without this, a SUCCESSFUL
  // install left the row saying `down`, so the home page kept its "Edge down" card
  // and the operator refreshed into the same issue they had just fixed.
  beforeEach(() => {
    mocked.server.get.mockResolvedValue(server);
  });

  it("clears a stale down row after a successful install", async () => {
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0") as never);

    await refreshServerContainer("srv_1", "edge");
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge", behind: false, detail: null }),
    );
  });

  it("records the failure reason when the install could not finish", async () => {
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.5.0", false) as never);

    await refreshServerContainer("srv_1", "edge", "the edge ports are still bound");
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ down: true, lastError: "the edge ports are still bound" }),
      }),
    );
  });

  it("stays silent when the server is gone or unreachable", async () => {
    mocked.server.get.mockResolvedValue(undefined as never);
    await expect(refreshServerContainer("srv_gone", "edge")).resolves.toBeUndefined();
    expect(mocked.status.upsert).not.toHaveBeenCalled();
  });
});

describe("scanInstanceContainers", () => {
  beforeEach(() => {
    mocked.server.list.mockResolvedValue([server] as never);
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.4.0") as never); // behind
  });

  it("detects drift but never applies when autoUpdateInfra is off", async () => {
    mocked.settings.get.mockResolvedValue({ autoUpdateInfra: false } as never);

    const r = await scanInstanceContainers();
    expect(r).toMatchObject({ servers: 1, behind: 1, updated: 0 });
    expect(mocked.reconcileEdge).not.toHaveBeenCalled();
  });

  it("applies the behind components when autoUpdateInfra is on", async () => {
    mocked.settings.get.mockResolvedValue({ autoUpdateInfra: true } as never);

    const r = await scanInstanceContainers();
    expect(r.behind).toBe(1);
    expect(r.updated).toBe(1);
    expect(mocked.reconcileEdge).toHaveBeenCalled();
  });
});

describe("classifyContainerIssues", () => {
  const srvA = { id: "srv_a", name: "A", sshHost: "10.0.0.1" };
  const srvB = { id: "srv_b", name: null, sshHost: "10.0.0.2" };
  type Detail = { down?: boolean; containerMissing?: boolean; lastError?: string | null };
  const edgeRow = (serverId: string, detail?: Detail) => ({
    serverId,
    component: "edge" as const,
    detail: detail ?? null,
  });
  const mailRow = (serverId: string, detail?: Detail) => ({
    serverId,
    component: "mail" as const,
    detail: detail ?? null,
  });
  /** No issues → every counter at zero and an empty list. */
  const CLEAN = { total: 0, servers: [], edgeDown: 0, edgeMissing: 0, mailDown: 0 };

  it("flags a down edge as an issue, regardless of projects", () => {
    const r = classifyContainerIssues([srvA], [edgeRow("srv_a", { down: true })], {});
    expect(r).toMatchObject({ total: 1, edgeDown: 1, edgeMissing: 0, mailDown: 0 });
    expect(r.servers[0]).toEqual({
      server: { id: "srv_a", name: "A" },
      component: "edge",
      issue: "down",
      containerMissing: false,
    });
  });

  // The attention surface can only name a cause if the rollup carries one. A
  // stopped container has no error and must NOT get an empty/garbage reason.
  it("passes a recorded failure through as the issue's reason", () => {
    const withError = classifyContainerIssues(
      [srvA],
      [edgeRow("srv_a", { down: true, lastError: "the container could not be started — see logs" })],
      {},
    );
    expect(withError.servers[0]?.reason).toBe("the container could not be started — see logs");

    const merelyStopped = classifyContainerIssues([srvA], [edgeRow("srv_a", { down: true })], {});
    expect(merelyStopped.servers[0]).not.toHaveProperty("reason");

    const mail = classifyContainerIssues(
      [srvA],
      [mailRow("srv_a", { down: true, containerMissing: true, lastError: "image pull failed" })],
      {},
    );
    expect(mail.servers[0]).toMatchObject({
      component: "mail",
      containerMissing: true,
      reason: "image pull failed",
    });
  });

  it("flags an ABSENT edge as an issue only when the box hosts projects", () => {
    const r = classifyContainerIssues([srvA], [], { srv_a: 2 });
    expect(r).toMatchObject({ total: 1, edgeMissing: 1, edgeDown: 0 });
    // Absent means there is nothing to start — the fix is the install path.
    expect(r.servers[0]).toEqual({
      server: { id: "srv_a", name: "A" },
      component: "edge",
      issue: "absent",
      containerMissing: true,
    });
  });

  it("does NOT flag an absent edge on a box with no projects (offer, not alarm)", () => {
    const r = classifyContainerIssues([srvA], [], {}); // no projectCounts entry
    expect(r).toEqual(CLEAN);
  });

  it("does NOT flag a behind (updatable) or healthy edge — that's the updates surface", () => {
    // A present, not-down edge row: behind or current, either way not an issue.
    const r = classifyContainerIssues([srvA], [edgeRow("srv_a", { down: false })], { srv_a: 3 });
    expect(r).toEqual(CLEAN);
  });

  it("flags a down mail engine — a stopped engine isn't delivering mail", () => {
    const r = classifyContainerIssues([srvA], [edgeRow("srv_a"), mailRow("srv_a", { down: true })], {
      srv_a: 1,
    });
    expect(r).toMatchObject({ total: 1, mailDown: 1, edgeDown: 0, edgeMissing: 0 });
    expect(r.servers[0]).toEqual({
      server: { id: "srv_a", name: "A" },
      component: "mail",
      issue: "down",
      containerMissing: false,
    });
  });

  it("carries containerMissing so the reader knows a start won't help", () => {
    const rows = [edgeRow("srv_a"), mailRow("srv_a", { down: true, containerMissing: true })];
    const r = classifyContainerIssues([srvA], rows, {});
    expect(r.servers[0]).toMatchObject({ component: "mail", containerMissing: true });
  });

  it("does NOT raise a mail alarm on a box with no mail row (it has no mail)", () => {
    const r = classifyContainerIssues([srvA], [edgeRow("srv_a", { down: false })], {});
    expect(r).toEqual(CLEAN);
  });

  it("counts edge AND mail on the same box as two issues", () => {
    const rows = [edgeRow("srv_a", { down: true }), mailRow("srv_a", { down: true })];
    const r = classifyContainerIssues([srvA], rows, {});
    expect(r).toMatchObject({ total: 2, edgeDown: 1, mailDown: 1 });
    expect(r.servers.map((s) => s.component)).toEqual(["edge", "mail"]);
  });

  it("falls back to sshHost as the name when the server is unnamed", () => {
    const r = classifyContainerIssues([srvB], [edgeRow("srv_b", { down: true })], {});
    expect(r.servers[0]!.server).toEqual({ id: "srv_b", name: "10.0.0.2" });
  });

  it("rolls up a mixed fleet: down + absent-with-projects count, clean + empty don't", () => {
    const servers = [
      srvA, // down edge
      srvB, // absent edge, has projects
      { id: "srv_c", name: "C", sshHost: "10.0.0.3" }, // absent edge, no projects
      { id: "srv_d", name: "D", sshHost: "10.0.0.4" }, // healthy edge, down mail
    ];
    const rows = [
      edgeRow("srv_a", { down: true }),
      edgeRow("srv_d", { down: false }),
      mailRow("srv_d", { down: true }),
    ];
    const r = classifyContainerIssues(servers, rows, { srv_b: 1, srv_c: 0 });
    expect(r).toMatchObject({ total: 3, edgeDown: 1, edgeMissing: 1, mailDown: 1 });
    expect(r.servers.map((s) => s.server.id).sort()).toEqual(["srv_a", "srv_b", "srv_d"]);
  });
});

describe("scanOrgContainers", () => {
  beforeEach(() => {
    mocked.server.listByOrganization.mockResolvedValue([server] as never);
    mocked.edge.mockResolvedValue(edgeContainer("ghcr.io/oblien/openship-edge:0.4.0") as never); // behind
  });

  it("is org-scoped and detect-only — refreshes the cache but never applies", async () => {
    // Even with the toggle ON, the manual org scan must not swap anything.
    mocked.settings.get.mockResolvedValue({ autoUpdateInfra: true } as never);

    const groups = await scanOrgContainers("org_1");

    expect(mocked.server.listByOrganization).toHaveBeenCalledWith("org_1");
    expect(mocked.server.list).not.toHaveBeenCalled();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.views.find((v) => v.component === "edge")).toMatchObject({ behind: true });
    expect(mocked.status.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ component: "edge", behind: true }),
    );
    expect(mocked.reconcileEdge).not.toHaveBeenCalled();
  });
});
