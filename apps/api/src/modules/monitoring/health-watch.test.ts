import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContainerStabilitySample } from "@repo/adapters";

/**
 * The health watch's contract is a NOISE contract, and it is not expressible in
 * the classifier's unit tests.
 *
 * `classifySteadyState` answers "is this sample broken?" — a question with an
 * obvious answer that no operator ever complained about. What gets an alerting
 * channel muted is the second question: "how many messages does one broken thing
 * produce?". That answer lives in the sweep — the confirmation counter, the
 * incident state machine, and the four suppression gates — so it is asserted
 * here, in message counts, over many ticks.
 *
 * Every assertion below is a count, deliberately: `toHaveLength(1)` after ten
 * ticks of a crash loop is the whole feature. An assertion that an alert merely
 * *happened* would pass just as well for the version that pages every minute
 * forever.
 *
 * `MEMORY` in health-watch.ts is module-level and intentionally process-lifetime,
 * so tests never reset it — each one mints fresh project/container ids via
 * `seed*()`. That's also a truer test: it runs against a Map that already has
 * other projects' history in it.
 */

/** The service_incident columns the sweep and the incident service touch. */
interface Row {
  id: string;
  organizationId: string;
  projectId: string | null;
  serviceId: string | null;
  serviceKey: string;
  serviceName: string;
  serverId: string | null;
  containerId: string | null;
  kind: string;
  status: string;
  reason: string | null;
  exitCode: number | null;
  restartCount: number;
  oomKilled: boolean;
  confirmations: number;
  notifyCount: number;
  notifiedAt: Date | null;
  logExcerpt: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  lastSeenAt: Date;
}

const h = vi.hoisted(() => {
  return {
    projects: [] as Array<Record<string, unknown>>,
    deployments: [] as Array<Record<string, unknown>>,
    services: new Map<string, Array<Record<string, unknown>>>(),
    serviceDeployments: new Map<string, Array<Record<string, unknown>>>(),
    containers: new Map<string, Record<string, unknown>>(),
    /**
     * Which box each container lives on (`null` = the control plane's own socket).
     *
     * A fixture where every daemon answers with every container cannot express the one
     * premise the whole grouping rests on — that ONE `docker ps -a` describes every
     * project in a group — so a mis-keyed group would read as perfectly healthy here
     * while paging in production.
     */
    containerBox: new Map<string, string | null>(),
    /** Registered server rows, by id. Seeds add theirs; a test can delete one. */
    servers: new Map<string, { id: string; name: string; organizationId: string }>(),
    samples: new Map<string, Partial<ContainerStabilitySample>>(),
    /** The self-server row, when the control plane's own box is registered as one. */
    localServer: null as { id: string; name: string } | null,
    /** Set to make `listAllContainers` fail — an unreachable daemon. */
    listThrows: null as string | null,
    /** Set to make `listAllContainers` never settle — a half-open bridge. */
    listHangs: false,
    /** Set to drop `stabilityProbe`, leaving the sweep with the container list only. */
    noProbe: false,
    /** Set to make every inspect hang — a daemon that answered `ps` and then wedged. */
    sampleHangs: false,
    /**
     * The same wedge, but releasable: a daemon that accepts an inspect and answers only
     * when the test says so, which is the only way to watch what the workers abandoned
     * by the deadline do when they eventually wake up.
     */
    sampleGate: null as Promise<void> | null,
    /** Inspects STARTED, so a test can show an abandoned group stops issuing them. */
    inspects: 0,
    incidents: [] as Row[],
    /**
     * A one-shot hook fired INSIDE `escalate`, before its compare-and-set — the only
     * slot where a second control-plane process on the same database can land, between
     * this one's read of the incident and its write. Cleared as it fires.
     */
    raceOnEscalate: null as null | (() => void),
    seq: 0,
    emit: vi.fn(),
    /** Every runtime teardown, so the deadline path can be shown to release one. */
    disposed: vi.fn(),
    renew: vi.fn(async (_groupKeys: readonly string[]) => {}),
    logLines: ["panic: dial tcp 127.0.0.1:5432: connect: connection refused"],
  };
});

vi.mock("@repo/db", () => {
  // Mirrors packages/db/src/repos/service-incident.repo.ts. Kept inline rather
  // than imported because the @repo/db entrypoint pulls the real driver.
  const SEVERITY: Record<string, number> = {
    unhealthy: 1,
    crash_loop: 2,
    down: 3,
    server_unreachable: 3,
  };
  const find = (id: string) => h.incidents.find((r) => r.id === id);

  return {
    incidentSeverity: (kind: string) => SEVERITY[kind] ?? 0,
    repos: {
      project: {
        listAllForScan: vi.fn(async () => h.projects),
      },
      deployment: {
        findManyById: vi.fn(async (ids: string[]) => {
          const out = new Map<string, Record<string, unknown>>();
          for (const dep of h.deployments) {
            if (ids.includes(dep.id as string)) out.set(dep.id as string, dep);
          }
          return out;
        }),
        findLatestByProjects: vi.fn(async (ids: string[]) => {
          const out = new Map<string, Record<string, unknown>>();
          for (const dep of h.deployments) {
            const pid = dep.projectId as string;
            if (!ids.includes(pid)) continue;
            const cur = out.get(pid);
            if (!cur || (dep.createdAt as Date) > (cur.createdAt as Date)) out.set(pid, dep);
          }
          return out;
        }),
      },
      service: {
        listByProjects: vi.fn(async (ids: string[]) => {
          const out = new Map<string, Array<Record<string, unknown>>>();
          for (const id of ids) out.set(id, h.services.get(id) ?? []);
          return out;
        }),
        listByDeployment: vi.fn(async (depId: string) => h.serviceDeployments.get(depId) ?? []),
      },
      server: {
        findLocal: vi.fn(async () => h.localServer ?? undefined),
        // Unknown ids get NO entry, exactly as the real bulk lookup leaves them out —
        // that absence is how a deployment pointing at a deleted server is modelled.
        getMany: vi.fn(async (ids: string[]) => {
          const out = new Map<string, Record<string, unknown>>();
          for (const id of ids) {
            const row = h.servers.get(id);
            if (row) out.set(id, row);
          }
          return out;
        }),
        listByOrganization: vi.fn(async (organizationId: string) =>
          [...h.servers.values()].filter((s) => s.organizationId === organizationId),
        ),
      },
      auditEvent: {
        create: vi.fn(async () => ({ id: `audit-${h.incidents.length}` })),
      },
      serviceIncident: {
        listOpen: vi.fn(async () =>
          h.incidents.filter((r) => r.status === "open" && r.projectId).map((r) => ({ ...r })),
        ),
        findOpenForServer: vi.fn(async (serverId: string) => {
          const row = h.incidents.find(
            (r) => r.status === "open" && !r.projectId && r.serverId === serverId,
          );
          return row ? { ...row } : undefined;
        }),
        // The partial unique index, emulated: one open row per (project, key).
        open: vi.fn(async (data: Record<string, unknown>) => {
          const clash = h.incidents.some(
            (r) =>
              r.status === "open" &&
              r.projectId === (data.projectId ?? null) &&
              r.serviceKey === data.serviceKey,
          );
          if (clash) return undefined;
          const row = {
            exitCode: null,
            restartCount: 0,
            oomKilled: false,
            confirmations: 0,
            reason: null,
            logExcerpt: null,
            containerId: null,
            serviceId: null,
            serverId: null,
            projectId: null,
            ...data,
            id: `inc-${++h.seq}`,
            status: "open",
            notifyCount: 0,
            notifiedAt: null,
            openedAt: new Date(),
            resolvedAt: null,
            lastSeenAt: new Date(),
          } as Row;
          h.incidents.push(row);
          return { ...row };
        }),
        // One call is one observation, counted in the statement — the caller never
        // computes the next value, and a closed incident is not still being observed.
        touch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          const row = find(id);
          if (!row || row.status !== "open") return;
          Object.assign(row, patch, {
            confirmations: row.confirmations + 1,
            lastSeenAt: new Date(),
          });
        }),
        // Compare-and-set on the kind the caller decided against, reporting whether it
        // landed: the caller notifies off this boolean.
        escalate: vi.fn(
          async (id: string, from: string, to: string, patch: Record<string, unknown>) => {
            if (h.raceOnEscalate) {
              const race = h.raceOnEscalate;
              h.raceOnEscalate = null;
              race();
            }
            const row = find(id);
            if (!row || row.status !== "open" || row.kind !== from) return false;
            Object.assign(row, patch, { kind: to, lastSeenAt: new Date() });
            return true;
          },
        ),
        resolve: vi.fn(async (id: string, at = new Date()) => {
          const row = find(id);
          if (!row || row.status !== "open") return false;
          Object.assign(row, { status: "resolved", resolvedAt: at, lastSeenAt: at });
          return true;
        }),
        markNotified: vi.fn(async (id: string) => {
          const row = find(id);
          if (row) Object.assign(row, { notifyCount: row.notifyCount + 1, notifiedAt: new Date() });
        }),
        deleteResolvedOlderThan: vi.fn(async () => 0),
      },
    },
  };
});

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  getPlatform: () => ({ target: "selfhosted", runtime: { name: "docker" } }),
}));

