/**
 * Server managed-CONTAINER status + apply service.
 *
 * The container sibling of `server-modules.service.ts` (host-native modules).
 * Detection: for each connected server, read the image ref the edge/mail
 * container is running and compare it to the ref this control plane PINS
 * (`pinnedEdgeImage`/`pinnedMailImage`, both tied to APP_VERSION). Drift is a
 * plain tag mismatch — no catalog dry-run, no registry digest probe — because
 * infra images are version-pinned. Results cache into `server_container_status`
 * so the Components tab reads a table. Apply reuses the rollback-guarded swaps:
 * `reconcileServerEdge` / `reconcileServerMail`.
 *
 * edge = a LIVE probe (`resolveOurEdgeContainer`, present on every box);
 * mail = a DB row (`repos.mailServer`, mail boxes only) confirmed live.
 */

import { repos, type Server, type ServerContainerComponent } from "@repo/db";
import {
  dockerAvailable,
  detectMailEngine,
  detectEdgeContainer,
  probeEdge,
  type CommandExecutor,
  type SystemLog,
} from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { sshManager } from "../../lib/ssh-manager";
import { pinnedEdgeImage } from "../../lib/edge-image";
import { pinnedMailImage } from "../../lib/mail-image";
import { reconcileServerEdge } from "../../lib/edge-reconcile";
import { reconcileServerMail, repairServerMail } from "../../lib/mail-reconcile";
import { mapWithLimit } from "../../lib/map-with-limit";
import {
  advanceStep,
  appendContainerLog,
  createContainerApplySession,
  finishContainerApplySession,
  getActiveContainerApplySession,
  type ContainerApplyResult,
  type ContainerApplySession,
} from "../../lib/server-container-session";

export interface ServerContainerView {
  component: ServerContainerComponent;
  /** Image ref the container is currently running (null when down). */
  runningLabel: string | null;
  /** Image ref this control plane pins for the component (the target). */
  pinnedLabel: string;
  /** Running image TAG (e.g. "0.4.0") — the version on the box. Null if untagged. */
  runningVersion: string | null;
  /** Pinned image TAG (e.g. "0.5.0") — the version it should run. */
  pinnedVersion: string | null;
  /** runningLabel !== pinnedLabel while running — an update is available. */
  behind: boolean;
  /** The component is provisioned but its container isn't running. */
  down: boolean;
  /**
   * Down AND the container is gone rather than merely stopped. A stopped container
   * is startable in place (the one-click repair); a missing one needs its setup
   * path (secrets/config this service doesn't hold), so the UI must not offer a fix.
   */
  containerMissing: boolean;
  /**
   * Which shape of the component this box runs. `mail` only, and only ever `host`
   * on a LEGACY pre-containerization install (see `detectMailEngine`): there is no
   * image on that flavor, so version/drift are meaningless and the UI must label it
   * rather than show a blank running version. Omitted for the edge, which is a
   * container on every box.
   */
  flavor?: "container" | "host";
}

/**
 * The VERSION portion of a Docker image ref, for display. The tag is the part
 * after the last `:` that follows the last `/` — so a registry port
 * (`host:5000/img:tag`) is not mistaken for the tag, and a digest (`img@sha256:…`)
 * yields the tag before `@` or null. Returns null when the ref carries no tag.
 */
export function imageTag(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const atless = ref.split("@")[0]!;
  const lastSlash = atless.lastIndexOf("/");
  const namePart = lastSlash === -1 ? atless : atless.slice(lastSlash + 1);
  const colon = namePart.lastIndexOf(":");
  if (colon === -1) return null;
  return namePart.slice(colon + 1) || null;
}

export interface ApplyContainerResult {
  component: ServerContainerComponent;
  /** True when the swap replaced a running container with a new image. */
  updated: boolean;
  /**
   * The swap failed AND its rollback failed — nothing is serving this
   * component on the box. Distinct from `updated:false` ("already current").
   */
  down: boolean;
  /**
   * Why the apply did not do what it was asked to. `updated:false, down:false` is
   * ALSO what "already current, nothing to do" looks like, so without this an edge
   * that refused to install (no takeover consent on a contested box) finished the
   * session as `completed` — the green-banner-over-a-dead-edge bug. Set ⇒ the apply
   * failed, whatever `down` says.
   */
  error?: string;
}

