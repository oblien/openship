import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { createHash, randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  CloudAnalyticsEventSchemas,
  CloudBrowserCaptureSchema,
  type CloudAnalyticsEvent,
  type CloudAnalyticsProperties,
  type CloudBrowserCapture,
  type CloudSubscriptionSnapshot,
} from "@repo/contracts";
import type { CloudAnalyticsRepo, CloudAnalyticsOutboxInput } from "@repo/db/repos";
import type { CloudAnalyticsConfig } from "./config";

export interface AnalyticsActor {
  organizationId?: string | null;
  userId?: string | null;
  anonymousId?: string;
  source?: "dashboard" | "mcp" | "cli" | "api" | "webhook" | "system";
}

/** Stable, opaque IDs: raw checkout/payment IDs never go to PostHog. */
export function analyticsId(key: string): string {
  const hex = createHash("sha256").update(`openship-cloud:${key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export class CloudAnalytics {
  private pending = new Set<Promise<void>>();
  private flushing = false;
  private lastWarning = 0;
  constructor(
    private readonly options: {
      config: () => CloudAnalyticsConfig | null;
      repo: CloudAnalyticsRepo;
      fetch?: typeof fetch;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }
  enabled(actor: AnalyticsActor = {}): boolean {
    try {
      const config = this.options.config();
      return (
        !!config &&
        !config.excludedOrganizations.has(actor.organizationId ?? "") &&
        !config.excludedUsers.has(actor.userId ?? "")
      );
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud-analytics/service");
      return false;
    }
  }
  private warn(): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    // No provider response, event payload, or token in logs.
    errorDiagnostics.warn("platform/engine/modules/cloud-analytics/service", "[cloud-analytics] Delivery/storage unavailable; pending deliveries will retry.");
  }
  private async safely(work: () => Promise<void>) {
    try {
      await work();
      return true;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud-analytics/service");
      this.warn();
      return false;
    }
  }
  private row(
    actor: AnalyticsActor,
    event: string,
    properties: Record<string, unknown>,
    key: string,
    retain: boolean,
    occurredAt = this.now(),
  ): CloudAnalyticsOutboxInput {
    const id = analyticsId(key);
    return {
      id,
      event,
      organizationId: actor.organizationId,
      retain,
      occurredAt,
      nextAttemptAt: this.now(),
      distinctId:
        actor.userId ??
        (actor.organizationId ? `workspace:${actor.organizationId}` : `anon:${actor.anonymousId}`),
      properties: {
        ...properties,
        $insert_id: id,
        $geoip_disable: true,
        $process_person_profile: !!actor.userId,
        environment: "production",
        product: "openship_cloud",
        source: actor.source ?? (actor.userId ? "api" : "system"),
        ...(actor.organizationId
          ? { workspace_id: actor.organizationId, $groups: { workspace: actor.organizationId } }
          : {}),
      },
    };
  }
  private valid<E extends CloudAnalyticsEvent>(
    event: E,
    properties: CloudAnalyticsProperties<E>,
  ): boolean {
    return (
      Object.hasOwn(CloudAnalyticsEventSchemas, event) &&
      Value.Check(CloudAnalyticsEventSchemas[event], properties)
    );
  }

  /** Only the database enqueue is awaited; no product flow awaits PostHog. */
  async record<E extends CloudAnalyticsEvent>(
    actor: AnalyticsActor,
    event: E,
    properties: CloudAnalyticsProperties<E>,
    key?: string,
    occurredAt?: Date,
  ): Promise<boolean> {
    if (
      (!actor.userId && !actor.organizationId && !actor.anonymousId) ||
      !this.enabled(actor) ||
      !this.valid(event, properties)
    )
      return false;
    return this.safely(() =>
      this.options.repo.enqueue(
        this.row(
          actor,
          event,
          properties,
          key ?? randomUUID(),
          key !== undefined,
          occurredAt,
        ),
      ),
    );
  }
  /** Bounded background ownership: hot paths don't wait on analytics storage. */
  capture<E extends CloudAnalyticsEvent>(
    actor: AnalyticsActor,
    event: E,
    properties: CloudAnalyticsProperties<E>,
    key?: string,
  ): void {
    if (!this.enabled(actor)) return;
    this.background(() => this.record(actor, event, properties, key));
  }
  private background(work: () => Promise<unknown>): void {
    if (this.pending.size >= 500) return;
    const task = this.safely(async () => {
      await work();
    }).then(() => {});
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  deploymentOutcome(
    actor: AnalyticsActor & { organizationId: string },
    succeeded: boolean,
    properties: CloudAnalyticsProperties<"cloud_deployment_succeeded">,
  ): void {
    if (!this.enabled(actor)) return;
    this.background(async () => {
      const started = await this.options.repo.findEvent(
        actor.organizationId,
        analyticsId(`deployment-started:${properties.deployment_id}`),
      );
      const attributed = {
        ...actor,
        userId:
          started && !started.distinctId.startsWith("workspace:")
            ? started.distinctId
            : actor.userId,
      };
      await this.record(
        attributed,
        succeeded ? "cloud_deployment_succeeded" : "cloud_deployment_failed",
        properties,
        `deployment.${succeeded ? "succeeded" : "failed"}:${properties.deployment_id}`,
      );
      if (succeeded)
        await this.record(
          attributed,
          "cloud_first_deployment_succeeded",
          { project_id: properties.project_id, deployment_id: properties.deployment_id },
          `activation:${actor.organizationId}`,
        );
    });
  }

  async browser(actor: AnalyticsActor, input: CloudBrowserCapture): Promise<void> {
    if (
      !this.enabled(actor) ||
      !Value.Check(CloudBrowserCaptureSchema, input) ||
      (actor.userId ?? null) !== input.expectedUserId
    )
      return;
    const browserActor = { ...actor, anonymousId: input.anonymousId, source: "dashboard" as const };
    await this.safely(async () => {
      if (actor.userId) {
        const initial = Object.fromEntries(
          Object.entries(input.attribution).map(([key, value]) => [`initial_${key}`, value]),
        );
        await this.options.repo.enqueue(
          this.row(
            browserActor,
            "$identify",
            {
              $anon_distinct_id: `anon:${input.anonymousId}`,
              $set_once: initial,
            },
          `identify:${input.anonymousId}:${actor.userId}`,
          false,
          ),
        );
      }
      const { event, properties } = input.data;
      await this.options.repo.enqueue(
        this.row(
          browserActor,
          event,
          properties,
          `browser:${input.anonymousId}:${input.id}`,
          false,
        ),
      );
    });
  }

  async checkoutStarted(
    actor: AnalyticsActor & { organizationId: string; userId: string },
    input: {
      checkoutId: string;
      kind: "subscription" | "topup";
      amount: number;
      plan?: string;
      interval?: "monthly" | "annual";
    },
  ): Promise<void> {
    if (!this.enabled(actor)) return;
    const properties = {
      checkout_id: analyticsId(input.checkoutId),
      kind: input.kind,
      amount_cents: input.amount,
      currency: "usd" as const,
      ...(input.plan && { plan: input.plan }),
      ...(input.interval && { interval: input.interval }),
    };
    if (!this.valid("cloud_checkout_started", properties)) return;
    await this.safely(() =>
      this.options.repo.rememberCheckout(
        {
          id: input.checkoutId,
          organizationId: actor.organizationId,
          userId: actor.userId,
          kind: input.kind,
        },
        this.row(
          actor,
          "cloud_checkout_started",
          properties,
          `checkout:${input.checkoutId}:started`,
          true,
        ),
      ),
    );
  }

  async checkoutObserved(
    organizationId: string,
    checkout: {
      id: string;
      kind: "subscription" | "topup";
      status: string;
      paymentStatus: string;
      fulfilled: boolean;
      fulfillmentStatus: string;
    },
  ): Promise<void> {
    if (!this.enabled({ organizationId })) return;
    await this.safely(async () => {
      const saved = await this.options.repo.findCheckout(organizationId, checkout.id);
      const actor = { organizationId, userId: saved?.userId, source: "system" as const };
      if (!this.enabled(actor)) return;
      const properties = { checkout_id: analyticsId(checkout.id), kind: checkout.kind };
      const status = checkout.fulfillmentStatus;
      let recorded = true;
      if (status === "refunded" || status === "partially_refunded" || status === "disputed") {
        recorded = await this.record(
          actor,
          "cloud_checkout_reversed",
          { ...properties, status },
          `checkout:${checkout.id}:${status}`,
        );
      } else if (
        checkout.status === "complete" &&
        checkout.paymentStatus === "paid" &&
        checkout.fulfilled &&
        status === "completed"
      ) {
        recorded = await this.record(
          actor,
          "cloud_checkout_completed",
          properties,
          `checkout:${checkout.id}:completed`,
        );
      } else if (checkout.status === "expired" || status === "expired") {
        recorded = await this.record(
          actor,
          "cloud_checkout_expired",
          properties,
          `checkout:${checkout.id}:expired`,
        );
      } else if (status === "failed") {
        recorded = await this.record(
          actor,
          "cloud_checkout_failed",
          properties,
          `checkout:${checkout.id}:failed`,
        );
      }
      if (!recorded) return; // Keep reconciliation retryable if the outbox write failed.
      // Open checkouts get reconciled even when the browser never returns.
      // Final checkouts are re-read when a signed provider event/UI requests it.
      const final =
        checkout.status === "expired" ||
        ["expired", "failed", "refunded", "partially_refunded", "disputed"].includes(status) ||
        (checkout.status === "complete" &&
          checkout.fulfilled &&
          status === "completed" &&
          ["paid", "no_payment_required"].includes(checkout.paymentStatus));
      await this.options.repo.observedCheckout(
        organizationId,
        checkout.id,
        status,
        final ? null : new Date(this.now().getTime() + 5 * 60_000),
      );
    });
  }

  /** Called only with a signature-verified, tenant-resolved Oblien event. */
  async payment(
    actor: AnalyticsActor & { organizationId: string },
    input: {
      paymentId: string;
      checkoutId?: string;
      kind: "subscription" | "topup";
      amount: number;
      renewed: boolean;
    },
    occurredAt?: Date,
  ): Promise<void> {
    if (!this.enabled(actor)) return;
    await this.safely(async () => {
      const checkout = input.checkoutId
        ? await this.options.repo.findCheckout(actor.organizationId, input.checkoutId)
        : null;
      const payer = { ...actor, userId: checkout?.userId, source: "webhook" as const };
      await this.record(
        payer,
        "cloud_payment_succeeded",
        {
          payment_id: analyticsId(input.paymentId),
          ...(input.checkoutId && { checkout_id: analyticsId(input.checkoutId) }),
          kind: input.kind,
          amount_cents: input.amount,
          currency: "usd",
        },
        `payment:${input.paymentId}`,
        occurredAt,
      );
      if (input.renewed)
        await this.record(
          payer,
          "cloud_subscription_renewed",
          { payment_id: analyticsId(input.paymentId) },
          `renewal:${input.paymentId}`,
          occurredAt,
        );
    });
  }

  async subscription(organizationId: string, snapshot: CloudSubscriptionSnapshot): Promise<void> {
    if (!this.enabled({ organizationId }) || !this.valid("cloud_subscription_changed", snapshot))
      return;
    await this.safely(() =>
      this.options.repo.snapshot(organizationId, snapshot, (revision) => [
        this.row(
          { organizationId },
          "cloud_subscription_changed",
          { ...snapshot, revision },
          `subscription:${organizationId}:${revision}`,
          true,
        ),
      ]),
    );
  }

  async flush(): Promise<void> {
    if (!this.enabled()) return;
    const config = this.options.config();
    if (!config || this.flushing) return;
    this.flushing = true;
    try {
      const lease = randomUUID();
      const batch = await this.options.repo.claim(lease, this.now());
      if (!batch.length) return;
      const allowed = batch.filter((row) =>
        this.enabled({ organizationId: row.organizationId, userId: row.distinctId }),
      );
      try {
        if (allowed.length) {
          const response = await (this.options.fetch ?? fetch)(`${config.host}/batch/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
            body: JSON.stringify({
              api_key: config.key,
              historical_migration: false,
              batch: allowed.map((row) => ({
                uuid: row.id,
                event: row.event,
                distinct_id: row.distinctId,
                properties: row.properties,
                timestamp: row.occurredAt.toISOString(),
              })),
            }),
          });
          if (!response.ok) throw new Error("analytics delivery rejected");
          // Consume the bounded PostHog response so connections can be reused.
          await response.body?.cancel();
        }
        await this.options.repo.acknowledge(
          batch.map((row) => row.id),
          lease,
          this.now(),
        );
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud-analytics/service");
        const attempts = Math.max(...batch.map((row) => row.attempts));
        const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7));
        await this.options.repo.retry(
          batch.map((row) => row.id),
          lease,
          new Date(this.now().getTime() + delay),
        );
        this.warn();
      }
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud-analytics/service");
      this.warn();
    } finally {
      this.flushing = false;
    }
  }
}