vi.mock("../../lib/notification-dispatcher", () => ({ notification: { emit: h.emit } }));

vi.mock("../../lib/public-url", () => ({
  resolveDashboardPublicUrl: () => "https://ops.example.com",
}));

// The event accelerator has its own suite (container-events.test.ts). Here it
// would only pull a module graph — and live SSH/timer state — into a suite about
// the sweep itself.
vi.mock("./container-events", () => ({ renewEventWatchers: h.renew }));

/**
 * Faithful copies of the two routing functions, for a SELFHOSTED base.
 *
 * Copied rather than imported because importing the real module pulls the platform + SSH
 * graph this file exists to avoid. That makes fidelity a hand-maintained property, so the
 * awkward branches are the ones reproduced most carefully — they are where the group key
 * and the transport can disagree:
 *
 *   - ANY recorded serverId routes over SSH, whatever `deployTarget` says.
 *   - `deployTarget: "server"` with NO serverId still routes over SSH, to the org's one
 *     server — and throws if the org doesn't have exactly one, as `resolveOrgServer` does.
 *   - `deployTarget: "cloud"` is only cloud when the build was local; otherwise the
 *     project was promoted and `project.cloudWorkspaceId` is what says so.
 *
 * A mock that flattened those (an earlier one mapped "no serverId" to the LOCAL socket)
 * makes the mis-keyed group unrepresentable: every daemon answers alike, so the fixture
 * agrees with a sweep that is reading the wrong box.
 */
vi.mock("../../lib/deployment-runtime", () => ({
  resolveEffectiveTarget: (_base: string, meta: Record<string, unknown>) =>
    meta.serverId || meta.deployTarget === "server"
      ? "server"
      : meta.deployTarget === "cloud" && meta.buildStrategy === "local"
        ? "cloud"
        : "local",
  resolveDeploymentRuntimeForRead: vi.fn(
    async (dep: { meta: Record<string, unknown>; organizationId: string }) => {
      const meta = dep.meta ?? {};
      let box: string | null = null;
      if (meta.serverId) box = meta.serverId as string;
      else if (meta.deployTarget === "server") {
        const owned = [...h.servers.values()].filter(
          (s) => s.organizationId === dep.organizationId,
        );
        // `resolveOrgServer`: the org's ONE server, or nothing at all.
        if (owned.length !== 1) {
          throw new Error("Deployment target server not found in this organization.");
        }
        box = owned[0]!.id;
      }
      return { runtime: fakeRuntime(box), serverId: box };
    },
  ),
}));

/** A Docker daemon that answers from the fixture maps — for ONE box. */
function fakeRuntime(box: string | null = null) {
  return {
    supports: (cap: string) =>
      cap === "hostContainerQuery" || (cap === "stabilityProbe" && !h.noProbe),
    listAllContainers: async () => {
      if (h.listThrows) throw new Error(h.listThrows);
      // Accepted and never answered. A rejection is the polite failure; this is the
      // one the deadline exists for.
      if (h.listHangs) return new Promise<never>(() => {});
      // One box only: a daemon cannot see another box's containers.
      return [...h.containers.values()].filter(
        (c) => (h.containerBox.get(c.id as string) ?? null) === box,
      );
    },
    sampleStability: async (id: string): Promise<ContainerStabilitySample> => {
      h.inspects++;
      if (h.sampleHangs) return new Promise<never>(() => {});
      if (h.sampleGate) await h.sampleGate;
      const container = h.containers.get(id);
      return {
        state: (container?.state as ContainerStabilitySample["state"]) ?? "missing",
        exitCode: null,
        restartCount: 0,
        health: null,
        errorLine: null,
        oomKilled: false,
        restartPolicy: "always",
        ...h.samples.get(id),
      };
    },
    getRuntimeLogs: async () => h.logLines.map((message) => ({ message })),
    dispose: async () => {
      h.disposed();
    },
  };
}

// ─── Fixture builders ────────────────────────────────────────────────────────

const OLD = () => new Date(Date.now() - 30 * 60_000);

interface SeedOpts {
  serverId?: string | null;
  status?: string;
  updatedAt?: Date;
  runtimeMode?: string;
  deployTarget?: string;
  buildStrategy?: string;
  /** Set to make this a promoted cloud project — the canonical cloud test. */
  cloudWorkspaceId?: string;
  /**
   * The box the container really lives on, when the meta can't name it: a deploy that
   * targets "a server" without recording which one still runs SOMEWHERE, and the point of
   * resolving the target is to look for it there.
   */
  hostBox?: string;
  disabledAt?: Date | null;
}

/**
 * Register the server row a fixture's meta points at.
 *
 * Real deploys stamp an id that exists, so seeds do too — a dangling or foreign row is
 * something a test opts into by deleting or rewriting the entry.
 */
function registerServer(id: string | null, organizationId = "org1") {
  if (id) h.servers.set(id, { id, name: `box-${id}`, organizationId });
  return id;
}

/** A single-app (non-compose) project whose deploy settled half an hour ago. */
function seedApp(opts: SeedOpts = {}) {
  const n = ++h.seq;
  const projectId = `p${n}`;
  const depId = `d${n}`;
  const containerId = `container${n}`.padEnd(14, "0");
  const box = registerServer(opts.serverId === undefined ? "srv1" : opts.serverId);
  h.projects.push({
    id: projectId,
    name: `App ${n}`,
    slug: `app-${n}`,
    organizationId: "org1",
    activeDeploymentId: depId,
    cloudWorkspaceId: opts.cloudWorkspaceId ?? null,
    disabledAt: opts.disabledAt ?? null,
  });
  h.deployments.push({
    id: depId,
    projectId,
    organizationId: "org1",
    status: opts.status ?? "ready",
    containerId,
    meta: {
      serverId: box,
      runtimeMode: opts.runtimeMode ?? "docker",
      ...(opts.deployTarget ? { deployTarget: opts.deployTarget } : {}),
      ...(opts.buildStrategy ? { buildStrategy: opts.buildStrategy } : {}),
    },
    createdAt: OLD(),
    updatedAt: opts.updatedAt ?? OLD(),
  });
  h.containerBox.set(containerId, opts.hostBox ?? box);
  h.containers.set(containerId, {
    id: containerId,
    names: [`/openship-app-${n}-${depId}`],
    state: "running",
    status: "Up 3 hours",
    labels: {},
  });
  return { projectId, depId, containerId };
}

/** A compose project, matched by its `openship.*` labels. One service by default. */
function seedComposeService(
  opts: { serviceStatus?: string; enabled?: boolean; serverId?: string; services?: number } = {},
) {
  const n = ++h.seq;
  const projectId = `p${n}`;
  const depId = `d${n}`;
  const count = opts.services ?? 1;
  const names = Array.from({ length: count }, (_, i) => (i === 0 ? "web" : `svc${i + 1}`));
  const all = names.map((name, i) => ({
    name,
    serviceId: `s${n}-${i}`,
    containerId: `svc${n}x${i}`.padEnd(14, "0"),
  }));
  const { serviceId, containerId } = all[0]!;
  const box = registerServer(opts.serverId ?? "srv1");
  h.projects.push({
    id: projectId,
    name: `Stack ${n}`,
    slug: `stack-${n}`,
    organizationId: "org1",
    activeDeploymentId: depId,
    cloudWorkspaceId: null,
    disabledAt: null,
  });
  h.deployments.push({
    id: depId,
    projectId,
    organizationId: "org1",
    status: "ready",
    containerId: null,
    meta: { serverId: box, runtimeMode: "docker" },
    createdAt: OLD(),
    updatedAt: OLD(),
  });
  h.services.set(
    projectId,
    all.map((s) => ({ id: s.serviceId, projectId, name: s.name, enabled: opts.enabled ?? true })),
  );
  h.serviceDeployments.set(
    depId,
    all.map((s) => ({
      serviceId: s.serviceId,
      containerId: s.containerId,
      status: opts.serviceStatus ?? "running",
    })),
  );
  for (const s of all) {
    h.containerBox.set(s.containerId, box);
    h.containers.set(s.containerId, {
      id: s.containerId,
      names: [`/openship-stack-${n}-${s.name}`],
      state: "running",
      status: "Up 3 hours",
      labels: { "openship.project": projectId, "openship.service": s.name },
    });
  }
  return { projectId, serviceId, containerId, all };
}