// ─── Detection (per component, given a live executor) ─────────────────────────

/**
 * A component probe outcome. The three-way split is what keeps the drift cache
 * honest:
 *   - `present` → the component is installed (running OR stopped); upsert its row.
 *   - `absent`  → the probe RAN and the component is genuinely not here; drop the
 *     row. A trustworthy state change, safe to write.
 *   - `unknown` → the probe couldn't tell (a `docker ps`/`inspect` that errored
 *     out under a reachable daemon, an SSH hiccup). Leave the last-known cached
 *     row exactly as it is — never upsert a guess, never delete.
 *
 * The bug this exists to prevent: collapsing `unknown` into `absent` let one
 * transient probe failure DELETE a live component's cached row (the "scan wiped
 * my components" symptom). The cache is written on the happy path only.
 */
type ContainerProbe =
  | { kind: "present"; view: ServerContainerView }
  | { kind: "absent" }
  | { kind: "unknown" };

/**
 * Track the edge whenever it's INSTALLED, not only when it's running:
 * `detectEdgeContainer` (`docker ps -a`) resolves a stopped edge too, so a
 * provisioned-but-down edge is reported `present` + `down` (kept in the cache)
 * instead of vanishing. `detectEdgeContainer` returns `null` when the probe itself
 * failed — we map that to `unknown` (keep the cache), NOT to absence.
 */
async function detectEdge(executor: CommandExecutor): Promise<ContainerProbe> {
  const detected = await detectEdgeContainer(executor).catch(() => null);
  if (detected === null) return { kind: "unknown" };
  if (!detected.exists) return { kind: "absent" };
  const pinnedLabel = pinnedEdgeImage();
  return {
    kind: "present",
    view: {
      component: "edge",
      runningLabel: detected.image,
      pinnedLabel,
      runningVersion: imageTag(detected.image),
      pinnedVersion: imageTag(pinnedLabel),
      behind: detected.running && detected.image !== pinnedLabel,
      down: !detected.running,
      // `present` already implies the container exists (absence is its own probe
      // result), so a down edge is always a stopped one — never a missing one.
      containerMissing: false,
    },
  };
}

/**
 * Mail presence is a DB fact (`repos.mailServer` — the box was set up for mail),
 * confirmed against the live engine. No record → the box was never a mail box,
 * so `absent` (drop the row). With a record it's `present`; a provisioned-but-not-
 * running engine is reported `down` (not `behind`): reconcileServerMail is
 * swap-only and won't act on a stopped engine, so nudging an update would mislead.
 * Presence is decided by the DB (trustworthy), so mail never returns `unknown`.
 *
 * Which ENGINE it has comes from the one topology probe (`detectMailEngine`), not
 * from a container lookup — a legacy host-native install has no container, and
 * asking docker about it is what made a box that is quietly delivering mail render
 * as "Stopped · container missing" with no way out. On that flavor there is no
 * image to compare, so `behind` is false by construction (a legacy box migrates
 * through mail setup, not through an image swap) and the row carries `flavor:
 * "host"` so the UI can say "not containerized" instead of inventing a version.
 *
 * A down engine splits further on `exists`: a STOPPED engine is startable in place
 * (`repairServerMail`, both flavors), a MISSING one needs the mail-setup path —
 * hence `containerMissing`, which decides whether the UI offers a one-click fix.
 */
