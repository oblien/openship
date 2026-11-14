import { and, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { discoveryBinding as binding, discoverySettings as settings, domain } from "../schema";
import type { DiscoveryDeclaration } from "@repo/core";

export type DiscoverySettings = typeof settings.$inferSelect;
export type DiscoveryBinding = typeof binding.$inferSelect;

/** One scanned container's confirmed observation, from the core parser + runtime view. */
export interface DiscoveryObservation {
  serviceKey: string;
  containerId: string;
  containerName?: string | null;
  /** Fresh `State.Running` from the scan — the certificate queue filter. */
  running: boolean;
  hostname: string;
  port: number;
  /** Selected bridge network, when the declaration has one (null = published-only). */
  networkName?: string | null;
  networkId?: string | null;
  ipAddress?: string | null;
  /** Resolved upstream strategy for this observation (see binding column docs). */
  upstreamStrategy?: "network-ip" | "published-port" | null;
  hostPort?: number | null;
  hostIp?: string | null;
  configHash: string;
  composeProject?: string | null;
  composeService?: string | null;
}

type SettingsPatch = Partial<
  Pick<DiscoverySettings, "enabled" | "workspaceId" | "sweepIntervalSeconds">
>;

/**
 * Discovery persistence (docs/docker-service-discovery-plan.md, step 3).
 *
 * Observations are the scanner's single upsert path per container. Identity
 * (serverId + serviceKey) is unique: a replacement container updates the
 * observation of the SAME binding; a config change bumps the desired
 * generation and marks the apply pending; an unchanged rescan touches nothing
 * the reconciler would act on. Removal is explicit — a failed scan never
 * classifies every service as missing.
 */
export function createDiscoveryRepo(db: Database) {
  return {
    // ── Settings ────────────────────────────────────────────────────────

    getSettings(serverId: string) {
      return db.query.discoverySettings.findFirst({ where: eq(settings.serverId, serverId) });
    },

    /** Configure (or implicitly create) the settings row. Discovery starts OFF. */
    async configure(serverId: string, patch: SettingsPatch) {
      const now = new Date();
      const [row] = await db
        .insert(settings)
        .values({ serverId, ...patch, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.serverId,
          set: { ...patch, updatedAt: now },
        })
        .returning();
      return row;
    },

    /** Clear the workspace binding (organization-level visibility). */
    async unbindWorkspace(serverId: string) {
      await db
        .update(settings)
        .set({ workspaceId: null, updatedAt: new Date() })
        .where(eq(settings.serverId, serverId));
    },

    async recordScan(serverId: string, result: { ok: true } | { ok: false; error: string }) {
      await db
        .update(settings)
        .set({
          lastScanAt: new Date(),
          ...(result.ok ? { lastScanError: null } : { lastScanError: result.error }),
          updatedAt: new Date(),
        })
        .where(eq(settings.serverId, serverId));
    },

    /** Enabled servers for watcher/sweep registration. */
    listEnabledServerIds() {
      return db
        .select({ serverId: settings.serverId })
        .from(settings)
        .where(eq(settings.enabled, true));
    },

    /**
     * Servers needing a sweep: every enabled server, PLUS disabled servers that
     * still owe route withdrawals (disable scheduled retirement — the sweep
     * must run reconcile for them even though scan/apply/repair stay gated).
     */
    async listSweepableServerIds() {
      const enabled = await db
        .select({ serverId: settings.serverId })
        .from(settings)
        .where(eq(settings.enabled, true));
      const owing = await db
        .selectDistinct({ serverId: binding.serverId })
        .from(binding)
        .where(eq(binding.withdrawalPending, true));
      const seen = new Set(enabled.map((r) => r.serverId));
      for (const row of owing) seen.add(row.serverId);
      return [...seen].map((serverId) => ({ serverId }));
    },

    // ── Bindings ────────────────────────────────────────────────────────

    getBinding(serverId: string, serviceKey: string) {
      return db.query.discoveryBinding.findFirst({
        where: and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)),
      });
    },

    getBindingById(id: string) {
      return db.query.discoveryBinding.findFirst({ where: eq(binding.id, id) });
    },

    listByServer(serverId: string) {
      return db
        .select()
        .from(binding)
        .where(eq(binding.serverId, serverId))
        .orderBy(binding.serviceKey);
    },

    /**
     * Upsert one scanned container's observation. Returns the binding row plus
     * two flags the reconciler acts on:
     *  - `desiredChanged`: the DECLARED config changed (hash differs) — bump
     *    generation, reset retries, apply from scratch;
     *  - `requeued`: the RUNTIME TARGET changed (container id, IP on the
     *    selected network, or running→stopped/started→running) while config is
     *    unchanged — the route must be re-applied (new upstream, or upstream
     *    withdrawal on stop), so the binding returns to the pending queue.
     * Both bump the desired generation: it versions "what an apply must
     * converge to", and routes target the container/IP, not just the config.
     */
    async observe(serverId: string, observation: DiscoveryObservation) {
      return db.transaction(async (tx) => {
        const now = new Date();
        const desired = {
          hostname: observation.hostname,
          port: observation.port,
          networkName: observation.networkName,
          networkId: observation.networkId ?? null,
          configHash: observation.configHash,
        };
        const [existing] = await tx
          .select()
          .from(binding)
          .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, observation.serviceKey)))
          .for("update");
        if (!existing) {
          const [row] = await tx
            .insert(binding)
            .values({
              serverId,
              serviceKey: observation.serviceKey,
              composeProject: observation.composeProject ?? null,
              composeService: observation.composeService ?? null,
              containerId: observation.containerId,
              containerName: observation.containerName ?? null,
              ipAddress: observation.ipAddress ?? null,
              containerRunning: observation.running,
              observationStatus: "observed",
              lastObservedAt: now,
              applyState: "pending",
              desiredGeneration: 1,
              upstreamStrategy: observation.upstreamStrategy ?? null,
              hostPort: observation.hostPort ?? null,
              hostIp: observation.hostIp ?? null,
              ...desired,
            })
            .returning();
          return { binding: row!, desiredChanged: true, requeued: false };
        }
        const desiredChanged = existing.configHash !== observation.configHash;
        const requeued =
          !desiredChanged &&
          existing.applyState !== "blocked" &&
          (existing.containerId !== observation.containerId ||
            existing.ipAddress !== (observation.ipAddress ?? null) ||
            existing.containerRunning !== observation.running ||
            // Resolved upstream target changes (strategy flip, published host
            // port moved) requeue exactly like an IP change: routes target it.
            (existing.upstreamStrategy ?? null) !== (observation.upstreamStrategy ?? null) ||
            (existing.hostPort ?? null) !== (observation.hostPort ?? null) ||
            (existing.hostIp ?? null) !== (observation.hostIp ?? null));
        const [row] = await tx
          .update(binding)
          .set({
            containerId: observation.containerId,
            containerName: observation.containerName ?? null,
            ipAddress: observation.ipAddress ?? null,
            containerRunning: observation.running,
            observationStatus: "observed",
            lastObservedAt: now,
            composeProject: observation.composeProject ?? existing.composeProject,
            composeService: observation.composeService ?? existing.composeService,
            networkName: observation.networkName ?? null,
            networkId: observation.networkId ?? null,
            upstreamStrategy: observation.upstreamStrategy ?? null,
            hostPort: observation.hostPort ?? null,
            hostIp: observation.hostIp ?? null,
            // A blocked binding (identity conflict, other owner's hostname)
            // stays blocked through observation updates — only the reconciler's
            // explicit unblock (conflict resolved) returns it to pending.
            ...(existing.applyState !== "blocked" && (desiredChanged || requeued)
              ? {
                  ...(desiredChanged ? desired : {}),
                  desiredGeneration: existing.desiredGeneration + 1,
                  applyState: "pending" as const,
                  applyError: null,
                  applyAttempts: 0,
                  nextApplyAt: null,
                }
              : desiredChanged
                ? desired
                : {}),
            updatedAt: now,
          })
          .where(eq(binding.id, existing.id))
          .returning();
        return { binding: row!, desiredChanged, requeued };
      });
    },

    /**
     * Shared removal semantics for markMissing (container gone) and
     * markInvalid (container present, declaration rejected):
     *  - observation invalidated: container id/name, IP and running flag are
     *    cleared — the old observation describes a container that is either
     *    gone or unrouteable, and keeping its IP alive in the row is exactly
     *    the stale-upstream hazard;
     *  - binding/certificate metadata RETAINED: hostname, port, network,
     *    config hash and generations stay (the declaration may come back);
     *  - retirement scheduled INDEPENDENTLY of blocking/suppression: any
     *    binding with evidence of a previously applied route (applied state or
     *    appliedGeneration > 0) gets `withdrawalPending = true`, so a blocked
     *    or suppressed binding's live route is still withdrawn on removal —
     *    `blocked` only forbids FORWARD applies, never retirement;
     *  - non-blocked, non-suppressed bindings additionally requeue into the
     *    normal apply queue (generation bump + pending) so the reconciler's
     *    regular pass handles them; blocked/suppressed state stays untouched.
     * Idempotent per target state: re-marking does not re-bump or re-flag.
     */
    async invalidateObservation(
      serverId: string,
      serviceKey: string,
      target: "missing" | "invalid",
    ) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(binding)
          .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
          .for("update");
        if (!existing) return undefined;
        const newlyTarget = existing.observationStatus !== target;
        const hasAppliedRoute =
          existing.applyState === "applied" || existing.appliedGeneration > 0;
        const requeue =
          newlyTarget &&
          existing.applyState !== "blocked" &&
          !existing.suppressed;
        const [row] = await tx
          .update(binding)
          .set({
            observationStatus: target,
            containerId: null,
            containerName: null,
            ipAddress: null,
            containerRunning: false,
            // Retirement of a real route, scheduled regardless of blocked/suppressed.
            ...(newlyTarget && hasAppliedRoute ? { withdrawalPending: true } : {}),
            ...(requeue
              ? {
                  desiredGeneration: existing.desiredGeneration + 1,
                  applyState: "pending" as const,
                  applyError: null,
                  applyAttempts: 0,
                  nextApplyAt: null,
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(binding.id, existing.id))
          .returning();
        return row;
      });
    },

    /** The container is confirmed absent from the host. */
    markMissing(serverId: string, serviceKey: string) {
      return this.invalidateObservation(serverId, serviceKey, "missing");
    },

    /** The container is present but its declaration is invalid/excluded. */
    markInvalid(serverId: string, serviceKey: string) {
      return this.invalidateObservation(serverId, serviceKey, "invalid");
    },

    /**
     * Bindings with a confirmed route whose upstream must be retired.
     * Consumed by the reconciler's retirement path — independent of the
     * forward-apply queue, so blocked and suppressed bindings are included.
     */
    dueForWithdrawal(serverId: string) {
      return db
        .select()
        .from(binding)
        .where(and(eq(binding.serverId, serverId), eq(binding.withdrawalPending, true)));
    },

    /** The reconciler retired the route; clear the retirement signal. */
    async markWithdrawn(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({ withdrawalPending: false, updatedAt: new Date() })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /** Inspection failed for this binding: keep EVERYTHING, record the state. */
    async markObservationError(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({ observationStatus: "error", updatedAt: new Date() })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /**
     * Bindings whose desired state still needs an Edge apply, backoff elapsed,
     * not suppressed. Callers lock rows again inside their apply transaction.
     */
    dueForApply(serverId: string, now = new Date()) {
      return db
        .select()
        .from(binding)
        .where(
          and(
            eq(binding.serverId, serverId),
            eq(binding.suppressed, false),
            or(eq(binding.applyState, "pending"), eq(binding.applyState, "error")),
            or(isNull(binding.nextApplyAt), lte(binding.nextApplyAt, now)),
          ),
        );
    },

    /** Every not-suppressed binding of a set of servers (startup repair path). */
    listActiveForServers(serverIds: string[]) {
      if (serverIds.length === 0) return Promise.resolve([]);
      return db
        .select()
        .from(binding)
        .where(and(inArray(binding.serverId, serverIds), eq(binding.suppressed, false)));
    },

    /** Persist the probed target only if the inspected binding is still current. */
    async resolveUpstream(
      expected: Pick<DiscoveryBinding, "id" | "desiredGeneration" | "containerId" | "configHash">,
      target: Pick<DiscoveryBinding, "upstreamStrategy" | "ipAddress" | "hostPort" | "hostIp">,
    ) {
      const [row] = await db.update(binding).set({
        ...target,
        // Target selection itself is versioned so stale completions cannot
        // mark a route applied against a newer observation.
        desiredGeneration: sql`${binding.desiredGeneration} + case when
          ${binding.upstreamStrategy} is distinct from ${target.upstreamStrategy} or
          ${binding.ipAddress} is distinct from ${target.ipAddress} or
          ${binding.hostPort} is distinct from ${target.hostPort} or
          ${binding.hostIp} is distinct from ${target.hostIp} then 1 else 0 end`,
        updatedAt: new Date(),
      }).where(and(
        eq(binding.id, expected.id),
        eq(binding.desiredGeneration, expected.desiredGeneration),
        expected.containerId ? eq(binding.containerId, expected.containerId) : isNull(binding.containerId),
        eq(binding.configHash, expected.configHash),
        eq(binding.observationStatus, "observed"),
        eq(binding.containerRunning, true),
        eq(binding.suppressed, false),
        inArray(binding.applyState, ["pending", "error"]),
      )).returning();
      return row;
    },

    /** Record a verified Edge apply for `generation` (applyState → applied). */
    async markApplied(serverId: string, serviceKey: string, generation: number) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "applied",
          appliedGeneration: generation,
          applyError: null,
          applyAttempts: 0,
          nextApplyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(binding.serverId, serverId),
            eq(binding.serviceKey, serviceKey),
            // Stale applier: a newer generation became desired meanwhile.
            lte(binding.desiredGeneration, generation),
          ),
        )
        .returning();
      return row;
    },

    /**
     * Force a converged ("applied") binding back into the reconcile queue.
     *
     * Used by the repair sweep: it restores route files from durable records
     * but cannot validate an upstream, so when the record describes a RUNNING
     * backend (or a serving vhost disagrees with the record) the guarded
     * reconciliation must re-probe fresh and rewrite — and an unchanged scan
     * would never requeue an applied binding on its own.
     *
     * Strictly conditional under the row lock: the requeue commits only if the
     * row STILL matches the repair sweep's snapshot — expected generation,
     * still "applied", still unsuppressed. Repair reads its snapshot, THEN the
     * scanner may block a hostname conflict or an operator may opt out; a
     * blind requeue would clear that conflict protection (blocked → pending).
     * A lost race returns undefined and the next sweep (or the scanner's own
     * requeue) handles the newer state.
     */
    async requeueForApply(serverId: string, serviceKey: string, expectedDesiredGeneration: number) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(binding)
          .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
          .for("update");
        if (!existing) return undefined;
        // Snapshot must still be current: a scanner observation bumped the
        // generation meanwhile and owns the queuing decision.
        if (existing.desiredGeneration !== expectedDesiredGeneration) return undefined;
        // Only a converged binding is "stuck"; pending/error are already
        // queued, and blocked/suppressed are explicit control repair must
        // never override.
        if (existing.applyState !== "applied") return undefined;
        if (existing.suppressed) return undefined;
        const [row] = await tx
          .update(binding)
          .set({
            applyState: "pending" as const,
            desiredGeneration: existing.desiredGeneration + 1,
            applyError: null,
            applyAttempts: 0,
            nextApplyAt: null,
            updatedAt: new Date(),
          })
          .where(eq(binding.id, existing.id))
          .returning();
        return row;
      });
    },

    /** Record a failed apply with persisted backoff. */
    /**
     * Record a failed apply with persisted backoff. `expectedGeneration` makes
     * the write GENERATION-CONDITIONAL: a stale attempt failing after a newer
     * observation requeued the binding must not overwrite that pending state or
     * impose backoff on work that was never attempted at the new generation.
     * Returns the row when recorded, undefined when the generation had moved on.
     */
    async markApplyError(
      serverId: string,
      serviceKey: string,
      error: string,
      retryAt: Date,
      expectedGeneration?: number,
    ) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "error",
          applyError: error.slice(0, 500),
          applyAttempts: sql`${binding.applyAttempts} + 1`,
          nextApplyAt: retryAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(binding.serverId, serverId),
            eq(binding.serviceKey, serviceKey),
            // A blocked binding is not retryable, backoff or not.
            ne(binding.applyState, "blocked"),
            expectedGeneration !== undefined
              ? eq(binding.desiredGeneration, expectedGeneration)
              : undefined,
          ),
        )
        .returning();
      return row;
    },

    /**
     * BLOCK a binding from reconciliation: duplicate live identity (two running
     * containers claim one serviceKey — never pick a replica) or a hostname an
     * existing non-discovery owner already serves (never repoint it). Stays
     * blocked across scans until the operator resolves it; re-observation
     * never clears it (see observe), only `unblock` does.
     */
    async block(serverId: string, serviceKey: string, reason: string) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "blocked",
          applyError: reason.slice(0, 500),
          nextApplyAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
        .returning();
      return row;
    },

    /** Resolve a conflict; the next reconciliation pass re-applies desired state. */
    async unblock(serverId: string, serviceKey: string) {
      const [row] = await db
        .update(binding)
        .set({
          applyState: "pending",
          applyError: null,
          applyAttempts: 0,
          nextApplyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey), eq(binding.applyState, "blocked")),
        )
        .returning();
      return row;
    },

    /**
     * The OTHER-owner check for a candidate hostname: an existing domain row
     * served by a project/webhook/mail owner (not this server's discovery).
     * Discovery never repoints such a row — the scanner blocks instead.
     */
    findConflictingDomainOwner(serverId: string, hostname: string) {
      return db.query.domain.findFirst({
        where: and(
          eq(domain.hostname, hostname.toLowerCase()),
          or(isNull(domain.serverId), ne(domain.serverId, serverId)),
        ),
      });
    },

    /** The operator declined this declaration; the scanner keeps observing it. */
    /**
     * Operator opt-out: the scanner keeps observing (status visibility) but no
     * route is reconciled for this binding, and a LIVE route is retired.
     * Retirement is scheduled here (withdrawalPending when application history
     * proves a route exists) and consumed by the reconciler's withdrawal loop,
     * which removes outright for suppressed owners — full retirement, never
     * 503-retention (explicit control, docs: "Manual disable/forget explicitly
     * controls route retirement").
     */
    async suppress(serverId: string, serviceKey: string) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(binding)
          .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
          .for("update");
        if (!existing) return undefined;
        const hasAppliedRoute = existing.applyState === "applied" || existing.appliedGeneration > 0;
        const [row] = await tx
          .update(binding)
          .set({
            suppressed: true,
            suppressedAt: new Date(),
            ...(hasAppliedRoute ? { withdrawalPending: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(binding.id, existing.id))
          .returning();
        return row;
      });
    },

    /**
     * Revert an opt-out. The pending withdrawal is cleared ONLY on evidence of
     * an ACTUAL suppression reversal whose retirement was suppression-owned:
     *   - the row was actually suppressed (an unsuppress of a clean row must
     *     not cancel anything), AND
     *   - discovery is enabled (a DISABLE-scheduled withdrawal — those routes
     *     must still be removed — survives), AND
     *   - the backend was not lost (missing/invalid — the upstream is genuinely
     *     gone), AND
     *   - the binding is not BLOCKED: a blocked binding's retirement was
     *     scheduled by conflict/removal policy, not by the suppression, and
     *     must proceed regardless of the operator's change of heart.
     * Any other withdrawal survives; a withdrawal that already ran cleared the
     * flag via markWithdrawn, and the next scan re-applies from scratch.
     */
    async unsuppress(serverId: string, serviceKey: string) {
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(binding)
          .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)))
          .for("update");
        if (!existing) return undefined;
        const [settingsRow] = await tx
          .select({ enabled: settings.enabled })
          .from(settings)
          .where(eq(settings.serverId, serverId));
        // No settings row = discovery is off at the server level: keep the
        // withdrawal (conservative — removal is the safe direction).
        const discoveryDisabled = settingsRow ? !settingsRow.enabled : true;
        const observationLoss =
          existing.observationStatus === "missing" || existing.observationStatus === "invalid";
        const suppressionOwned =
          existing.suppressed === true &&
          !discoveryDisabled &&
          !observationLoss &&
          existing.applyState !== "blocked";
        const [row] = await tx
          .update(binding)
          .set({
            suppressed: false,
            suppressedAt: null,
            ...(suppressionOwned ? { withdrawalPending: false } : {}),
            updatedAt: new Date(),
          })
          .where(eq(binding.id, existing.id))
          .returning();
        return row;
      });
    },

    /**
     * Disable mode's route policy (docs: "Disable mode cancels watchers,
     * withdraws discovery-owned application routes") in ONE transaction:
     * flips the settings row to disabled AND schedules retirement for every
     * binding with application history. Atomicity matters — a crash between
     * "disabled" and "withdrawals scheduled" would leave live routes on a
     * disabled server that no sweep would ever select (sweepable = enabled ∪
     * owing-withdrawals).
     */
    async disableAndScheduleWithdrawals(serverId: string) {
      return db.transaction(async (tx) => {
        await tx
          .update(settings)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(settings.serverId, serverId));
        return tx
          .update(binding)
          .set({ withdrawalPending: true, updatedAt: new Date() })
          .where(
            and(
              eq(binding.serverId, serverId),
              or(eq(binding.applyState, "applied"), gt(binding.appliedGeneration, 0)),
            ),
          )
          .returning();
      });
    },

    /**
     * Forget a binding entirely. The DOMAIN row is intentionally untouched —
     * certificate material, expiry and retry state survive (see schema note);
     * route retirement is the reconciler's job, never the repo's.
     */
    async forget(serverId: string, serviceKey: string) {
      await db
        .delete(binding)
        .where(and(eq(binding.serverId, serverId), eq(binding.serviceKey, serviceKey)));
    },

    /** Binding↔domain join helper: the server-scoped domain row for a binding.
     *  Hostnames are normalized lowercase, matching the parser's declarations. */
    findDomainForBinding(serverId: string, hostname: string) {
      return db.query.domain.findFirst({
        where: and(eq(domain.serverId, serverId), eq(domain.hostname, hostname.toLowerCase())),
      });
    },

    /** The live discovery binding behind a server-scoped domain (TLS gate). */
    getBindingForDomain(serverId: string, hostname: string) {
      return db.query.discoveryBinding.findFirst({
        where: and(
          eq(binding.serverId, serverId),
          eq(binding.hostname, hostname.toLowerCase()),
          eq(binding.suppressed, false),
        ),
      });
    },
  };
}

// Re-export the declaration type so callers can name the parser's output type
// without importing @repo/core directly in server code paths.
export type { DiscoveryDeclaration };
