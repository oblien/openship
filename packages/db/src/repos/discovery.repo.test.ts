import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createDiscoveryRepo } from "./discovery.repo";
import { createDomainRepo } from "./domain.repo";
import { discoveryConfigHash } from "@repo/core";
import type { DiscoveryObservation } from "./discovery.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createDiscoveryRepo(db);
const domainRepo = createDomainRepo(db);

const SERVER = "srv_discovery_test";

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    serviceKey: "id:my-app",
    containerId: "ctr_1",
    containerName: "my-app",
    running: true,
    hostname: "app.example.com",
    port: 3000,
    networkName: "frontend",
    networkId: "net_1",
    ipAddress: "172.20.0.5",
    configHash: discoveryConfigHash({ hostname: "app.example.com", port: 3000, network: "frontend" }),
    composeProject: "shop",
    composeService: "web",
    ...overrides,
  };
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
  await db.insert(schema.servers).values({ id: SERVER, name: "discovery-test", sshHost: "127.0.0.1", organizationId: "org_1" });
});
beforeEach(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.discoverySettings);
  await db.delete(schema.domain);
});
afterAll(async () => {
  await db.delete(schema.discoveryBinding);
  await db.delete(schema.servers);
  await client.close();
});

describe("discovery settings", () => {
  it("has no row until configured; discovery starts off", async () => {
    expect(await repo.getSettings(SERVER)).toBeUndefined();
    const row = await repo.configure(SERVER, { enabled: false });
    expect(row.enabled).toBe(false);
    expect(row.sweepIntervalSeconds).toBe(60);
    expect(row.workspaceId).toBeNull();
  });

  it("configures enable, workspace binding and sweep interval idempotently", async () => {
    await repo.configure(SERVER, { enabled: true, workspaceId: "ws_1", sweepIntervalSeconds: 60 });
    const updated = await repo.configure(SERVER, { sweepIntervalSeconds: 120 });
    expect(updated.enabled).toBe(true);
    expect(updated.workspaceId).toBe("ws_1");
    expect(updated.sweepIntervalSeconds).toBe(120);
    expect((await repo.listEnabledServerIds()).map((r) => r.serverId)).toEqual([SERVER]);
  });

  it("records scan outcomes without inventing errors", async () => {
    await repo.configure(SERVER, { enabled: true });
    await repo.recordScan(SERVER, { ok: true });
    const ok = await repo.getSettings(SERVER);
    expect(ok?.lastScanError).toBeNull();
    expect(ok?.lastScanAt).toBeInstanceOf(Date);
    await repo.recordScan(SERVER, { ok: false, error: "daemon unreachable" });
    const failed = await repo.getSettings(SERVER);
    expect(failed?.lastScanError).toBe("daemon unreachable");
  });

  it("clears a workspace binding without touching other settings", async () => {
    await repo.configure(SERVER, { enabled: true, workspaceId: "ws_1", sweepIntervalSeconds: 90 });
    await repo.unbindWorkspace(SERVER);
    const row = await repo.getSettings(SERVER);
    expect(row?.workspaceId).toBeNull();
    expect(row?.enabled).toBe(true);
    expect(row?.sweepIntervalSeconds).toBe(90);
  });
});