async function detectMail(
  executor: CommandExecutor,
  server: Server,
): Promise<ContainerProbe> {
  const record = await repos.mailServer.get(server.id).catch(() => undefined);
  if (!record) return { kind: "absent" };
  const probe = await detectMailEngine(executor).catch(() => null);
  const pinnedLabel = pinnedMailImage();
  const base = {
    component: "mail" as const,
    pinnedLabel,
    pinnedVersion: imageTag(pinnedLabel),
  };

  if (probe?.flavor === "host") {
    return {
      kind: "present",
      view: {
        ...base,
        runningLabel: null,
        runningVersion: null,
        behind: false,
        down: !probe.running,
        containerMissing: false,
        flavor: "host",
      },
    };
  }

  if (!probe || probe.flavor === "none") {
    // No engine of either shape. That's only a CONCLUSION if Docker actually
    // answered: with an unreachable daemon "no container" is a failed probe, and
    // writing it would flip a healthy mail box to "Stopped · container missing".
    if (!(await dockerAvailable(executor).catch(() => false))) return { kind: "unknown" };
    return {
      kind: "present",
      view: {
        ...base,
        runningLabel: null,
        runningVersion: null,
        behind: false,
        down: true,
        containerMissing: true,
        flavor: "container",
      },
    };
  }

  return {
    kind: "present",
    view: {
      ...base,
      runningLabel: probe.image,
      runningVersion: imageTag(probe.image),
      behind: probe.running && probe.image !== pinnedLabel,
      down: !probe.running,
      containerMissing: !probe.running && !probe.exists,
      flavor: "container",
    },
  };
}

function upsertView(server: Server, view: ServerContainerView, lastError?: string): Promise<void> {
  // `flavor: "host"` is persisted even for a perfectly healthy row: it is what the
  // UI reads to label a legacy box instead of rendering a blank running version.
  const legacy = view.flavor === "host";
  const detail =
    view.down || lastError || legacy
      ? {
          ...(view.down ? { down: true } : {}),
          ...(view.containerMissing ? { containerMissing: true } : {}),
          ...(legacy ? { flavor: "host" as const } : {}),
          ...(lastError ? { lastError } : {}),
        }
      : null;
  return repos.serverContainerStatus.upsert({
    organizationId: server.organizationId ?? null,
    serverId: server.id,
    component: view.component,
    runningLabel: view.runningLabel,
    pinnedLabel: view.pinnedLabel,
    runningVersion: view.runningVersion,
    pinnedVersion: view.pinnedVersion,
    behind: view.behind,
    latestInProgress: false,
    detail,
  });
}

/**
 * Detect edge + mail drift on one server (no image swap), caching each present
 * component and dropping the row for any CONFIDENTLY absent one. Best-effort.
 *
 * The cache is mutated on the happy path only. Two guards keep a bad read from
 * corrupting it:
 *   - Docker gate: a box with no reachable Docker runs none of our containers, so
 *     we neither upsert nor remove — the whole probe is inconclusive, leave the
 *     cache alone.
 *   - per-component `unknown`: even with Docker up, a `docker ps`/`inspect` can
 *     fail transiently; `detectEdge`/`detectMail` report that as `unknown` and we
 *     skip the write, so a hiccup can never DELETE a live component's row (the
 *     scan-wiped-my-components bug). Only a probe that actually confirmed absence
 *     removes the row.
 */
export async function detectServerContainers(server: Server): Promise<ServerContainerView[]> {
  const views: ServerContainerView[] = [];
  await sshManager.withExecutor(server.id, async (executor) => {
    const cacheProbe = async (
      component: ServerContainerComponent,
      probe: ContainerProbe,
    ): Promise<void> => {
      if (probe.kind === "present") {
        views.push(probe.view);
        await upsertView(server, probe.view).catch(() => {});
      } else if (probe.kind === "absent") {
        await repos.serverContainerStatus.remove(server.id, component).catch(() => {});
      }
      // "unknown" → leave the last-known cached row untouched.
    };

    // The edge is a container on EVERY box, so with no reachable Docker there is
    // nothing to conclude about it — leave its cached row alone.
    if (await dockerAvailable(executor).catch(() => false)) {
      await cacheProbe(
        "edge",
        await detectEdge(executor).catch((): ContainerProbe => ({ kind: "unknown" })),
      );
    }
    // Mail is NOT necessarily a container (a legacy box runs systemd units), so its
    // probe runs regardless — a box without Docker is exactly where that flavor
    // lives. `detectMail` does its own Docker check before concluding "no engine".
    await cacheProbe(
      "mail",
      await detectMail(executor, server).catch((): ContainerProbe => ({ kind: "unknown" })),
    );
  });
  return views;
}

