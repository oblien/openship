/**
 * Path C: expose this self-hosted instance via an Oblien edge tunnel.
 *
 * Structurally different from Paths A and B: NO SSH, NO VPS install,
 * NO data dump. The instance stays on the operator's machine; we
 * provision an Oblien tunnel that publishes a public URL routing to
 * `DEFAULT_PORT.dashboard` on this host, then start a long-lived
 * TunnelClient inside this API process so traffic actually forwards.
 *
 * Orchestration:
 *   1. Validate slug shape.
 *   2. Resolve the namespace for the active organization (mirrors the
 *      managed-edge-proxy pattern — Oblien tunnels are an SaaS-managed
 *      resource and need a namespace to live in).
 *   3. Create the tunnel via `edgeTunnel.create({ slug, port, namespace })`.
 *   4. Start the TunnelClient via the boot-time tunnel manager so the
 *      public URL begins forwarding immediately.
 *   5. Hand the new settings to `withMigration`, which commits them and
 *      emits the success audit reflecting committed state.
 *
 * Switch-back tears the tunnel down via `edgeTunnel.delete(tunnelId)`
 * and clears the bookkeeping. No data sync needed (data never moved).
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import type { Context } from "hono";
import { DEFAULT_PORT } from "@repo/core";
import {
  provisionTunnel,
  teardownTunnel,
  startTunnelAgent,
} from "../../tunneling";
import {
  ProviderNotReadyError,
  ProvisionFailedError,
  SlugTakenError,
} from "../../tunneling";
import { withMigration } from "./with-migration";

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

export interface MigrateToTunnelInput {
  slug: string;
  organizationId: string;
  userId: string;
  c: Context;
}

export interface MigrateToTunnelResult {
  tunnelId: string;
  slug: string;
  migrationTargetUrl: string;
}

export class TunnelSlugInvalidError extends Error {
  readonly code = "TUNNEL_SLUG_INVALID" as const;
  constructor() {
    super(
      "Tunnel slug must be 3-32 chars, lowercase letters, digits and dashes, starting and ending with an alphanumeric.",
    );
    this.name = "TunnelSlugInvalidError";
  }
}

export class TunnelSlugTakenError extends Error {
  readonly code = "TUNNEL_SLUG_TAKEN" as const;
  constructor(public readonly slug: string) {
    super(`Tunnel slug "${slug}" is already taken on the Oblien edge.`);
    this.name = "TunnelSlugTakenError";
  }
}

export class TunnelProvisionFailedError extends Error {
  readonly code = "TUNNEL_PROVISION_FAILED" as const;
  constructor(reason: string) {
    super(`Failed to provision Oblien edge tunnel: ${reason}`);
    this.name = "TunnelProvisionFailedError";
  }
}

export class TunnelMustBeCloudConnectedError extends Error {
  readonly code = "TUNNEL_MUST_BE_CLOUD_CONNECTED" as const;
  constructor() {
    super(
      "This instance must be connected to Openship Cloud to provision an edge tunnel. Connect your cloud account in Settings first.",
    );
    this.name = "TunnelMustBeCloudConnectedError";
  }
}

export async function migrateInstanceToTunnel(
  input: MigrateToTunnelInput,
): Promise<MigrateToTunnelResult> {
  return withMigration<MigrateToTunnelInput, MigrateToTunnelResult>(
    {
      direction: "forward",
      variant: "tunneled",
      c: input.c,
      organizationId: input.organizationId,
      userId: input.userId,
      input,
    },
    async (ctx) => {
      // ── 1. Validate slug shape up front so we never bother Oblien with junk.
      const slug = ctx.input.slug.trim().toLowerCase();
      if (!SLUG_RE.test(slug)) {
        throw new TunnelSlugInvalidError();
      }

      // ── 2-3. Provision the tunnel via the generic tunneling module.
      //         The Oblien provider handles its own CLOUD_MODE preflight,
      //         namespace resolution, and slug-taken detection. Map the
      //         tunneling module's typed errors to this module's wizard-
      //         facing ones so the controller surfaces the right codes.
      let tunnel: { externalId: string; slug: string; publicUrl: string };
      try {
        tunnel = await provisionTunnel({
          provider: "oblien",
          name: `openship-${ctx.input.organizationId}`,
          port: DEFAULT_PORT.dashboard,
          slug,
          context: { organizationId: ctx.input.organizationId },
        });
      } catch (err) {
        if (err instanceof SlugTakenError) {
          throw new TunnelSlugTakenError(slug);
        }
        if (err instanceof ProviderNotReadyError) {
          // Oblien preflight failed — almost always means CLOUD_MODE
          // isn't set. Surface the dedicated typed error so the wizard
          // prompts the operator to connect cloud first.
          throw new TunnelMustBeCloudConnectedError();
        }
        if (err instanceof ProvisionFailedError) {
          throw new TunnelProvisionFailedError(err.message);
        }
        throw err;
      }
      const migrationTargetUrl = tunnel.publicUrl;

      // If anything past provisioning fails we already have a tunnel
      // record committed on the provider side. Without rollback the
      // operator would see "slug taken" forever on retry. We always
      // swallow the delete error — the original failure is what the
      // operator needs to see, and the orphan is recoverable via the
      // provider's panel.
      //
      // NOTE on rollback boundary with `withMigration`:
      //   The helper performs the instance_settings upsert AFTER the
      //   body returns successfully. That means body-internal failures
      //   (provision, agent start) still need this local rollback so
      //   we don't leak an Oblien tunnel on retry.
      //
      //   The one edge case this design CANNOT cover: if the body
      //   succeeds and the helper's own settings upsert throws, the
      //   body has already returned and this rollback handler is no
      //   longer reachable. We accept that trade-off — the helper
      //   captures the upsert failure in the audit, the tunnel + agent
      //   remain live, and the operator recovers by retrying (the
      //   helper's lock has already released, and the upsert path is
      //   idempotent). Alternative — pre-upsert + post-validate inside
      //   the body — would duplicate the helper's contract and lose
      //   the "audit's `after` matches committed DB state" invariant.
      async function rollbackTunnel(reason: TunnelProvisionFailedError): Promise<never> {
        try {
          await teardownTunnel({ provider: "oblien", externalId: tunnel.externalId });
        } catch (deleteErr) {
          errorDiagnostics.warn("api/modules/system/migration/migrate-to-tunnel.service",
            "[migrate-to-tunnel] orphan tunnel cleanup failed; manual delete required",
            { externalId: tunnel.externalId, slug: tunnel.slug, error: deleteErr }, deleteErr,
          );
        }
        throw reason;
      }

      // ── 4. Bring the in-process forwarding agent up so the public URL
      //       actually forwards to localhost:<dashboard port>. The agent
      //       is generic — the tunneling module routes to the right
      //       provider based on the record.
      //
      //       Settings upsert is deferred to the helper, so this is the
      //       last step the body owns. Failure here means we created a
      //       tunnel but can't forward traffic — roll back the provider
      //       record so retry isn't blocked by a "slug taken" error.
      try {
        await startTunnelAgent({
          provider: "oblien",
          record: tunnel,
          port: DEFAULT_PORT.dashboard,
        });
      } catch (err) {
        observeCaughtError(err, "api/modules/system/migration/migrate-to-tunnel.service");
        await rollbackTunnel(
          new TunnelProvisionFailedError(
            `Tunnel created but agent failed to connect: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }

      // ── 5. Finale: hand committed-state intent to the helper. Helper
      //       upserts instance_settings then emits the success audit
      //       reflecting the committed row.
      return {
        settings: {
          teamMode: "tunneled",
          migrationTargetUrl,
          migratedAt: new Date(),
          tunnelSlug: tunnel.slug,
          tunnelId: tunnel.externalId,
        },
        result: {
          tunnelId: tunnel.externalId,
          slug: tunnel.slug,
          migrationTargetUrl,
        },
      };
    },
  );
}