describe("binding observations", () => {
  it("versions a probed fallback and rejects a stale resolver completion", async () => {
    const { binding: original } = await repo.observe(SERVER, observation({ upstreamStrategy: "network-ip" }));
    const fallback = { upstreamStrategy: "published-port" as const, hostPort: 18080, hostIp: "127.0.0.1", ipAddress: null };
    const resolved = await repo.resolveUpstream(original, fallback);
    expect(resolved?.upstreamStrategy).toBe("published-port");
    expect(resolved?.desiredGeneration).toBe(2);
    expect(await repo.resolveUpstream(original, fallback)).toBeUndefined();
    const repeated = await repo.resolveUpstream(resolved!, fallback);
    expect(repeated?.desiredGeneration).toBe(2);
    await repo.block(SERVER, original.serviceKey, "conflicting owner");
    expect(await repo.resolveUpstream(repeated!, fallback)).toBeUndefined();
  });

  it("creates a pending binding on first sight with generation 1", async () => {
    const { binding: row, desiredChanged } = await repo.observe(SERVER, observation());
    expect(desiredChanged).toBe(true);
    expect(row.applyState).toBe("pending");
    expect(row.desiredGeneration).toBe(1);
    expect(row.appliedGeneration).toBe(0);
    expect(row.observationStatus).toBe("observed");
    expect(row.ipAddress).toBe("172.20.0.5");
    expect(row.composeProject).toBe("shop");
  });

  it("is idempotent: an unchanged rescan changes nothing", async () => {
    await repo.observe(SERVER, observation());
    const { desiredChanged, requeued } = await repo.observe(SERVER, observation({ ipAddress: "172.20.0.5" }));
    expect(desiredChanged).toBe(false);
    expect(requeued).toBe(false);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.desiredGeneration).toBe(1);
  });

  it("requeues on container replacement even without a config change", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    const { requeued } = await repo.observe(
      SERVER,
      observation({ containerId: "ctr_2", containerName: "my-app-2", ipAddress: "172.20.0.9" }),
    );
    // The route's upstream CHANGED — an applied binding must re-apply or it
    // keeps serving the old IP Docker may hand to another workload.
    expect(requeued).toBe(true);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerId).toBe("ctr_2");
    expect(row?.ipAddress).toBe("172.20.0.9");
    expect(row?.applyState).toBe("pending");
    expect(row?.desiredGeneration).toBe(2); // applied generation 1 < desired 2 → due
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("requeues on stop and on start", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);

    const stopped = await repo.observe(SERVER, observation({ running: false }));
    expect(stopped.requeued).toBe(true);
    let row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerRunning).toBe(false);
    expect(row?.applyState).toBe("pending");

    await repo.markApplied(SERVER, "id:my-app", 2);
    const started = await repo.observe(SERVER, observation({ running: true }));
    expect(started.requeued).toBe(true);
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerRunning).toBe(true);
    expect(row?.applyState).toBe("pending");
  });

  it("leaves an applied binding untouched when nothing about the target changed", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    const { requeued, desiredChanged } = await repo.observe(SERVER, observation({ ipAddress: "172.20.0.5" }));
    expect(requeued).toBe(false);
    expect(desiredChanged).toBe(false);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("applied");
    expect(row?.desiredGeneration).toBe(1);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);
  });

  it("requeues when the resolved upstream target changes (published host port)", async () => {
    await repo.observe(
      SERVER,
      observation({ upstreamStrategy: "published-port", hostPort: 18080, hostIp: "127.0.0.1", networkName: null }),
    );
    await repo.markApplied(SERVER, "id:my-app", 1);

    // The operator re-published the port; same config hash, different target.
    const { requeued } = await repo.observe(
      SERVER,
      observation({ running: true, upstreamStrategy: "published-port", hostPort: 18081, hostIp: "0.0.0.0", networkName: null }),
    );
    expect(requeued).toBe(true);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("pending");
    expect(row?.hostPort).toBe(18081);
    expect(row?.desiredGeneration).toBe(2);
  });

  it("is generation-conditional: a stale failure cannot overwrite a newer pending state", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    // Scanner observes new config: generation 2, pending again.
    await repo.observe(
      SERVER,
      observation({
        containerId: "ctr_2",
        ipAddress: "172.20.0.9",
        configHash: discoveryConfigHash({ hostname: "app.example.com", port: 3000, network: "frontend" }) + "x",
      }),
    );
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.desiredGeneration).toBe(2);
    expect(row?.applyState).toBe("pending");

    // The OLD pass (generation 1) fails AFTER the newer observation landed:
    // its failure is obsolete and must not impose backoff on generation 2.
    const stale = await repo.markApplyError(
      SERVER,
      "id:my-app",
      "old pass edge write failed",
      new Date(Date.now() + 60_000),
      1,
    );
    expect(stale).toBeUndefined();
    const untouched = await repo.getBinding(SERVER, "id:my-app");
    expect(untouched?.applyState).toBe("pending");
    expect(untouched?.applyError).toBeNull();
    expect(untouched?.applyAttempts).toBe(0);
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);

    // A failure AT the current generation records normally.
    const current = await repo.markApplyError(
      SERVER,
      "id:my-app",
      "current pass failed",
      new Date(Date.now() + 60_000),
      2,
    );
    expect(current).toBeDefined();
    const failed = await repo.getBinding(SERVER, "id:my-app");
    expect(failed?.applyState).toBe("error");
    expect(failed?.applyError).toBe("current pass failed");
  });

  it("stores upstream strategy and nulls network for published-only services", async () => {
    const row = (
      await repo.observe(
        SERVER,
        observation({ upstreamStrategy: "published-port", hostPort: 18080, hostIp: "127.0.0.1", networkName: null, networkId: null, ipAddress: null }),
      )
    ).binding;
    expect(row.upstreamStrategy).toBe("published-port");
    expect(row.hostPort).toBe(18080);
    expect(row.hostIp).toBe("127.0.0.1");
    expect(row.networkName).toBeNull();
  });

  it("marks pending and resets retries when the operator changes config", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("applied");

    const { desiredChanged } = await repo.observe(
      SERVER,
      observation({
        hostname: "other.example.com",
        configHash: discoveryConfigHash({ hostname: "other.example.com", port: 3000, network: "frontend" }),
      }),
    );
    expect(desiredChanged).toBe(true);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.hostname).toBe("other.example.com");
    expect(row?.desiredGeneration).toBe(2);
    expect(row?.applyState).toBe("pending");
    expect(row?.applyAttempts).toBe(0);
    expect(row?.applyError).toBeNull();
  });

  it("never invents a second binding for one identity", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ containerId: "ctr_2" }));
    const rows = await repo.listByServer(SERVER);
    expect(rows).toHaveLength(1);
  });

  it("keeps everything on observation error and only confirmed removals go missing", async () => {
    await repo.observe(SERVER, observation());
    await repo.markObservationError(SERVER, "id:my-app");
    let row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.observationStatus).toBe("error");
    expect(row?.containerId).toBe("ctr_1");
    expect(row?.configHash).toBeTruthy();

    await repo.markMissing(SERVER, "id:my-app");
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.observationStatus).toBe("missing");
    expect(row?.containerId).toBeNull();
    expect(row?.hostname).toBe("app.example.com"); // desired state retained
    expect(row?.configHash).toBeTruthy();
  });

  it("queues route withdrawal when an applied binding goes missing (crash-safe)", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);

    await repo.markMissing(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    // The reconciler must withdraw the live route even if the process dies
    // right here — applied + not-due would be exactly that crash window.
    expect(row?.applyState).toBe("pending");
    expect(row?.desiredGeneration).toBe(2);
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("suppress schedules retirement for applied bindings and unsuppress reverts a pending one", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect(await repo.dueForWithdrawal(SERVER)).toHaveLength(0);

    // Opt-out with application history: route retirement is scheduled.
    const suppressed = await repo.suppress(SERVER, "id:my-app");
    expect(suppressed?.suppressed).toBe(true);
    expect(suppressed?.withdrawalPending).toBe(true);
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);

    // Change of heart BEFORE retirement ran: the withdrawal is withdrawn too,
    // or the reconciler would remove a route the operator decided to keep.
    const reverted = await repo.unsuppress(SERVER, "id:my-app");
    expect(reverted?.suppressed).toBe(false);
    expect(reverted?.withdrawalPending).toBe(false);
    expect(await repo.dueForWithdrawal(SERVER)).toHaveLength(0);

    // Opt-out WITHOUT history: no route exists, nothing to retire.
    await repo.observe(SERVER, observation({ serviceKey: "id:fresh", hostname: "fresh.example.com" }));
    const fresh = await repo.suppress(SERVER, "id:fresh");
    expect(fresh?.withdrawalPending).toBe(false);
    expect(await repo.dueForWithdrawal(SERVER)).toHaveLength(0);
  });

  it("disable schedules retirement for every applied binding and the server stays sweepable", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ serviceKey: "id:second", hostname: "second.example.com", containerId: "ctr_2", ipAddress: "172.20.0.6" }));
    await repo.markApplied(SERVER, "id:my-app", 1);
    await repo.markApplied(SERVER, "id:second", 1);
    await repo.configure(SERVER, { enabled: true });

    // Enabled servers are sweepable.
    expect((await repo.listSweepableServerIds()).map((r) => r.serverId)).toContain(SERVER);

    const scheduled = await repo.scheduleWithdrawalForAll(SERVER);
    expect(scheduled.map((r) => r.serviceKey).sort()).toEqual(["id:my-app", "id:second"]);

    // A disabled server owing withdrawals is STILL sweepable (reconcile must
    // run to retire the routes) — while a merely disabled server is not.
    await repo.configure(SERVER, { enabled: false });
    expect((await repo.listSweepableServerIds()).map((r) => r.serverId)).toContain(SERVER);
  });

  it("retention-relevant state survives the real observe→apply→stop→markMissing flow", async () => {
    // The full lifecycle the reconciler decides on, through the REAL repo:
    // discover (observe) → apply (markApplied records durable history) →
    // container stops (observe running:false requeues as pending) → container
    // removed (markMissing flags retirement). Every state the retention logic
    // consumes must survive: appliedGeneration (the history record), hostname,
    // port — while the live upstream description is cleared.
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect((await repo.getBinding(SERVER, "id:my-app"))?.appliedGeneration).toBe(1);

    // Container stops but is still present: the scanner observes running:false.
    await repo.observe(SERVER, observation({ running: false, ipAddress: null }));
    let row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.containerRunning).toBe(false);
    expect(row?.applyState).toBe("pending"); // requeued for the reconciler
    expect(row?.appliedGeneration).toBe(1);  // history intact — retention evidence
    expect(row?.hostname).toBe("app.example.com");

    // Container removed from the host entirely.
    await repo.markMissing(SERVER, "id:my-app");
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.observationStatus).toBe("missing");
    expect(row?.appliedGeneration).toBe(1);
    expect(row?.withdrawalPending).toBe(true); // retirement flagged, hostname kept
    expect(row?.hostname).toBe("app.example.com");
    expect(row?.port).toBe(3000);
    // Both queues see it; each consumer (withdrawal loop, apply loop) retains
    // on exactly this state via shouldRetainUnavailableVhost.
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("requeueForApply bumps the generation of a converged binding and invalidates stale applies", async () => {
    // The repair sweep's primitive: an applied binding whose route file needed
    // restoring (or whose serving target went stale) must be handed to guarded
    // reconciliation — and the bump must invalidate any in-flight apply.
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0); // converged

    const requeued = await repo.requeueForApply(SERVER, "id:my-app", 1);
    expect(requeued?.applyState).toBe("pending");
    expect(requeued?.desiredGeneration).toBe(2); // bumped past the applied generation
    // The backoff bookkeeping resets: the pass runs now, not on stale backoff.
    expect(requeued?.applyAttempts).toBe(0);
    expect(requeued?.nextApplyAt).toBeNull();
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);

    // An apply that was in flight against generation 1 can no longer "succeed":
    // markApplied's stale-generation guard drops it, and the history is safe.
    expect(await repo.markApplied(SERVER, "id:my-app", 1)).toBeUndefined();
    // The real reconciliation pass applies the NEW generation.
    expect(await repo.markApplied(SERVER, "id:my-app", 2)).toMatchObject({ appliedGeneration: 2 });
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);
  });

  it("requeueForApply is a no-op for unknown bindings and coexists with scanner bumps", async () => {
    expect(await repo.requeueForApply(SERVER, "id:ghost", 1)).toBeUndefined();

    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1); // requeue only fires on converged rows
    const first = await repo.requeueForApply(SERVER, "id:my-app", 1);
    const gen1 = first?.desiredGeneration ?? 0;
    expect(gen1).toBeGreaterThan(1);
    // A second sweep finds the binding already queued (pending) and must not
    // double-bump — the scheduled pass owns it.
    expect(await repo.requeueForApply(SERVER, "id:my-app", gen1)).toBeUndefined();
    // Once the guarded pass converges again, the next repair-era requeue bumps
    // monotonically from the applied generation.
    await repo.markApplied(SERVER, "id:my-app", gen1);
    const second = await repo.requeueForApply(SERVER, "id:my-app", gen1);
    expect((second?.desiredGeneration ?? 0)).toBeGreaterThan(gen1);
  });

  it("requeueForApply refuses to clear a concurrent block, suppression, or newer snapshot", async () => {
    // P1: repair reads its snapshot, THEN the scanner blocks a hostname
    // conflict (or an operator suppresses). The requeue must require the row to
    // still match the snapshot — expected generation, applied state, and
    // unsuppressed — or it would wipe conflict protection (blocked → pending).
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);

    // Stale snapshot: the scanner bumped the generation meanwhile.
    await repo.observe(SERVER, observation({ ipAddress: "172.20.0.9" })); // runtime change → requeue + bump
    const current = await repo.getBinding(SERVER, "id:my-app");
    expect(current?.applyState).toBe("pending");
    expect(await repo.requeueForApply(SERVER, "id:my-app", 1)).toBeUndefined(); // old generation
    let row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("pending"); // untouched by the stale requeue
    expect(row?.desiredGeneration).toBe(current?.desiredGeneration);

    // Converged again, then BLOCKED: the requeue must not flip blocked → pending.
    await repo.markApplied(SERVER, "id:my-app", current!.desiredGeneration);
    const converged = await repo.getBinding(SERVER, "id:my-app");
    await repo.block(SERVER, "id:my-app", "hostname conflict resolved into a block");
    expect(await repo.requeueForApply(SERVER, "id:my-app", converged!.desiredGeneration)).toBeUndefined();
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("blocked"); // conflict protection intact

    // Blocked cleared, converged, then SUPPRESSED: still no override.
    await repo.unblock(SERVER, "id:my-app");
    await repo.markApplied(SERVER, "id:my-app", (await repo.getBinding(SERVER, "id:my-app"))!.desiredGeneration);
    await repo.suppress(SERVER, "id:my-app");
    const beforeSuppress = await repo.getBinding(SERVER, "id:my-app");
    expect(await repo.requeueForApply(SERVER, "id:my-app", beforeSuppress!.desiredGeneration)).toBeUndefined();
    row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.suppressed).toBe(true);
    expect(row?.applyState).not.toBe("pending");
  });

  it("does not re-bump an already-missing binding on repeated removals", async () => {
    await repo.observe(SERVER, observation());
    await repo.markMissing(SERVER, "id:my-app");
    const first = await repo.getBinding(SERVER, "id:my-app");
    const generation = first?.desiredGeneration;
    // The scanner re-runs every sweep until reconciliation catches up.
    await repo.markMissing(SERVER, "id:my-app");
    await repo.markMissing(SERVER, "id:my-app");
    const stable = await repo.getBinding(SERVER, "id:my-app");
    expect(stable?.desiredGeneration).toBe(generation);
    expect(stable?.observationStatus).toBe("missing");
  });

  it("schedules withdrawal for a BLOCKED binding with a previously applied route (P1: applied → blocked → missing)", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1); // route is live
    await repo.block(SERVER, "id:my-app", "hostname owned elsewhere");
    expect(await repo.dueForApply(SERVER)).toHaveLength(0); // forward applies blocked

    // Container removed while blocked: the LIVE route must still be retired.
    await repo.markMissing(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("blocked"); // block survives — no forward apply
    expect(row?.withdrawalPending).toBe(true); // retirement scheduled
    expect(row?.observationStatus).toBe("missing");

    // Retirement is consumable independently of the apply queue...
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    await repo.markWithdrawn(SERVER, "id:my-app");
    expect(await repo.dueForWithdrawal(SERVER)).toHaveLength(0);
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("blocked");
  });

  it("schedules withdrawal for a SUPPRESSED binding with a previously applied route", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    await repo.suppress(SERVER, "id:my-app");
    await repo.markMissing(SERVER, "id:my-app");
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });

  it("does not schedule withdrawal for bindings that never had a route", async () => {
    await repo.observe(SERVER, observation()); // pending, appliedGeneration 0
    await repo.markMissing(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.withdrawalPending).toBe(false); // nothing to retire
    expect(row?.applyState).toBe("pending"); // normal requeue still applies
  });

  it("markInvalid invalidates the old observation, keeps metadata, and queues withdrawal (P1: invalid replacement)", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);

    await repo.markInvalid(SERVER, "id:my-app");
    const row = await repo.getBinding(SERVER, "id:my-app");
    // Old observation invalidated — no stale IP/running flag survives.
    expect(row?.observationStatus).toBe("invalid");
    expect(row?.containerId).toBeNull();
    expect(row?.containerName).toBeNull();
    expect(row?.ipAddress).toBeNull();
    expect(row?.containerRunning).toBe(false);
    // Binding/certificate metadata retained.
    expect(row?.hostname).toBe("app.example.com");
    expect(row?.port).toBe(3000);
    expect(row?.configHash).toBeTruthy();
    // Upstream withdrawal queued.
    expect(row?.applyState).toBe("pending");
    expect(row?.desiredGeneration).toBe(2);
    expect((await repo.dueForApply(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);

    // Idempotent: re-invalidating does not re-bump.
    await repo.markInvalid(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.desiredGeneration).toBe(2);
  });

  it("markInvalid schedules withdrawal for a blocked binding with a prior route", async () => {
    await repo.observe(SERVER, observation());
    await repo.markApplied(SERVER, "id:my-app", 1);
    await repo.block(SERVER, "id:my-app", "duplicate hostname");
    await repo.markInvalid(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("blocked");
    expect((await repo.dueForWithdrawal(SERVER)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
  });
});

describe("apply scheduling", () => {
  it("blocks and unblocks a conflicting binding, and other-owner hostnames are found", async () => {
    await repo.observe(SERVER, observation());

    // A project-owned domain already serves the hostname → conflict found.
    await db.insert(schema.domain).values({
      id: "dom_project_owner",
      projectId: "proj_other",
      hostname: "app.example.com",
    });
    const conflict = await repo.findConflictingDomainOwner(SERVER, "app.example.com");
    expect(conflict?.id).toBe("dom_project_owner");

    await repo.block(SERVER, "id:my-app", "hostname owned elsewhere");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("blocked");
    // Blocked rows never become due, no matter the backoff.
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);

    // markApplyError must not overwrite a blocked row.
    await repo.markApplyError(SERVER, "id:my-app", "should be ignored", new Date());
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyError).toBe("hostname owned elsewhere");

    // Resolution clears the block back to the pending queue.
    await repo.unblock(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("pending");
  });

  it("keeps a blocked binding blocked through config changes, until unblocked", async () => {
    await repo.observe(SERVER, observation());
    await repo.block(SERVER, "id:my-app", "duplicate identity");
    // Operator recreates the container with new config while still conflicted.
    await repo.observe(
      SERVER,
      observation({
        containerId: "ctr_2",
        hostname: "moved.example.com",
        configHash: discoveryConfigHash({ hostname: "moved.example.com", port: 3000, network: "frontend" }),
      }),
    );
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("blocked"); // stays blocked across observation updates
    expect(row?.hostname).toBe("moved.example.com"); // but desired config is current
    await repo.unblock(SERVER, "id:my-app");
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("pending");
  });

  it("picks up due bindings and excludes suppressed ones", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ serviceKey: "id:other", hostname: "b.example.com" }));
    await repo.suppress(SERVER, "id:other");
    const due = await repo.dueForApply(SERVER);
    expect(due.map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    await repo.unsuppress(SERVER, "id:other");
    expect((await repo.dueForApply(SERVER)).length).toBe(2);
  });

  it("honors persisted backoff", async () => {
    await repo.observe(SERVER, observation());
    const retryAt = new Date(Date.now() + 60_000);
    await repo.markApplyError(SERVER, "id:my-app", "edge unreachable", retryAt);
    expect((await repo.dueForApply(SERVER)).length).toBe(0);
    const afterBackoff = new Date(retryAt.getTime() + 1000);
    expect((await repo.dueForApply(SERVER, afterBackoff)).map((r) => r.serviceKey)).toEqual(["id:my-app"]);
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.applyState).toBe("error");
    expect(row?.applyAttempts).toBe(1);
    expect(row?.applyError).toBe("edge unreachable");
  });

  it("rejects a stale applied generation but accepts the current one", async () => {
    await repo.observe(SERVER, observation());
    await repo.observe(SERVER, observation({ port: 3001, configHash: "changed" }));
    const row = await repo.getBinding(SERVER, "id:my-app");
    expect(row?.desiredGeneration).toBe(2);

    const stale = await repo.markApplied(SERVER, "id:my-app", 1);
    expect(stale).toBeUndefined(); // desired moved on; this apply is obsolete
    expect((await repo.getBinding(SERVER, "id:my-app"))?.applyState).toBe("pending");

    await repo.markApplied(SERVER, "id:my-app", 2);
    const applied = await repo.getBinding(SERVER, "id:my-app");
    expect(applied?.applyState).toBe("applied");
    expect(applied?.appliedGeneration).toBe(2);
    expect(await repo.dueForApply(SERVER)).toHaveLength(0);
  });
});