// ─── Apply (rollback-guarded image swap / start-in-place repair) ──────────────

/**
 * What an apply is for. `update` swaps onto the pinned image (the drift path);
 * `repair` brings a STOPPED container back up without touching its config — the
 * fix for a box whose component isn't serving, which no amount of updating solves.
 */
export type ContainerApplyIntent = "update" | "repair";

/**
 * Converge one server's edge or mail container: swap onto the pinned image
 * (`update`) or start a stopped one back up (`repair`). `onLog` streams the
 * underlying helper's step/pull/verify lines to an SSE session.
 *
 * The reconcile helpers are best-effort and never throw (they report `edgeDown` /
 * `mailDown` on the failed-swap-AND-failed-rollback path), so this returns a
 * structured outcome rather than raising — the sole throw is "no mail server
 * provisioned", which the caller maps to a 4xx.
 *
 * `repair` + edge deliberately routes to the SAME `reconcileServerEdge`: a stopped
 * edge isn't resolved by `resolveOurEdgeContainer` (running-only), so the reconcile
 * already falls through to its recreate path. Only mail needs a distinct helper,
 * because its update path is swap-only by design (secrets).
 */
export async function applyServerContainer(
  server: Server,
  component: ServerContainerComponent,
  onLog?: (log: SystemLog) => void,
  intent: ContainerApplyIntent = "update",
): Promise<ApplyContainerResult> {
  await repos.serverContainerStatus.setInProgress(server.id, component, true).catch(() => {});
  try {
    return await sshManager.withExecutor(server.id, async (executor) => {
      const log = (l: SystemLog) => onLog?.(l);
      let outcome: ApplyContainerResult;

      // Both reconciles deliver a dev/from-source image before bring-up: they build it
      // on THIS box (the executor is the target), or ship + build for a remote one — no
      // server identity needed, the executor is the only handle required.
      if (component === "edge") {
        const r = await reconcileServerEdge(executor, { onLog: log });
        outcome = { component, updated: r.updated, down: r.edgeDown, ...(r.error ? { error: r.error } : {}) };
      } else if (intent === "repair") {
        const r = await repairServerMail(executor, { onLog: log });
        outcome = { component, updated: r.started, down: r.mailDown, ...(r.reason ? { error: r.reason } : {}) };
      } else {
        const record = await repos.mailServer.get(server.id);
        if (!record) throw new Error("no mail server is provisioned on this server");
        const r = await reconcileServerMail(executor, { onLog: log, domain: record.domain });
        outcome = { component, updated: r.updated, down: r.mailDown, ...(r.error ? { error: r.error } : {}) };
      }

      // The reconcile's OWN reason beats the generic sentence: "no takeover consent"
      // or an nginx `[emerg]` is something the operator can act on, "the update
      // failed" is not. Falls back to the shape-based copy when there's no reason
      // (an `edgeDown`/`mailDown` reported by a rollback-guarded swap).
      await cacheAfterAction(
        server,
        executor,
        component,
        outcome.error ??
          (outcome.down
            ? intent === "repair"
              ? "the container could not be started — see logs"
              : "the update failed and the container is down — see logs"
            : undefined),
      );
      return outcome;
    });
  } finally {
    await repos.serverContainerStatus.setInProgress(server.id, component, false).catch(() => {});
  }
}

/**
 * Re-read one component's LIVE state into its cached row, right after something
 * acted on it. The single post-action cache write, shared by the apply service and
 * the first-install stream.
 *
 * Two rules, both deliberate:
 *  - only a `present` probe rewrites the row — an inconclusive read leaves the
 *    pre-action row in place rather than guessing;
 *  - never REMOVE here. We just acted on this box, so "the probe says absent" is far
 *    more likely to be a probe that lost the race than a component that vanished;
 *    dropping the row would erase the very issue the operator is trying to fix.
 *    `detectServerContainers` (the scan) owns removal.
 */