/** Put a container into a state + inspect sample, as one tick would observe it. */
function setState(
  containerId: string,
  state: ContainerStabilitySample["state"] | "gone",
  sample: Partial<ContainerStabilitySample> = {},
) {
  if (state === "gone") {
    h.containers.delete(containerId);
    h.samples.delete(containerId);
    return;
  }
  const container = h.containers.get(containerId);
  if (container) container.state = state;
  h.samples.set(containerId, { state, ...sample });
}

/**
 * Ticks land 5s apart, never in the same instant.
 *
 * `MIN_CONFIRM_GAP_MS` (4s) is what stops an event-accelerated BURST — several
 * transitions inside one second — from confirming a fault on its own, so two
 * observations with no time between them deliberately count as one. The real poll
 * is 60s apart; 5s clears the floor while keeping every fixture's deploy well
 * inside DEPLOY_GRACE_MS.
 *
 * `Date` is faked whole rather than just `Date.now` — the incident service stamps
 * recovery with `new Date()` (incident.service.ts:265) and fixtures build dates the
 * same way, so half-faking would leave the sweep and the rows it reads on two
 * different clocks. Timers are NOT faked: the sweep awaits real promises.
 */
const TICK_SPACING_MS = 5_000;
const START = Date.now();
vi.useFakeTimers({ toFake: ["Date"], now: START });

async function tick(opts?: { onlyServerKeys?: ReadonlySet<string>; afterMs?: number }) {
  vi.setSystemTime(Date.now() + (opts?.afterMs ?? TICK_SPACING_MS));
  const { runHealthWatch } = await import("./health-watch");
  return runHealthWatch(opts?.onlyServerKeys ? { onlyServerKeys: opts.onlyServerKeys } : undefined);
}

/** Two observations of the same fault, spaced far enough apart to confirm it. */
async function confirm() {
  await tick();
  return tick();
}

/**
 * A control-plane restart.
 *
 * `MEMORY` and `sweepChain` are module state, so a fresh module instance is exactly
 * what a restart leaves behind — and `tick()` re-imports, so the next one gets it. The
 * fixture database (`h.incidents`) survives, which is the whole point of the split:
 * everything whose loss would double-page lives there, not in the process.
 */
function restart() {
  vi.resetModules();
}

/** The sweep's grouping key for a box, via the real helper the accelerator uses. */
async function groupKey(serverId: string | null) {
  const { watchGroupKey } = await import("./health-watch");
  return watchGroupKey(serverId, "org1");
}

/** Notifications of one eventType, in order. */
function emitted(eventType: string): Array<Record<string, unknown>> {
  return h.emit.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((input) => input.eventType === eventType);
}

function payloads(eventType: string): Array<Record<string, unknown>> {
  return emitted(eventType).map((input) => input.payload as Record<string, unknown>);
}

const openFor = (projectId: string) =>
  h.incidents.filter((r) => r.projectId === projectId && r.status === "open");

beforeEach(() => {
  // Rewind per test, or the 5s-per-tick drift accumulated across the whole file
  // would eventually push a just-settled deploy outside DEPLOY_GRACE_MS. MEMORY is
  // still never reset — ids are fresh per seed.
  vi.setSystemTime(START);
  h.projects.length = 0;
  h.deployments.length = 0;
  h.incidents.length = 0;
  h.services.clear();
  h.serviceDeployments.clear();
  h.containers.clear();
  h.containerBox.clear();
  h.servers.clear();
  h.samples.clear();
  h.localServer = null;
  h.listThrows = null;
  h.listHangs = false;
  h.noProbe = false;
  h.sampleHangs = false;
  h.sampleGate = null;
  h.raceOnEscalate = null;
  h.inspects = 0;
  h.emit.mockClear();
  h.disposed.mockClear();
  h.renew.mockClear();
});

// ─── Confirmation ────────────────────────────────────────────────────────────

describe("confirmation", () => {
  it("takes two agreeing ticks to open an incident", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });

    const first = await tick();
    expect(first.opened).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();

    const second = await tick();
    expect(second.opened).toBe(1);
    expect(emitted("service.down")).toHaveLength(1);
    expect(openFor(projectId)[0]?.kind).toBe("down");
  });

  it("never opens for a fault that appears on one tick only", async () => {
    const { projectId, containerId } = seedApp();

    setState(containerId, "exited", { exitCode: 1 });
    await tick();
    setState(containerId, "running");
    await tick();
    await tick();

    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("opens for a container stuck in `created`, counting from the second look", async () => {
    // `created` is a race with a deploy on the first observation and a container that
    // cannot start on the second — so the counter behind that rule has to survive an
    // observation that establishes nothing else, which the first one by design is.
    const { projectId, containerId } = seedApp();
    setState(containerId, "created");

    const first = await tick();
    expect(first.indeterminate).toBe(1);
    expect(first.pending).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);

    expect((await tick()).pending).toBe(1);
    expect((await tick()).opened).toBe(1);
    expect((payloads("service.down")[0]?.message as string) ?? "").toContain(
      "created but never started",
    );
  });

  it("attaches the container's log tail and exit detail to the alert", async () => {
    const { containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 137, oomKilled: true });

    await tick();
    await tick();

    const [input] = emitted("service.down");
    expect(input?.payload).toMatchObject({ exitCode: 137, oomKilled: true });
    expect((input?.payload as Record<string, unknown>).errorMessage).toContain(
      "connection refused",
    );
    expect((input?.payload as Record<string, unknown>).message).toContain("OOM-killed");
    expect((input?.payload as Record<string, unknown>).url).toBe(
      `https://ops.example.com/projects/${(input?.resourceId as string) ?? ""}/health`,
    );
  });
});

// ─── One fault, one message ──────────────────────────────────────────────────