describe("forget and domain retention", () => {
  it("deletes the binding but retains the server-owned domain row", async () => {
    await db.insert(schema.domain).values({
      id: "dom_srv",
      ownerType: "server",
      serverId: SERVER,
      hostname: "app.example.com",
      sslStatus: "active",
      verified: true,
    });
    await repo.observe(SERVER, observation());
    await repo.forget(SERVER, "id:my-app");
    expect(await repo.getBinding(SERVER, "id:my-app")).toBeUndefined();
    const retained = await repo.findDomainForBinding(SERVER, "app.example.com");
    expect(retained?.id).toBe("dom_srv");
    expect(retained?.sslStatus).toBe("active");
    expect(retained?.projectId).toBeNull();
  });

  it("joins the binding's domain server-scoped, never another owner's", async () => {
    // Another (project) domain on the same hostname globally is impossible —
    // hostname is unique — so the join can only find the server-scoped row.
    await db.insert(schema.domain).values({
      id: "dom_srv2",
      ownerType: "server",
      serverId: SERVER,
      hostname: "x.example.com",
    });
    expect((await repo.findDomainForBinding(SERVER, "X.example.com"))?.id).toBe("dom_srv2");
    expect(await repo.findDomainForBinding(SERVER, "missing.example.com")).toBeUndefined();
  });

  it("cascades: server-scoped domain rows die with the server", async () => {
    const cascadeServer = "srv_cascade_probe";
    await db.insert(schema.servers).values({ id: cascadeServer, name: "cascade", sshHost: "127.0.0.1" });
    await db.insert(schema.domain).values({
      id: "dom_cascade",
      ownerType: "server",
      serverId: cascadeServer,
      hostname: "cascade.example.com",
    });
    // Replica mode disables FK triggers (see beforeAll); enforce them only
    // around the delete so the cascade itself is what's under test.
    await client.exec("SET session_replication_role = DEFAULT;");
    await db.delete(schema.servers).where(eq(schema.servers.id, cascadeServer));
    await client.exec("SET session_replication_role = replica;");
    expect(await repo.findDomainForBinding(cascadeServer, "cascade.example.com")).toBeUndefined();
  });
});