async function cacheAfterAction(
  server: Server,
  executor: CommandExecutor,
  component: ServerContainerComponent,
  lastError?: string,
): Promise<void> {
  const probe =
    component === "edge"
      ? await detectEdge(executor).catch((): ContainerProbe => ({ kind: "unknown" }))
      : await detectMail(executor, server).catch((): ContainerProbe => ({ kind: "unknown" }));
  if (probe.kind === "present") await upsertView(server, probe.view, lastError).catch(() => {});
}

/**
 * `cacheAfterAction` for a caller that holds a serverId and no executor — the
 * first-install stream (`POST /system/install/stream`), which is how "Fix edge"
 * reaches a box whose edge needs 80/443 takeover consent.
 *
 * It exists because that stream installed the edge and then told nobody: the cached
 * `server_container_status` row still said `down`, so the home page kept the "Edge
 * down" card after a SUCCESSFUL install (and the dropped-connection fallback,
 * which reads that row back, called a good install a failure). The next `infra:scan`
 * would have corrected it — minutes to an hour later, long after the operator
 * refreshed and concluded the fix does nothing.
 *
 * Best-effort: the install's own outcome is already reported, and a cache write must
 * never turn a finished install into a failed one.
 */
export async function refreshServerContainer(
  serverId: string,
  component: ServerContainerComponent,
  lastError?: string,
): Promise<void> {
  try {
    const server = await repos.server.get(serverId);
    if (!server) return;
    await sshManager.withExecutor(serverId, (executor) =>
      cacheAfterAction(server, executor, component, lastError),
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Start (or re-attach to) a watchable apply for one (server, component). Returns
 * the replayable session immediately plus a `done` promise for the outcome — the
 * manual stream subscribes to the session and lets the swap run in the
 * background; the auto path awaits `done` for its tally. One running session per
 * (server, component): a second caller reuses the in-flight one, so the manual
 * "Update" click and the boot auto-update can never double-swap the same box.
 *
 * The swap runs detached from any single client: the session (and its logs)
 * outlive a dropped stream, so a reconnecting modal replays the full progress.
 *
 * The dedup key stays (serverId, component) — NOT the intent — so an operator's
 * repair click and the boot sweep's update can never act on the same container at
 * once; the second caller watches the first one's session.
 */
export function runContainerApply(
  server: Server,
  component: ServerContainerComponent,
  intent: ContainerApplyIntent = "update",
): { session: ContainerApplySession; done: Promise<ContainerApplyResult> } {
  const existing = getActiveContainerApplySession(server.id, component);
  if (existing?.donePromise) return { session: existing, done: existing.donePromise };

  const session = createContainerApplySession(server.id, component);
  const done = (async (): Promise<ContainerApplyResult> => {
    try {
      const result = await applyServerContainer(
        server,
        component,
        (l) => {
          appendContainerLog(session.id, l.message, l.level);
          advanceStep(session.id, l.message);
        },
        intent,
      );
      // `error` fails the session even when the box is still serving (a refused
      // takeover leaves the old proxy up, so `down` is false and honest — but the
      // apply did NOT do what the operator asked, and reporting `completed` is what
      // put a green banner over an edge that had never bound :80).
      const failed = result.down || Boolean(result.error);
      finishContainerApplySession(
        session.id,
        failed ? "failed" : "completed",
        { updated: result.updated, down: result.down },
        failed
          ? (result.error ??
            (intent === "repair"
              ? "The container could not be started — see logs."
              : "The update failed and the container is down — see logs."))
          : undefined,
      );
      return { updated: result.updated, down: result.down };
    } catch (err) {
      const message = safeErrorMessage(err);
      appendContainerLog(session.id, message, "error");
      finishContainerApplySession(session.id, "failed", undefined, message);
      return { updated: false, down: false };
    }
  })();
  session.donePromise = done;
  return { session, done };
}

/**
 * Detect-only refresh across ONE org's servers — the org-scoped, no-apply sibling
 * of `scanInstanceContainers` that backs the manual Infrastructure-tab "Scan".
 * Never applies (that stays with the toggle-gated boot/cron sweep), so a manual
 * scan can't race the auto-update path; the shared `server_container_status` cache
 * absorbs the idempotent upserts. Best-effort per server — one unreachable box is
 * skipped, not fatal. Returns the refreshed grouped view for immediate render.
 *
 * Detection runs bounded-concurrently: each box costs a (possibly cold) SSH
 * connect plus 2–4 execs, so a serial sweep over a 15-server fleet outruns the
 * dashboard's request timeout. Probes only read, so fanning them out is safe —
 * unlike applies, which restart :80/:443 and stay serial.
 */
const SCAN_CONCURRENCY = 4;

export async function scanOrgContainers(organizationId: string): Promise<
  { server: Server; views: ServerContainerView[] }[]
> {
  const servers = await repos.server.listByOrganization(organizationId);
  // Pre-seeded so the fan-out fills slots in place and the caller still gets the
  // servers in list order (mapWithLimit resolves void, not results).
  const out = servers.map((server) => ({ server, views: [] as ServerContainerView[] }));
  await mapWithLimit(out, SCAN_CONCURRENCY, async (entry) => {
    entry.views = await detectServerContainers(entry.server).catch(() => []);
  });
  return out;
}

// ─── Fleet bulk apply (the Servers-tab "Update all" / "Restart stopped") ──────

/** One (server, component) the bulk run kicked off. */
export interface BulkApplyStarted {
  serverId: string;
  serverName: string;
  component: ServerContainerComponent;
  intent: ContainerApplyIntent;
}

/**
 * Why a target the operator implicitly asked for was NOT acted on. Every reason
 * means "go to this server's own page" — either it needs a decision this endpoint
 * must not make for them, or it needs a setup path.
 */
export type BulkApplySkipReason =
  | "needs_takeover_consent"
  | "container_missing"
  | "already_running"
  | "unreachable";

export interface BulkApplySkipped {
  serverId: string;
  serverName: string;
  component: ServerContainerComponent;
  reason: BulkApplySkipReason;
}

/** How many boxes a bulk run touches at once. Each apply restarts that box's
 *  :80/:443, so this is deliberately low — a fleet-wide simultaneous swap would
 *  blink every site at the same moment. */
const BULK_APPLY_CONCURRENCY = 3;

/**
 * Update/restart every drifted or stopped managed container across one org, from
 * the CACHE — the operator's "fix the fleet" button.
 *
 * Targets are derived server-side and never taken from the client: `behind` rows
 * get an `update` (which also restarts a behind-and-down container, so behind wins
 * over repair), and rows that are merely `down` get a `repair`.
 *
 * Two classes of target are refused rather than attempted:
 * - A **missing** container — recreating it needs the secrets its setup path owns.
 * - An **edge whose box isn't clean** on 80/443. This path has no `promptUser` (a
 *   bulk run must never block on a modal), so `ensureEdgeClear` would refuse with
 *   `EdgeConflictError`. The apply now reports that refusal as a failure rather than
 *   swallowing it — but a target we KNOW would refuse shouldn't be promised in the
 *   first place, so it's pre-probed and handed back to the per-server page, where the
 *   takeover consent prompt actually exists.
 *
 * Returns as soon as the targets are classified: the applies run detached through
 * `runContainerApply`, so each one is a replayable session the operator can click
 * into for live logs, and `latestInProgress` already renders as "Updating…".
 */
export async function applyAllContainers(
  organizationId: string,
  intents: ContainerApplyIntent[] = ["update", "repair"],
): Promise<{ started: BulkApplyStarted[]; skipped: BulkApplySkipped[] }> {
  const wants = new Set(intents);
  const [servers, rows] = await Promise.all([
    repos.server.listByOrganization(organizationId),
    repos.serverContainerStatus.listByOrg(organizationId),
  ]);
  const byId = new Map(servers.map((s) => [s.id, s]));

  const started: BulkApplyStarted[] = [];
  const skipped: BulkApplySkipped[] = [];
  const queue: Array<{ server: Server; component: ServerContainerComponent; intent: ContainerApplyIntent }> = [];

  for (const row of rows) {
    const server = byId.get(row.serverId);
    if (!server) continue; // row for a server outside this org's list — ignore
    const serverName = server.name ?? server.sshHost;
    const component = row.component;
    const base = { serverId: server.id, serverName, component };

    const intent: ContainerApplyIntent | null = row.behind
      ? "update"
      : row.detail?.down
        ? "repair"
        : null;
    if (!intent || !wants.has(intent)) continue;

    if (row.latestInProgress) {
      skipped.push({ ...base, reason: "already_running" });
      continue;
    }
    if (intent === "repair" && row.detail?.containerMissing && component === "mail") {
      skipped.push({ ...base, reason: "container_missing" });
      continue;
    }
    queue.push({ server, component, intent });
  }

  // Edge repairs need the 80/443 pre-check before they're promised. Updates don't:
  // a running edge already owns the ports, so a swap never asks for consent.
  const needsProbe = queue.filter((q) => q.component === "edge" && q.intent === "repair");
  const blocked = new Set<string>();
  await mapWithLimit(needsProbe, SCAN_CONCURRENCY, async (q) => {
    const reason = await sshManager
      .withExecutor(q.server.id, async (executor) => {
        const status = await probeEdge(executor);
        return status.canProceedClean ? null : ("needs_takeover_consent" as const);
      })
      .catch(() => "unreachable" as const);
    if (!reason) return;
    blocked.add(q.server.id);
    skipped.push({
      serverId: q.server.id,
      serverName: q.server.name ?? q.server.sshHost,
      component: q.component,
      reason,
    });
  });

  const targets = queue.filter(
    (q) => !(q.component === "edge" && q.intent === "repair" && blocked.has(q.server.id)),
  );
  for (const t of targets) {
    started.push({
      serverId: t.server.id,
      serverName: t.server.name ?? t.server.sshHost,
      component: t.component,
      intent: t.intent,
    });
  }

  // Detached on purpose — the response is the classification, not the outcome.
  void mapWithLimit(targets, BULK_APPLY_CONCURRENCY, async (t) => {
    await runContainerApply(t.server, t.component, t.intent).done.catch(() => {});
  }).catch(() => {});

  return { started, skipped };
}

// ─── Instance sweep (the `infra:scan` job) ────────────────────────────────────

/**
 * Detect drift across every server, and — when the instance opted into
 * `autoUpdateInfra` — apply the behind components in the same pass. Detection is
 * always safe; the apply half only runs under the toggle. Best-effort per server
 * (an unreachable box is skipped, not fatal).
 *
 * Detection fans out (read-only probes, `SCAN_CONCURRENCY` at a time); the applies
 * that follow stay a serial loop, because each one restarts a box's :80/:443 edge
 * and a fleet-wide simultaneous swap would take every site down at once.
 */
export async function scanInstanceContainers(): Promise<{
  servers: number;
  behind: number;
  updated: number;
}> {
  const settings = await repos.instanceSettings.get().catch(() => undefined);
  const auto = Boolean(settings?.autoUpdateInfra);
  const servers = await repos.server.list();
  const detected = servers.map((server) => ({ server, views: [] as ServerContainerView[] }));
  await mapWithLimit(detected, SCAN_CONCURRENCY, async (entry) => {
    // Unreachable server / probe failure → skip, don't fail the sweep.
    entry.views = await detectServerContainers(entry.server).catch(() => []);
  });

  let behind = 0;
  let updated = 0;
  for (const { server, views } of detected) {
    const behindViews = views.filter((v) => v.behind);
    behind += behindViews.length;
    if (!auto) continue;
    for (const v of behindViews) {
      // Through runContainerApply so an operator watching the dashboard can
      // re-attach to the same session the boot hook is driving.
      const r = await runContainerApply(server, v.component).done.catch(() => null);
      if (r?.updated) updated++;
    }
  }
  return { servers: servers.length, behind, updated };
}

// ─── Issue rollup (the attention dot + home surface) ─────────────────────────

/** A managed component that needs hands-on action. */
export type EdgeIssue = "down" | "absent";

/** One (server, component) pair needing action — the unit the fix buttons act on. */
export interface ContainerIssue {
  server: { id: string; name: string };
  component: ServerContainerComponent;
  issue: EdgeIssue;
  /**
   * Down AND the container is gone rather than stopped, so the fix is the
   * component's setup path (which holds its secrets), not a one-click start. The
   * edge recreates itself from the install path, so this only gates mail.
   */
  containerMissing: boolean;
  /**
   * The last failure this component recorded — a repair or update that left it
   * down. Absent when the component is merely stopped: there is no error to
   * report and the state IS the story. Surfaced so the attention surface can name
   * a cause instead of repeating a generic "is down".
   */
  reason?: string;
}

export interface ContainerIssuesResult {
  /** Issue COUNT (a box with a down edge and a down mail engine contributes two). */
  total: number;
  servers: ContainerIssue[];
  edgeDown: number;
  edgeMissing: number;
  mailDown: number;
}

/** The subset of a server the issue rollup reads. */
interface IssueServer {
  id: string;
  name?: string | null;
  sshHost: string;
}
/** The subset of a cached container row the issue rollup reads. */
interface IssueRow {
  serverId: string;
  component: ServerContainerComponent;
  detail?: { down?: boolean; containerMissing?: boolean; lastError?: string | null } | null;
}

/**
 * Classify each server's managed components into actionable issues, purely from
 * the cached rows + the active-deployment→server project attribution.
 *
 * An edge is an issue when it's `down` (installed, not running) or ABSENT on a box
 * that actually hosts projects (projectCounts > 0) — absent on an empty box is an
 * offer, not an alarm. A mail engine is an issue only when a TRACKED row says it's
 * down: mail is optional per box, so no row means no mail here (never an alarm),
 * but a provisioned engine that stopped means mail isn't being delivered.
 *
 * `behind` (an update is available) is never an issue — that's the separate updates
 * surface. Pure: the controller owns the reads so this stays trivially testable and
 * shares its rule with the grouped view.
 */
export function classifyContainerIssues(
  servers: IssueServer[],
  rows: IssueRow[],
  projectCounts: Record<string, number>,
): ContainerIssuesResult {
  const byServer = new Map<string, IssueRow[]>();
  for (const r of rows) {
    (byServer.get(r.serverId) ?? byServer.set(r.serverId, []).get(r.serverId)!).push(r);
  }
  const issues: ContainerIssue[] = [];
  let edgeDown = 0;
  let edgeMissing = 0;
  let mailDown = 0;
  for (const s of servers) {
    const own = byServer.get(s.id) ?? [];
    const server = { id: s.id, name: s.name ?? s.sshHost };

    const edgeRow = own.find((r) => r.component === "edge");
    if (edgeRow?.detail?.down) {
      edgeDown++;
      issues.push({
        server,
        component: "edge",
        issue: "down",
        containerMissing: Boolean(edgeRow.detail.containerMissing),
        ...(edgeRow.detail.lastError ? { reason: edgeRow.detail.lastError } : {}),
      });
    } else if (!edgeRow && (projectCounts[s.id] ?? 0) > 0) {
      edgeMissing++;
      issues.push({ server, component: "edge", issue: "absent", containerMissing: true });
    }

    const mailRow = own.find((r) => r.component === "mail");
    if (mailRow?.detail?.down) {
      mailDown++;
      issues.push({
        server,
        component: "mail",
        issue: "down",
        containerMissing: Boolean(mailRow.detail.containerMissing),
        ...(mailRow.detail.lastError ? { reason: mailRow.detail.lastError } : {}),
      });
    }
  }
  return { total: issues.length, servers: issues, edgeDown, edgeMissing, mailDown };
}

/**
 * The three cached reads `classifyContainerIssues` needs, for one org.
 *
 * Lives here rather than in the controller because it now has two callers — the
 * `/containers/issues` endpoint and the global issue feed — and "which reads feed
 * the classifier" is exactly the kind of thing that drifts when it's copied. Pure
 * cache reads (no probe), so it stays cheap enough for both surfaces.
 */
export async function loadOrgContainerIssues(
  organizationId: string,
): Promise<ContainerIssuesResult> {
  const [servers, rows, projectCounts] = await Promise.all([
    repos.server.listByOrganization(organizationId),
    repos.serverContainerStatus.listByOrg(organizationId),
    repos.project.countActiveByServer(organizationId),
  ]);
  return classifyContainerIssues(servers, rows, projectCounts);
}