describe("alert volume", () => {
  it("notifies once for a crash loop that runs for ten ticks", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "restarting", { exitCode: 1 });

    for (let i = 0; i < 10; i++) await tick();

    expect(emitted("service.crash_loop")).toHaveLength(1);
    expect(h.emit).toHaveBeenCalledTimes(1);
    // Ten ticks of evidence recorded; still exactly one message sent.
    const [incident] = openFor(projectId);
    expect(incident?.notifyCount).toBe(1);
    expect(incident?.confirmations).toBeGreaterThan(1);
  });

  it("catches a loop the container list reports as running", async () => {
    // A container that crashes every 20s reads "Up 12 seconds / running" on every
    // poll. Only the RestartCount delta can see it.
    const { containerId } = seedApp();
    setState(containerId, "running", { restartCount: 10 });
    expect((await tick()).opened).toBe(0);

    setState(containerId, "running", { restartCount: 13 });
    expect((await tick()).opened).toBe(0); // first agreeing tick

    setState(containerId, "running", { restartCount: 16 });
    expect((await tick()).opened).toBe(1);
    expect(emitted("service.crash_loop")).toHaveLength(1);
    // 6, not 3: the baseline stays ANCHORED at 10 for RESTART_WINDOW_MS, so the two
    // observations 5s apart accumulate against it instead of each re-anchoring on
    // the one before. The message reports the window it actually measured.
    expect(payloads("service.crash_loop")[0]?.message).toContain(
      "restarted 6 times in the last 10 seconds",
    );
  });

  /**
   * Every other tick in this file lands 5s apart, INSIDE `RESTART_WINDOW_MS`, so they all
   * take the accumulate branch. The scheduled job (`* * * * *`) never does: 60s is past
   * the window by design, so a poll re-anchors on the count it just read and each tick
   * measures one minute of restarts. That is the production path, and these two are the
   * only tests that walk it.
   */
  const POLL = 60_000;

  it("catches a loop at the real 60s cadence, where every tick re-anchors", async () => {
    const { containerId } = seedApp();
    setState(containerId, "running", { restartCount: 10 });
    expect((await tick({ afterMs: POLL })).opened).toBe(0);

    setState(containerId, "running", { restartCount: 13 });
    expect((await tick({ afterMs: POLL })).opened).toBe(0); // first agreeing tick

    setState(containerId, "running", { restartCount: 16 });
    expect((await tick({ afterMs: POLL })).opened).toBe(1);
    // 3, not 6: the anchor moved with each poll, so the delta is one minute's restarts —
    // and the operator is told the window that was actually measured.
    expect(payloads("service.crash_loop")[0]?.message).toContain(
      "restarted 3 times in the last minute",
    );
  });

  it("never calls one restart a minute a crash loop", async () => {
    // The same re-anchoring, from the other side: an app that bounces once a minute for
    // eight minutes is not looping, and holding the anchor across polls would add its
    // restarts up until they crossed the threshold and paged.
    const { containerId } = seedApp();
    let count = 10;
    for (let i = 0; i < 8; i++) {
      setState(containerId, "running", { restartCount: count++ });
      const summary = await tick({ afterMs: POLL });
      // `pending` and not just `opened`: never confirmed is the weaker claim, and a
      // fault that keeps being CONSIDERED is one flap away from being confirmed.
      expect(summary.pending).toBe(0);
      expect(summary.opened).toBe(0);
    }
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("notifies on escalation and stays silent when the fault gets better", async () => {
    const { projectId, containerId } = seedApp();

    setState(containerId, "running", { health: "unhealthy" });
    h.containers.get(containerId)!.status = "Up 3 hours (unhealthy)";
    await tick();
    await tick();
    expect(emitted("service.unhealthy")).toHaveLength(1);

    setState(containerId, "exited", { exitCode: 1 });
    await tick();
    await tick();
    expect(emitted("service.down")).toHaveLength(1);
    expect(payloads("service.down")[0]?.previousKind).toBe("unhealthy");
    // The sentence brings its own tense, so the kind must not bring a verb: a map of
    // predicates dropped in here read "It was already is unhealthy for 5s".
    expect(payloads("service.down")[0]?.message).toMatch(/It was already unhealthy for \d/);

    // Back to merely unhealthy, for three ticks: a de-escalation is not news, and
    // the incident keeps the WORST kind so a flap can't re-page.
    setState(containerId, "running", { health: "unhealthy" });
    await tick();
    await tick();
    await tick();
    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(openFor(projectId)[0]?.kind).toBe("down");
  });

  it("stays quiet when another process wins the same escalation", async () => {
    const { projectId, containerId } = seedApp();

    setState(containerId, "running", { health: "unhealthy" });
    h.containers.get(containerId)!.status = "Up 3 hours (unhealthy)";
    await confirm();
    expect(emitted("service.unhealthy")).toHaveLength(1);

    // Now it goes down — and a second control-plane process against the same database
    // promotes this very incident in the window between our read and our write. That
    // window is the only place the race exists, so the fixture opens it there.
    setState(containerId, "exited", { exitCode: 1 });
    h.raceOnEscalate = () => {
      const row = openFor(projectId)[0]!;
      row.kind = "down";
      row.notifyCount += 1; // whoever won told the operator
    };
    await confirm();

    // Our compare-and-set found nothing to promote, so we said nothing. The operator
    // has already heard about this transition once; a second message is exactly the
    // double page the incident row exists to prevent.
    expect(emitted("service.down")).toHaveLength(0);
    expect(h.emit).toHaveBeenCalledTimes(1);
    // The escalation itself still landed, once, on the one incident.
    expect(openFor(projectId)).toHaveLength(1);
    expect(openFor(projectId)[0]?.kind).toBe("down");
  });
});

// ─── Recovery ────────────────────────────────────────────────────────────────

describe("recovery", () => {
  it("closes the incident on one healthy tick and reports the downtime", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });
    await tick();
    await tick();

    const incident = openFor(projectId)[0]!;
    // Downtime is measured on the tick that RESOLVES it, one spacing from here.
    incident.openedAt = new Date(Date.now() + TICK_SPACING_MS - 200_000);

    setState(containerId, "running");
    const summary = await tick();

    expect(summary.resolved).toBe(1);
    expect(emitted("service.recovered")).toHaveLength(1);
    expect(payloads("service.recovered")[0]).toMatchObject({ downtime: "3m 20s" });
    // Whole sentence, for the same reason as the escalation above: "it was is down
    // for 3m 20s" is what a predicate in this slot produces.
    expect(payloads("service.recovered")[0]?.message).toMatch(
      /is back up — it was down for 3m 20s\.$/,
    );
    expect(openFor(projectId)).toHaveLength(0);

    // And it does not re-open or re-announce on the following ticks.
    await tick();
    expect(emitted("service.recovered")).toHaveLength(1);
  });

  it("holds the all-clear back for a workload that keeps re-breaking", async () => {
    const { projectId, containerId } = seedApp();

    // Break, recover: both announced at once. Recovery is not the direction that
    // needs hysteresis until there is EVIDENCE this workload flaps — an operator
    // watching a fix land wants the all-clear promptly.
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    setState(containerId, "running");
    await tick();
    expect(emitted("service.down")).toHaveLength(1);
    expect(emitted("service.recovered")).toHaveLength(1);

    // Now it is a known flapper. Six more break/heal cycles, each heal far shorter
    // than RECOVERY_HOLD_MS — which is what an oscillating healthcheck, or Docker's
    // own restart backoff, looks like. Nothing here ever reads as a crash loop: the
    // container comes back up each time.
    for (let i = 0; i < 6; i++) {
      setState(containerId, "exited", { exitCode: 1 });
      await confirm();
      setState(containerId, "running");
      const summary = await tick();
      expect(summary.resolved).toBe(0);
      expect(summary.recovering).toBe(1);
      // Held back, but NOT as `pending` — that field is the event accelerator's cue
      // to take another observation, and a two-minute hold must not read as "sweep
      // this box again in six seconds" for its whole duration.
      expect(summary.pending).toBe(0);
    }

    // One episode for the storm: the first cycle's pair, plus one alert for the
    // break that re-opened it. Not two messages per cycle.
    expect(emitted("service.down")).toHaveLength(2);
    expect(emitted("service.recovered")).toHaveLength(1);
    expect(openFor(projectId)).toHaveLength(1);

    // Deferred, not swallowed: left healthy for the hold, the all-clear lands.
    for (let i = 0; i < 25; i++) await tick();
    expect(emitted("service.recovered")).toHaveLength(2);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).toHaveBeenCalledTimes(4);
  });
});

// ─── Control-plane restart ───────────────────────────────────────────────────

/**
 * What survives a restart, and what it costs when something doesn't.
 *
 * `MEMORY` is process state by design (see its doc block). That is only defensible if
 * losing it can't produce the two failures this feature exists to prevent — a second
 * page for a fault already announced, and silence about a real one — so both of those
 * are asserted here rather than argued in a comment.
 */
describe("control-plane restart", () => {
  it("never re-pages a fault it already announced", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    expect(emitted("service.down")).toHaveLength(1);
    const before = { ...openFor(projectId)[0]! };

    restart();

    // Still down. The sweep has to re-earn its two agreeing observations, and then
    // finds the incident row already at this kind — that row, not MEMORY, is what
    // makes the second page impossible.
    await confirm();
    await confirm();

    expect(emitted("service.down")).toHaveLength(1);
    expect(h.emit).toHaveBeenCalledTimes(1);
    const after = openFor(projectId)[0]!;
    expect(after.id).toBe(before.id);
    expect(after.notifyCount).toBe(1);
    // Quiet, but not blind: the observations still landed on the incident.
    expect(after.confirmations).toBeGreaterThan(before.confirmations);
  });

  it("still catches a fault that breaks for the first time after a restart", async () => {
    const { projectId, containerId } = seedApp();
    await tick();
    restart();

    setState(containerId, "exited", { exitCode: 1 });
    await confirm();

    expect(emitted("service.down")).toHaveLength(1);
    expect(openFor(projectId)).toHaveLength(1);
  });

  it("forfeits exactly one cycle of flap damping, then re-learns the anchor", async () => {
    const { projectId, containerId } = seedApp();

    // Cycle 1 — the first break/heal is always announced in full; nothing yet says
    // this workload flaps.
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    setState(containerId, "running");
    await tick();
    expect(emitted("service.down")).toHaveLength(1);
    expect(emitted("service.recovered")).toHaveLength(1);

    // Cycle 2 breaks, and the control plane restarts before it heals. Without the
    // restart this heal would be HELD (see the flapper test above) — the anchor that
    // proves it flaps was in MEMORY.
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    expect(emitted("service.down")).toHaveLength(2);
    restart();

    setState(containerId, "running");
    const afterRestart = await tick();
    // The accepted cost, pinned so that making the anchor durable has to be a
    // deliberate edit here: one extra all-clear, once, per restart.
    expect(afterRestart.recovering).toBe(0);
    expect(afterRestart.resolved).toBe(1);
    expect(emitted("service.recovered")).toHaveLength(2);

    // And the anchor is re-learned from that very resolve, so cycle 3 is damped again
    // — the storm does not come back with the process.
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    setState(containerId, "running");
    const damped = await tick();

    expect(damped.recovering).toBe(1);
    expect(damped.resolved).toBe(0);
    expect(emitted("service.recovered")).toHaveLength(2);
    expect(openFor(projectId)).toHaveLength(1);
  });
});