/** Seed a server-scoped domain + its binding, and the matching discovery settings. */
async function seedServerDomain(overrides: {
  enabled?: boolean;
  suppressed?: boolean;
  observationStatus?: "observed" | "missing" | "error";
  containerRunning?: boolean;
  organizationId?: string | null;
} = {}) {
  const {
    enabled = true,
    suppressed = false,
    observationStatus = "observed",
    containerRunning = true,
    organizationId,
  } = overrides;
  if (organizationId !== undefined) {
    await db.update(schema.servers).set({ organizationId }).where(eq(schema.servers.id, SERVER));
  }
  await repo.configure(SERVER, { enabled });
  await repo.observe(SERVER, observation({ running: containerRunning }));
  if (suppressed) await repo.suppress(SERVER, "id:my-app");
  if (observationStatus !== "observed") {
    await db
      .update(schema.discoveryBinding)
      .set({ observationStatus })
      .where(eq(schema.discoveryBinding.serverId, SERVER));
  }
  await db.insert(schema.domain).values({
    id: "dom_server_scope",
    ownerType: "server",
    serverId: SERVER,
    hostname: "app.example.com",
    domainType: "custom",
    verified: false,
    status: "pending",
  });
}

describe("server-scoped issuance eligibility (liveVerificationOwner extension)", () => {
  beforeEach(async () => {
    await db.delete(schema.discoveryBinding);
    await db.delete(schema.discoverySettings);
    await db.delete(schema.domain);
    await db.delete(schema.project);
  });

  it("queues a server domain for issuance with NO project or deployment, and never through TXT verification", async () => {
    await seedServerDomain();
    // TXT verification does not apply to this owner type — verification IS the
    // first successful ACME issuance, driven by the reconciler after apply.
    const pending = await domainRepo.findPendingVerification(new Date(Date.now() + 1000));
    expect(pending.map((r) => r.hostname)).not.toContain("app.example.com");
    // A DNS-verified server domain with no certificate is issuance-eligible
    // through the pending-SSL queue (findPendingSsl).
    await db
      .update(schema.domain)
      .set({ verified: true, verifiedAt: new Date(), sslStatus: "none" })
      .where(eq(schema.domain.id, "dom_server_scope"));
    const pendingSsl = await domainRepo.findPendingSsl();
    expect(pendingSsl.map((r) => r.hostname)).toContain("app.example.com");
  });

  it("excludes server domains when discovery is disabled on the server", async () => {
    await seedServerDomain({ enabled: false });
    const pending = await domainRepo.findPendingVerification(new Date(Date.now() + 1000));
    expect(pending.map((r) => r.hostname)).not.toContain("app.example.com");
  });

  it("excludes suppressed bindings, stopped containers, and unobserved containers", async () => {
    await seedServerDomain({ suppressed: true });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");

    // Second scenario needs its own domain row (hostname unique in `domain`).
    await db.delete(schema.domain);
    // Observed but STOPPED: ineligible even though the row is alive and fresh.
    await seedServerDomain({ containerRunning: false });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");

    await db.delete(schema.domain);
    await seedServerDomain({ observationStatus: "missing" });
    expect(
      (await domainRepo.findPendingVerification(new Date(Date.now() + 1000))).map((r) => r.hostname),
    ).not.toContain("app.example.com");
  });

  it("retries a FAILED first issuance via findPendingServerIssuance (no stranding)", async () => {
    await seedServerDomain();
    // First issuance failed: row unverified, sslStatus error, verify attempts
    // recorded. It sits in none of the project queues (by design) — this queue
    // is what keeps it retrying.
    await db
      .update(schema.domain)
      .set({ sslStatus: "error", verifyAttempts: 1, lastVerifyError: "DNS not pointed yet" })
      .where(eq(schema.domain.id, "dom_server_scope"));
    const retried = await domainRepo.findPendingServerIssuance();
    expect(retried.map((r) => r.hostname)).toContain("app.example.com");

    // A stopped container pauses the retry (eligibility predicate).
    await db.update(schema.discoveryBinding).set({ containerRunning: false }).where(eq(schema.discoveryBinding.serverId, SERVER));
    expect((await domainRepo.findPendingServerIssuance()).map((r) => r.hostname)).not.toContain("app.example.com");
    await db.update(schema.discoveryBinding).set({ containerRunning: true }).where(eq(schema.discoveryBinding.serverId, SERVER));

    // Disabled discovery pauses it too.
    await repo.configure(SERVER, { enabled: false });
    expect((await domainRepo.findPendingServerIssuance()).map((r) => r.hostname)).not.toContain("app.example.com");
    await repo.configure(SERVER, { enabled: true });

    // Suppressed bindings are out.
    await repo.suppress(SERVER, "id:my-app");
    expect((await domainRepo.findPendingServerIssuance()).map((r) => r.hostname)).not.toContain("app.example.com");
  });

  it("recordSslDeferred advances scheduling state without recording a failure", async () => {
    await seedServerDomain();
    // Simulate an issued certificate that now defers on a stopped backend:
    // real material state must be retained, only scheduling state advances.
    await db
      .update(schema.domain)
      .set({
        verified: true,
        status: "active",
        sslStatus: "active",
        sslExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        lastVerifyError: "real prior error kept",
        verifyAttempts: 3,
      })
      .where(eq(schema.domain.id, "dom_server_scope"));

    await domainRepo.recordSslDeferred("dom_server_scope", "backend stopped");
    const row = await repo.findDomainForBinding(SERVER, "app.example.com");
    expect(row?.verifyAttempts).toBe(4); // backoff state advanced
    expect(row?.lastCheckedAt).toBeTruthy(); // sort key rotated
    // Deliberate stop ≠ failure: cert state and the real error message kept.
    expect(row?.sslStatus).toBe("active");
    expect(row?.sslExpiresAt).toBeTruthy();
    expect(row?.status).toBe("active");
    expect(row?.lastVerifyError).toBe("real prior error kept");

    // With no prior error, the defer reason becomes visible for the UI.
    await db.update(schema.domain).set({ lastVerifyError: null }).where(eq(schema.domain.id, "dom_server_scope"));
    await domainRepo.recordSslDeferred("dom_server_scope", "deferred: backend stopped");
    expect((await repo.findDomainForBinding(SERVER, "app.example.com"))?.lastVerifyError).toBe("deferred: backend stopped");
  });

  it("findExpiringSsl orders by least-recently-checked with a stable id tie-breaker", async () => {
    // The rotation guarantee behind deferred defers: lastCheckedAt (creation
    // fallback) ascending, id as the tie-breaker. Without the ORDER BY the
    // planner's arbitrary order gets truncated into the renewal batch.
    const base = {
      sslStatus: "active",
      sslExpiresAt: new Date(Date.now() + 86_400_000),
      domainType: "custom",
      verified: true,
    };
    await db.insert(schema.domain).values([
      { id: "d_new", projectId: null, hostname: "new.test", lastCheckedAt: new Date(Date.now() - 86_400_000), ...base },
      { id: "d_old", projectId: null, hostname: "old.test", lastCheckedAt: new Date(Date.now() - 10 * 86_400_000), ...base },
      { id: "d_mid", projectId: null, hostname: "mid.test", lastCheckedAt: new Date(Date.now() - 5 * 86_400_000), ...base },
      // Never checked: falls back to creation time — oldest of all.
      { id: "d_never", projectId: null, hostname: "never.test", createdAt: new Date(Date.now() - 30 * 86_400_000), ...base },
      { id: "d_tie_b", projectId: null, hostname: "tie-b.test", lastCheckedAt: new Date(Date.now() - 7 * 86_400_000), ...base },
      { id: "d_tie_a", projectId: null, hostname: "tie-a.test", lastCheckedAt: new Date(Date.now() - 7 * 86_400_000), ...base },
    ]);
    const order = (await domainRepo.findExpiringSsl(new Date(Date.now() + 7 * 86_400_000))).map((r) => r.id);
    expect(order).toEqual(["d_never", "d_old", "d_tie_a", "d_tie_b", "d_mid", "d_new"]);

    // Deferring d_old rotates it BEHIND d_mid — the queue advances.
    await domainRepo.recordSslDeferred("d_old", "backend stopped");
    const rotated = (await domainRepo.findExpiringSsl(new Date(Date.now() + 7 * 86_400_000))).map((r) => r.id);
    expect(rotated.indexOf("d_old")).toBeGreaterThan(rotated.indexOf("d_mid"));
  });

  it("scopes server domains by organization through the server row", async () => {
    await seedServerDomain({ organizationId: "org_1" });
    // Org scoping matters on the issuance queue (findPendingSsl, verified rows);
    // the TXT verification queue never contains server domains at all.
    await db
      .update(schema.domain)
      .set({ verified: true, verifiedAt: new Date(), sslStatus: "none" })
      .where(eq(schema.domain.id, "dom_server_scope"));
    const now = new Date();
    expect((await domainRepo.findPendingSsl(50, "org_1")).map((r) => r.hostname)).toContain("app.example.com");
    expect((await domainRepo.findPendingSsl()).map((r) => r.hostname)).toContain("app.example.com");
    expect((await domainRepo.findPendingSsl(50, "org_other")).map((r) => r.hostname)).not.toContain("app.example.com");
  });

  it("keeps project-domain eligibility rules exactly as they were", async () => {
    // Project seeding is FK-free here (replica mode); NOT NULL columns still
    // apply — name/slug/groupId are required, the org id is a bare string.
    await db.insert(schema.project).values([
      { id: "proj_live", organizationId: "org_1", groupId: "grp_live", name: "Live", slug: "live", activeDeploymentId: "dep_1" },
      { id: "proj_idle", organizationId: "org_1", groupId: "grp_idle", name: "Idle", slug: "idle" },
    ]);
    await db.insert(schema.domain).values([
      { id: "dom_live", projectId: "proj_live", hostname: "live.example.com", domainType: "custom", verified: false, status: "pending" },
      { id: "dom_idle", projectId: "proj_idle", hostname: "idle.example.com", domainType: "custom", verified: false, status: "pending" },
    ]);
    const hostnames = (
      await domainRepo.findPendingVerification(new Date(Date.now() + 1000))
    ).map((r) => r.hostname);
    expect(hostnames).toContain("live.example.com");
    expect(hostnames).not.toContain("idle.example.com");
  });
});
