/**
 * Oblien tunnel provider — SaaS-driven.
 *
 * Credentials and resource control live entirely on the SaaS side:
 *   - The master client is constructed from CLOUD_MODE config and the
 *     stored session token (see lib/openship-cloud.ts).
 *   - Tunnels are scoped to an Oblien namespace per-organization,
 *     resolved via ensureNamespaceWithQuota (the quota-asserting entry point —
 *     a tunnel is billable capacity, so it must not precede a credit ceiling).
 *
 * Provider context payload (input.context):
 *   - organizationId: string  (required — used to resolve namespace)
 */

import { env } from "../../../config/env";
import { getOblienClient, ensureNamespaceWithQuota } from "../../../lib/openship-cloud";
import type {
  TunnelAgent,
  TunnelProvider,
  TunnelProvisionInput,
  TunnelRecord,
} from "../types";
import { ProvisionFailedError, SlugTakenError } from "../types";

function requireOrganizationId(input: TunnelProvisionInput): string {
  const orgId = input.context?.organizationId;
  if (typeof orgId !== "string" || !orgId) {
    throw new ProvisionFailedError(
      "oblien",
      "context.organizationId is required (used to resolve the Oblien namespace).",
    );
  }
  return orgId;
}

export const oblienProvider: TunnelProvider = {
  name: "oblien",

  async preflight() {
    if (!env.CLOUD_MODE) {
      return {
        ok: false,
        reason:
          "Oblien tunnels require CLOUD_MODE — this instance must be connected to Openship Cloud first.",
      };
    }
    return { ok: true };
  },

  async create(input) {
    const organizationId = requireOrganizationId(input);

    let namespace: string;
    try {
      // A tunnel is billable namespace capacity, so it goes through the
      // quota-asserting entry point like every other spend path.
      namespace = await ensureNamespaceWithQuota(organizationId);
    } catch (err) {
      throw new ProvisionFailedError(
        "oblien",
        err instanceof Error ? err.message : String(err),
      );
    }

    let created: Awaited<ReturnType<ReturnType<typeof getOblienClient>["edgeTunnel"]["create"]>>;
    try {
      created = await getOblienClient().edgeTunnel.create({
        name: input.name,
        slug: input.slug,
        port: input.port,
        namespace,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Oblien returns a textual conflict error for slug collisions.
      // Don't swallow other failures behind the same code.
      if (input.slug && /slug.*(taken|exist|in use|conflict)/i.test(message)) {
        throw new SlugTakenError("oblien", input.slug);
      }
      throw new ProvisionFailedError("oblien", message);
    }

    return {
      externalId: created.tunnel.tunnel_id,
      slug: created.tunnel.slug,
      publicUrl: created.tunnel.url,
    };
  },

  async delete(externalId) {
    // SDK delete expects a number; the externalId is persisted as
    // string. Coerce + reject NaN so we never send DELETE /tunnels/NaN.
    const idNum = Number(externalId);
    if (!Number.isFinite(idNum)) {
      console.warn(
        "[tunneling.oblien] delete skipped — externalId is not a finite number",
        { externalId },
      );
      return;
    }
    await getOblienClient().edgeTunnel.delete(idNum);
  },

  async connect(record, port) {
    // edgeTunnel.connect re-resolves the tunnel by slug+port, issues a
    // fresh JWT, and opens the WebSocket — all in one call. For an
    // already-provisioned tunnel this is a re-attach (no new record).
    const tc = await getOblienClient().edgeTunnel.connect(
      {
        name: `openship-tunnel-${record.externalId}`,
        slug: record.slug || undefined,
        port,
      },
      { localPort: port },
    );
    return tc as unknown as TunnelAgent;
  },
};