// ─── Gate 1: a deploy in flight ──────────────────────────────────────────────

describe("deploy suppression", () => {
  it("skips a project whose deploy is still running", async () => {
    const { projectId, containerId } = seedApp({ status: "deploying" });
    setState(containerId, "gone");

    const summary = await tick();
    await tick();

    expect(summary.projects).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("skips a project whose deploy only just settled", async () => {
    const { containerId } = seedApp({ updatedAt: new Date() });
    setState(containerId, "gone");

    expect((await tick()).projects).toBe(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("leaves an existing incident open while a redeploy is in flight", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });
    await tick();
    await tick();
    expect(openFor(projectId)).toHaveLength(1);

    // Redeploy starts: we know nothing about this project now, so the incident is
    // neither resolved (it didn't recover) nor stale-closed.
    const dep = h.deployments.find((d) => d.projectId === projectId)!;
    dep.status = "building";
    const summary = await tick();

    expect(summary.stale).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(openFor(projectId)).toHaveLength(1);
  });
});

// ─── Gate 2: intent ──────────────────────────────────────────────────────────

describe("intentional stop", () => {
  it("never alerts for a service the operator stopped", async () => {
    const { projectId, containerId } = seedComposeService({ serviceStatus: "stopped" });
    setState(containerId, "exited", { exitCode: 137 });

    await tick();
    await tick();
    await tick();

    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("closes an open incident silently when the operator stops the broken service", async () => {
    // The most likely sequence there is: alert fires, operator stops the service to
    // stop the bleeding. The container is still exited — the ONLY thing that changed
    // is that it is now supposed to be. Announcing "is back up" for that is how an
    // operator learns that this channel's recoveries mean nothing.
    const { projectId, containerId } = seedComposeService();
    setState(containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    await confirm();
    expect(emitted("service.down")).toHaveLength(1);
    h.emit.mockClear();

    const depId = h.deployments.find((d) => d.projectId === projectId)!.id as string;
    (h.serviceDeployments.get(depId)![0] as Record<string, unknown>).status = "stopped";
    const summary = await tick();

    expect(summary.stale).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("closes an open incident silently when the container is paused", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    await confirm();
    expect(openFor(projectId)).toHaveLength(1);
    h.emit.mockClear();

    // `docker pause` is only ever a human, and there is no service row to say so.
    setState(containerId, "paused");
    const summary = await tick();

    expect(summary.stale).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("closes an open incident silently when the project is disabled", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });
    await tick();
    await tick();
    h.emit.mockClear();

    h.projects.find((p) => p.id === projectId)!.disabledAt = new Date();
    const summary = await tick();

    // Closed, but NOT announced as a recovery — it didn't come back, it stopped
    // being watched.
    expect(summary.stale).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("closes an open incident for a project the scan no longer returns", async () => {
    // A soft delete keeps the project row — the whole point is that the workload and
    // its data stay on the server — so the incident's `onDelete: "cascade"` never
    // fires, and `listAllForScan` filters the row out, so the project lands in neither
    // `retired` nor `swept`. Scoped to just those two sets the reap could not reach it:
    // the Health tab went on reporting an outage for a project nothing else lists.
    seedApp(); // something else on the box, so the scan is not empty
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    expect(openFor(projectId)).toHaveLength(1);
    h.emit.mockClear();

    h.projects = h.projects.filter((p) => p.id !== projectId);
    const summary = await tick();

    // Same silence as the disabled case above, for the same reason — and permanently:
    // absent from the scan is the strongest form of "nobody is watching this", because
    // no later tick can confirm it either.
    expect(summary.stale).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });
});

// ─── Gate 3: an unreachable box ──────────────────────────────────────────────

describe("unreachable server", () => {
  it("sends one alert for the box, not one per project, and resolves nothing", async () => {
    const seeds = Array.from({ length: 5 }, () => seedApp({ serverId: "srv9" }));
    // One of them was already down before the box went away.
    setState(seeds[0]!.containerId, "exited", { exitCode: 1 });
    await tick();
    await tick();
    expect(openFor(seeds[0]!.projectId)).toHaveLength(1);
    h.emit.mockClear();

    h.listThrows = "connect ETIMEDOUT 10.0.0.9:22";
    const summary = await tick();

    expect(summary.unreachable).toBe(1);
    expect(summary.opened).toBe(1);
    expect(emitted("server.unreachable")).toHaveLength(1);
    expect(payloads("server.unreachable")[0]).toMatchObject({ affectedProjects: 5 });
    expect(payloads("server.unreachable")[0]?.message).toContain("5 projects");
    // Nothing on the box was resolved or retired — we know nothing right now.
    expect(summary.resolved).toBe(0);
    expect(summary.stale).toBe(0);
    expect(openFor(seeds[0]!.projectId)).toHaveLength(1);

    // Still down four ticks later: still one message.
    await tick();
    await tick();
    await tick();
    expect(emitted("server.unreachable")).toHaveLength(1);

    // The box answers again → one all-clear, and the workload that is still down
    // does not get a false recovery.
    h.listThrows = null;
    const back = await tick();
    expect(back.resolved).toBe(1);
    expect(emitted("server.reachable")).toHaveLength(1);
    expect(payloads("server.reachable")[0]?.message).toContain("answering again");
    expect(emitted("service.recovered")).toHaveLength(0);
    expect(openFor(seeds[0]!.projectId)).toHaveLength(1);
  });

  it("closes the control plane's own box incident once its socket answers again", async () => {
    // A local group has no `serverId` — the deployment targets the control plane's own
    // docker socket — but the incident still hangs on the self-server ROW, because that
    // is the only thing there is to dedup against. The close path keyed itself off
    // `serverId`, which for this group is null, so the incident opened, paged, and then
    // had nothing that could ever close it: the Health tab reported an unreachable
    // server for as long as the row lived, and the all-clear was never sent.
    h.localServer = { id: "srv-self", name: "this machine" };
    seedApp({ serverId: null });
    seedApp({ serverId: null });

    h.listThrows = "connect ENOENT /var/run/docker.sock";
    const down = await tick();
    expect(down.unreachable).toBe(1);
    expect(down.opened).toBe(1);
    expect(down.errors).toBe(0);
    expect(payloads("server.unreachable")[0]?.message).toContain("2 projects");
    expect(h.incidents.filter((r) => r.status === "open" && r.serverId === "srv-self")).toHaveLength(
      1,
    );

    h.listThrows = null;
    const back = await tick();

    expect(back.resolved).toBe(1);
    expect(emitted("server.reachable")).toHaveLength(1);
    expect(h.incidents.filter((r) => r.status === "open" && !r.projectId)).toHaveLength(0);
  });

  it("never blames the box for a failure that happened after it answered", async () => {
    // Gate 3's catch wraps the whole group read, but only failures at or above the
    // container list are the daemon's. Past that the box has demonstrably answered,
    // so an incident write that rejects — a service row deleted mid-sweep takes its
    // foreign key with it — used to page every project on a healthy machine, with a
    // Postgres error for a message, moments after this same tick announced the box
    // was answering again.
    const { projectId, containerId } = seedApp({ serverId: "srvG" });
    const other = seedApp({ serverId: "srvG" });
    setState(containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    setState(other.containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    // A third project on the box, which will carry an incident that outlived its
    // workload — the case the reap exists for.
    const orphaned = seedApp({ serverId: "srvG" });
    await tick();

    // Staged between the two observations, so the reap has it to do on the tick that
    // also fails a write. It is only reachable if the group still counts as swept,
    // which is the observable difference between catching that failure per workload
    // and letting it abort the group.
    h.incidents.push({
      id: "inc-orphan",
      projectId: orphaned.projectId,
      organizationId: "org1",
      serviceKey: "a-service-this-release-no-longer-deploys",
      serviceName: "gone",
      kind: "down",
      status: "open",
      exitCode: 1,
      restartCount: 0,
      oomKilled: false,
      confirmations: 2,
      reason: "it exited with code 1",
      logExcerpt: null,
      containerId: null,
      serviceId: null,
      serverId: null,
      notifyCount: 1,
      notifiedAt: OLD(),
      openedAt: OLD(),
      resolvedAt: null,
      lastSeenAt: OLD(),
    } as unknown as Row);

    const { repos } = await import("@repo/db");
    vi.mocked(repos.serviceIncident.open).mockRejectedValueOnce(
      new Error('insert violates foreign key constraint "service_incident_service_id_fkey"'),
    );
    const summary = await tick();

    expect(summary.unreachable).toBe(0);
    expect(emitted("server.unreachable")).toHaveLength(0);
    expect(summary.errors).toBe(1);
    // The OTHER workload on the same box is still judged — one failed write is not a
    // reason to abandon the group.
    expect(summary.opened).toBe(1);
    expect(openFor(projectId).length + openFor(other.projectId).length).toBe(1);
    // And the group still counts as swept, so the reap runs. Aborting the group would
    // retract that (correctly — half a sweep may not retire anything), which is how a
    // single rejected write turns into "the Health tab keeps lying" for the whole box.
    expect(summary.stale).toBe(1);
    expect(openFor(orphaned.projectId)).toHaveLength(0);

    // And the one that failed is not forgotten: its agreement counter survived, so
    // the next tick opens it rather than starting over.
    expect((await tick()).opened).toBe(1);
    expect(openFor(projectId)).toHaveLength(1);
    expect(openFor(other.projectId)).toHaveLength(1);
  });

  it("counts a group read that dies past the container list as ours, not the box's", async () => {
    // Same rule as above but through the OTHER path: this one reaches gate 3's catch
    // (the per-workload guard is not in the way), so it is the gate itself — "the box
    // answered, therefore this is mine" — being pinned. A statement timeout on our own
    // Postgres must not be reported to five teams as an unreachable machine.
    const { projectId, containerId } = seedApp({ serverId: "srvH" });
    setState(containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    await confirm();
    expect(openFor(projectId)).toHaveLength(1);
    h.emit.mockClear();

    const { repos } = await import("@repo/db");
    // Thrown after the container list came back, before any workload is evaluated.
    vi.mocked(repos.serviceIncident.findOpenForServer).mockRejectedValueOnce(
      new Error("canceling statement due to statement timeout"),
    );
    const summary = await tick();

    expect(summary.unreachable).toBe(0);
    expect(summary.errors).toBe(1);
    expect(summary.stale).toBe(0);
    expect(summary.resolved).toBe(0);
    expect(openFor(projectId)).toHaveLength(1);
    expect(h.emit).not.toHaveBeenCalled();

    // Next tick is normal, and still silent — one alert per fault, whatever happened
    // in between.
    const after = await tick();
    expect(after.errors).toBe(0);
    expect(openFor(projectId)).toHaveLength(1);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("does not stale-close a live incident when the deadline lands mid-group", async () => {
    // The reap trusts `swept`, and a project is marked swept BEFORE its workloads are
    // evaluated — so half a sweep leaves "swept, never visited", which the reap reads
    // as "nobody watches this any more" and closes.
    //
    // Nine services and eight inspect workers, all of them wedged on a daemon that
    // accepts the inspect and never replies: `mapWithLimit` pulls from a shared cursor,
    // so the NINTH is never picked up at all. Its project is swept, it is unvisited,
    // and it is the one with the live incident. Without the retraction in gate 3's
    // catch, a wedged daemon silently closes the outage it exists to report.
    const { projectId, all } = seedComposeService({ serverId: "srvS", services: 9 });
    const last = all[8]!;
    setState(last.containerId, "running", { health: "unhealthy" });
    await confirm();
    expect(openFor(projectId)).toHaveLength(1);
    h.emit.mockClear();

    h.sampleHangs = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.now() });
    let summary: Awaited<ReturnType<typeof tick>>;
    try {
      const { runHealthWatch } = await import("./health-watch");
      const run = runHealthWatch();
      await vi.advanceTimersByTimeAsync(120_000);
      summary = await run;
    } finally {
      vi.useFakeTimers({ toFake: ["Date"], now: START });
    }

    // A daemon that stops answering mid-group is still an unreachable box — that half
    // of gate 3 is unchanged. What must NOT happen is the outage quietly disappearing.
    expect(summary.unreachable).toBe(1);
    expect(summary.errors).toBe(0);
    expect(summary.stale).toBe(0);
    expect(openFor(projectId)).toHaveLength(1);
    expect(emitted("service.recovered")).toHaveLength(0);
  });

  it("ignores a wedged inspect that answers after the group was written off", async () => {
    // `withTimeout` RACES the group body — it cannot cancel it. So the inspect workers
    // outlive the deadline, detached, outside the chain that serializes ticks, and
    // `mapWithLimit` is pull-based: the item behind a wedged worker is picked up only
    // when that worker answers, which here is a tick and a half later.
    //
    // Both halves of that matter. A late worker that WRITES turns one live observation
    // plus one stale one — spaced far enough apart to look like agreement — into a
    // confirmed fault, which is the false page `AGREE_TICKS` exists to prevent. And a
    // late worker that keeps PULLING carries on inspecting a box we just told the
    // operator we cannot reach.
    const { projectId, all } = seedComposeService({ serverId: "srvLate", services: 9 });
    setState(all[0]!.containerId, "running", { health: "unhealthy" });
    await tick();
    expect(openFor(projectId)).toHaveLength(0); // one observation — a second confirms

    h.emit.mockClear();
    let release!: () => void;
    h.sampleGate = new Promise<void>((resolve) => (release = resolve));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.now() });
    let summary: Awaited<ReturnType<typeof tick>>;
    let atDeadline = 0;
    try {
      const { runHealthWatch } = await import("./health-watch");
      const run = runHealthWatch();
      await vi.advanceTimersByTimeAsync(120_000);
      summary = await run;
      // Eight workers, nine services: the ninth was never picked up.
      atDeadline = h.inspects;

      // The daemon finally answers the inspects it accepted 90s ago.
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      h.sampleGate = null;
      vi.useFakeTimers({ toFake: ["Date"], now: START });
    }

    expect(summary.unreachable).toBe(1);
    // Nothing they saw may be acted on, and nothing more may be asked of the box.
    expect(h.inspects).toBe(atDeadline);
    expect(openFor(projectId)).toHaveLength(0);
    expect(emitted("service.unhealthy")).toHaveLength(0);
  });

  it("gives up on a daemon that answers nothing at all", async () => {
    // A half-open SSH bridge accepts the request and never replies. Every entry point
    // serializes on one chain, so without a deadline this wedges the whole feature for
    // the life of the process — scheduled and event-accelerated sweeps alike — and
    // says nothing while doing it. The job runner's own timeout marks the run failed
    // but cannot cancel the body.
    seedApp({ serverId: "srvHang" });
    seedApp({ serverId: "srvHang" });
    h.listHangs = true;

    // Timers are faked for this test alone: the deadline is a real `setTimeout`, and
    // 90s of wall clock for one assertion is not a trade worth making.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.now() });
    let summary: Awaited<ReturnType<typeof tick>>;
    try {
      const { runHealthWatch } = await import("./health-watch");
      const run = runHealthWatch();
      await vi.advanceTimersByTimeAsync(120_000);
      summary = await run;
    } finally {
      vi.useFakeTimers({ toFake: ["Date"], now: START });
    }

    // A box that cannot answer inside the deadline IS unreachable — the same
    // incident as a refused connection, which is the one an operator needs.
    expect(summary.unreachable).toBe(1);
    expect(summary.opened).toBe(1);
    expect(summary.errors).toBe(0);
    expect(emitted("server.unreachable")).toHaveLength(1);
    expect(payloads("server.unreachable")[0]?.message).toContain("2 projects");
    expect(payloads("server.unreachable")[0]?.errorMessage).toContain("within 90s");
    // And the wedged transport is torn down rather than held for the process's life:
    // `withTimeout` races the read, it cannot cancel it.
    expect(h.disposed).toHaveBeenCalledTimes(1);

    // The chain is free: the next sweep runs normally.
    h.listHangs = false;
    expect((await tick()).unreachable).toBe(0);
  });
});

// ─── One group, one daemon ───────────────────────────────────────────────────

/**
 * The group key has to name the daemon the group's runtime will actually reach.
 *
 * Every other test in this file takes that for granted, and it is the one premise a
 * fixture can't stumble into: a group is judged against a single `docker ps -a`, so a key
 * that disagrees with the transport reads one box's container list and returns a verdict
 * about another's. That failure is silent in the direction that matters — a healthy
 * service confirmed `down` because its container was never in the list it was compared
 * against, which is the exact page the two-tick agreement rule exists to prevent.
 */
describe("group identity", () => {
  it("keeps a serverless server-target deploy out of the local group", async () => {
    registerServer("srvX");
    // Seeded FIRST so it wins `group[0]`: keyed off meta alone both projects land in the
    // local group and the group's transport is resolved from this one — the local socket,
    // which has never heard of the other project's container.
    const local = seedApp({ serverId: null });
    const remote = seedApp({ serverId: null, deployTarget: "server", hostBox: "srvX" });

    const summary = await confirm();

    expect(openFor(remote.projectId)).toHaveLength(0);
    expect(openFor(local.projectId)).toHaveLength(0);
    expect(emitted("service.down")).toHaveLength(0);
    // Both still watched, as two boxes with a list each — not merged into one.
    expect(summary.projects).toBe(2);
    expect(summary.servers).toBe(2);
  });

  it("finds a fault on the box a serverless server-target deploy runs on", async () => {
    // The mirror image, so the split above can't be achieved by quietly not watching it.
    registerServer("srvY");
    seedApp({ serverId: null });
    const remote = seedApp({ serverId: null, deployTarget: "server", hostBox: "srvY" });
    setState(remote.containerId, "exited", { exitCode: 1 });

    await confirm();

    expect(openFor(remote.projectId)).toHaveLength(1);
    // From an inspect, not from an absence: a missing container carries no exit code.
    expect(openFor(remote.projectId)[0]?.exitCode).toBe(1);
  });

  it("skips a project whose server row is gone, leaving its incident alone", async () => {
    const { projectId, containerId } = seedApp({ serverId: "srvGone" });
    setState(containerId, "exited", { exitCode: 1 });
    await confirm();
    expect(openFor(projectId)).toHaveLength(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Nothing stops a server being deleted while projects still target it.
      h.servers.delete("srvGone");
      const summary = await tick();

      expect(summary.unresolved).toBe(1);
      expect(summary.projects).toBe(0);
      // Neither the box's fault (there is no box) nor a failure of ours.
      expect(summary.unreachable).toBe(0);
      expect(summary.errors).toBe(0);
      // Still listed, still fixable, so the incident stays exactly as it was: skipping
      // is not evidence of recovery, and closing it would hide a live outage.
      expect(openFor(projectId)).toHaveLength(1);
      expect(summary.stale).toBe(0);
      expect(summary.resolved).toBe(0);
      // Counted AND said out loud — a silent skip is indistinguishable from watching.
      expect(warn.mock.calls.flat().join(" ")).toContain("app-");
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a project whose server row belongs to another organization", async () => {
    const { projectId, containerId } = seedApp({ serverId: "srvMoved" });
    setState(containerId, "exited", { exitCode: 1 });
    h.servers.set("srvMoved", { id: "srvMoved", name: "box", organizationId: "org2" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = await confirm();

      expect(summary.unresolved).toBe(1);
      expect(openFor(projectId)).toHaveLength(0);
      expect(summary.unreachable).toBe(0);
      expect(summary.errors).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses to guess which of two boxes a serverless server-target deploy meant", async () => {
    registerServer("srvA");
    registerServer("srvB");
    const { projectId, containerId } = seedApp({
      serverId: null,
      deployTarget: "server",
      hostBox: "srvA",
    });
    setState(containerId, "exited", { exitCode: 1 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = await confirm();

      expect(summary.unresolved).toBe(1);
      expect(summary.projects).toBe(0);
      // The alternative isn't "guess" — it's an unreachable-box alert naming a box that
      // was never asked anything, which is what reading this as a dead group produced.
      expect(summary.unreachable).toBe(0);
      expect(summary.errors).toBe(0);
      expect(openFor(projectId)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── What is and isn't a watched workload ────────────────────────────────────

describe("workload selection", () => {
  it("reports a container that vanished out of band as down", async () => {
    const { containerId } = seedApp();
    setState(containerId, "gone");

    await tick();
    await tick();

    expect(payloads("service.down")[0]?.message).toContain("no longer exists on the host");
  });

  it("never watches a bare (systemd) app, whose containerId is a unit handle", async () => {
    const { projectId, containerId } = seedApp({ runtimeMode: "bare" });
    h.containers.delete(containerId);

    const summary = await tick();
    await tick();

    expect(summary.projects).toBe(1);
    expect(summary.workloads).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("never watches a local-orchestrated cloud deploy", async () => {
    // Built on this host, uploaded to a cloud workspace, RUN there — the one combo that
    // keeps the cloud target on a self-hosted box. Nothing local can observe it.
    const { containerId } = seedApp({
      deployTarget: "cloud",
      buildStrategy: "local",
      serverId: null,
    });
    setState(containerId, "exited", { exitCode: 1 });

    const summary = await tick();
    await tick();

    expect(summary.projects).toBe(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("never watches a promoted cloud project, whatever its last local deploy says", async () => {
    // `cloudWorkspaceId` is the canonical "this is a cloud project" test, and it has to
    // outrank the deployment snapshot: after a promote the workload runs on Oblien while
    // the last LOCAL deployment still reads as an ordinary local deploy. Watching that
    // snapshot means inspecting containers this host no longer has — a confirmed `down`
    // on a service that is up.
    const { containerId } = seedApp({ serverId: null, cloudWorkspaceId: "ws_1" });
    setState(containerId, "gone");

    const summary = await tick();
    await tick();

    expect(summary.projects).toBe(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("keeps quiet about a one-shot container that finished cleanly", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 0, restartPolicy: "no" });

    await tick();
    await tick();

    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });
});

// ─── The inspect budget ──────────────────────────────────────────────────────

describe("inspect budget", () => {
  it("never lets a skipped observation become a restart baseline", async () => {
    // MAX_INSPECTS_PER_SERVER is 120 and the budget is spent in project order, so
    // the 121st workload on a box is the one that only gets the list view. The list
    // view cannot see RestartCount and reports 0; storing that as the baseline would
    // read the container's LIFETIME count as a one-minute delta on the next
    // observation that does inspect — CRASH_RESTART_DELTA is 3, so anything with a
    // history pages as a crash loop while sitting perfectly healthy.
    const seeded = Array.from({ length: 121 }, () => seedApp({ serverId: "srvB" }));
    const starved = seeded.at(-1)!;

    const first = await tick();
    expect(first.skipped).toBe(1);

    // Free one slot so this tick DOES inspect it, and give it a long restart
    // history that is entirely in the past — two real inspects would show a delta
    // of 0.
    h.projects.find((p) => p.id === seeded[0]!.projectId)!.disabledAt = new Date();
    setState(starved.containerId, "running", { restartCount: 40 });

    const second = await tick();
    expect(second.skipped).toBe(0);
    expect(second.pending).toBe(0);
    expect(second.opened).toBe(0);
    expect(openFor(starved.projectId)).toHaveLength(0);
  });

  it("spends the budget on the containers the list view cannot explain", async () => {
    // The budget is per box and the workload order is STABLE across ticks, so
    // spending it in project order does not merely delay the tail — it starves the
    // same workloads every single minute, forever. Which is survivable for a running
    // container (the list view proves it is running) and not survivable for one that
    // isn't: without the inspect there is no exit code, and no exit code is
    // `unknown`, which by design neither opens nor closes anything.
    const healthy = Array.from({ length: 120 }, () => seedApp({ serverId: "srvE" }));
    const broken = seedApp({ serverId: "srvE" });
    setState(broken.containerId, "exited", { exitCode: 1, restartPolicy: "always" });

    const summary = await confirm();

    // Last in project order, first in inspect order.
    expect(summary.opened).toBe(1);
    expect(emitted("service.down")).toHaveLength(1);
    expect(openFor(broken.projectId)).toHaveLength(1);
    // Someone still went unsampled — one of the 120 the list view can account for.
    expect(summary.skipped).toBe(1);
    expect(summary.indeterminate).toBe(0);
    expect(openFor(healthy[0]!.projectId)).toHaveLength(0);
  });

  it("neither opens nor closes an incident from a sample it could not take", async () => {
    // The other half: when there is no inspect to be had at all, a container that is
    // merely NOT RUNNING is unexplained — a crashed service and a finished migration
    // job look identical. Reading that as healthy (which `exit ?? 0` did) closed live
    // incidents with an "is back up"; reading it as down would page for every
    // one-shot. So it holds, and says so in the summary.
    const { projectId, containerId } = seedApp({ serverId: "srvF" });
    setState(containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    await confirm();
    expect(openFor(projectId)).toHaveLength(1);
    h.emit.mockClear();

    h.noProbe = true;
    const blind = await tick();

    expect(blind.indeterminate).toBe(1);
    expect(blind.resolved).toBe(0);
    expect(blind.stale).toBe(0);
    expect(openFor(projectId)).toHaveLength(1);
    expect(h.emit).not.toHaveBeenCalled();

    // And nothing NEW is opened from the same non-answer either.
    const fresh = seedApp({ serverId: "srvF" });
    setState(fresh.containerId, "exited", { exitCode: 1, restartPolicy: "always" });
    const second = await tick();
    const third = await tick();

    expect(second.pending + third.pending).toBe(0);
    expect(third.opened).toBe(0);
    expect(openFor(fresh.projectId)).toHaveLength(0);

    // The probe comes back → the fault is judged on its own merits, from scratch.
    h.noProbe = false;
    expect((await confirm()).opened).toBe(1);
    expect(openFor(fresh.projectId)).toHaveLength(1);
  });
});

// ─── The restart baseline ────────────────────────────────────────────────────

describe("the restart window", () => {
  it("ignores a baseline too old to say anything about now", async () => {
    // A workload absent from a tick keeps its MEMORY entry, so without a ceiling the
    // first observation after a long silence reads an hour of ordinary restarts as
    // one window's worth. RESTART_STALE_MS is 3 minutes.
    const { projectId, containerId } = seedApp();
    setState(containerId, "running", { restartCount: 5 });
    await tick();

    // Gate 1 skips it without retiring it, so the baseline is KEPT, not pruned —
    // the ceiling below is the only thing standing between it and a false page.
    const dep = h.deployments.find((d) => d.projectId === projectId)!;
    dep.status = "building";
    await tick({ afterMs: 200_000 });
    dep.status = "ready";

    setState(containerId, "running", { restartCount: 60 });
    const summary = await tick();

    expect(summary.pending).toBe(0);
    expect(summary.opened).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
  });
});

// ─── What the watch remembers between observations ───────────────────────────

describe("watch memory", () => {
  it("forgets a workload that stops being watched", async () => {
    // MEMORY is process-lifetime by design, so an entry nobody will ask about again
    // is a leak on a churning instance — and worse than a leak if the same container
    // comes back: a baseline from before it was unwatched reads its whole absence as
    // one window of restarts.
    const { projectId, containerId } = seedApp();
    setState(containerId, "running", { restartCount: 5 });
    await tick();

    h.projects.find((p) => p.id === projectId)!.disabledAt = new Date();
    await tick();

    // Re-enabled, with a restart history accumulated while nobody was watching.
    // Against the stale baseline of 5 this is a delta of 55 — CRASH_RESTART_DELTA is
    // 3 — and it is only 10s old, so RESTART_STALE_MS would not have caught it.
    h.projects.find((p) => p.id === projectId)!.disabledAt = null;
    setState(containerId, "running", { restartCount: 60 });
    const summary = await tick();

    expect(summary.pending).toBe(0);
    expect(summary.opened).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);
  });

  it("forgets a workload whose project drops out of the scan", async () => {
    // The prune's other blind spot, and the one with no incident to reap: a project
    // filtered out of the scan (soft-deleted, or past its row cap) is in neither
    // `retired` nor `swept`, so a HEALTHY workload's entry was never reachable at all
    // and stayed for the life of the process.
    seedApp(); // keeps the scan non-empty
    const { projectId, containerId } = seedApp();
    setState(containerId, "running", { health: "unhealthy" });
    await tick(); // one observation of the fault

    const row = h.projects.find((p) => p.id === projectId)!;
    h.projects = h.projects.filter((p) => p.id !== projectId);
    await tick();

    // Back in the scan, still unhealthy. This is the FIRST observation again: the tick
    // that dropped it forgot the counter, so it cannot be the second one. That costs a
    // tick of latency, which is the right trade — a project the scan stops returning is
    // not coming back in a minute, and "seen twice" has to mean twice while watched.
    h.projects = [...h.projects, row];
    const back = await tick();
    expect(back.opened).toBe(0);
    expect(openFor(projectId)).toHaveLength(0);

    // And it still confirms on the next one — forgotten, not suppressed.
    expect((await tick()).opened).toBe(1);
    expect(emitted("service.unhealthy")).toHaveLength(1);
  });

  it("keeps the counters of a workload it merely could not read", async () => {
    // The other half of the prune: a project skipped for an unreachable box is not a
    // project that stopped being watched. Throwing its agreement counter away would
    // cost a tick of detection latency the moment the box answers again.
    const { projectId, containerId } = seedApp({ serverId: "srvD" });
    setState(containerId, "exited", { exitCode: 1 });
    expect((await tick()).pending).toBe(1);

    h.listThrows = "connect ETIMEDOUT 10.0.0.4:22";
    await tick();
    h.listThrows = null;

    // First observation after the box comes back — and it is the SECOND observation
    // of the fault, so it confirms immediately rather than starting over.
    expect((await tick()).opened).toBe(1);
    expect(emitted("service.down")).toHaveLength(1);
    expect(openFor(projectId)).toHaveLength(1);
  });
});

// ─── Two observations, not two calls ─────────────────────────────────────────

describe("confirmation needs time, not just a second look", () => {
  it("does not confirm a fault from a burst of observations in one instant", async () => {
    const { projectId, containerId } = seedApp();
    setState(containerId, "exited", { exitCode: 1 });

    // A single `docker stop` emits kill+die+stop, and a redeploy four events per
    // container. Once events can drive a sweep, four observations can land inside a
    // second — and without a time floor that alone satisfies AGREE_TICKS, so "must
    // be seen twice" would quietly become "must be seen twice, possibly at once".
    for (let i = 0; i < 4; i++) {
      const burst = await tick({ afterMs: 200 });
      expect(burst.opened).toBe(0);
      expect(burst.pending).toBe(1);
    }
    expect(openFor(projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();

    // Far enough from the first observation to be a second one.
    expect((await tick({ afterMs: 4_000 })).opened).toBe(1);
    expect(emitted("service.down")).toHaveLength(1);
  });
});

// ─── An event-accelerated run reads one box ──────────────────────────────────

describe("filtered run", () => {
  it("observes only the named box and leaves the others exactly as they were", async () => {
    const a = seedApp({ serverId: "srvA" });
    const b = seedApp({ serverId: "srvB" });
    setState(a.containerId, "exited", { exitCode: 1 });
    await confirm();
    expect(openFor(a.projectId)).toHaveLength(1);
    h.emit.mockClear();

    setState(b.containerId, "exited", { exitCode: 1 });
    const summary = await tick({ onlyServerKeys: new Set([await groupKey("srvB")]) });

    expect(summary.servers).toBe(1);
    // One observation of B's fault: seen, not yet confirmed. This is the number the
    // accelerator reads to decide it should take the second observation itself.
    expect(summary.pending).toBe(1);
    expect(summary.opened).toBe(0);
    // And A is untouched — not resolved, not stale-closed, not re-paged.
    expect(summary.resolved).toBe(0);
    expect(summary.stale).toBe(0);
    expect(openFor(a.projectId)).toHaveLength(1);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("leaves a retired project's stale incident for the next full sweep", async () => {
    const a = seedApp({ serverId: "srvA" });
    seedApp({ serverId: "srvB" });
    setState(a.containerId, "exited", { exitCode: 1 });
    await confirm();
    h.emit.mockClear();

    // A is disabled, so a full sweep closes its incident silently. A filtered run of
    // another box must not: reaping reasons over EVERY open incident against sets
    // this run only populated for one group.
    h.projects.find((p) => p.id === a.projectId)!.disabledAt = new Date();

    const filtered = await tick({ onlyServerKeys: new Set([await groupKey("srvB")]) });
    expect(filtered.stale).toBe(0);
    expect(openFor(a.projectId)).toHaveLength(1);

    const full = await tick();
    expect(full.stale).toBe(1);
    expect(openFor(a.projectId)).toHaveLength(0);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("round-trips its group key", async () => {
    // The accelerator parses keys the sweep built, and container-events.test.ts
    // mirrors this pair to stay off the sweep's module graph. Both rely on the
    // round-trip holding — including for the local daemon, whose id is null.
    const { watchGroupKey, parseWatchGroupKey } = await import("./health-watch");
    for (const serverId of ["srv1", null]) {
      expect(parseWatchGroupKey(watchGroupKey(serverId, "org1"))).toEqual({
        serverId,
        organizationId: "org1",
      });
    }
    // A key with no org is not a group — the accelerator must not subscribe to it.
    expect(parseWatchGroupKey("srv1").organizationId).toBe("");
  });

  it("renews the event leases on a full sweep and never on a filtered one", async () => {
    seedApp({ serverId: "srvA" });
    const key = await groupKey("srvA");

    await tick();
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.renew.mock.calls[0]?.[0]).toContain(key);

    h.renew.mockClear();
    await tick({ onlyServerKeys: new Set([key]) });
    // The accelerator's own sweeps are filtered. If they renewed, subscriptions
    // would keep themselves alive and turning the health-watch job off would never
    // drain the streams.
    expect(h.renew).not.toHaveBeenCalled();
  });
});
