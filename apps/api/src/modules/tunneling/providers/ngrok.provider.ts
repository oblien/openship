/**
 * ngrok tunnel provider.
 *
 * NGROK_AUTHTOKEN (agent token, required) opens the tunnel via
 * @ngrok/ngrok. NGROK_API_KEY (optional) additionally lets us reserve
 * a custom hostname for input.slug via @ngrok/ngrok-api — without it,
 * free-tier accounts just use their auto-assigned dev-domain. Both
 * are overridable per-call via context.authtoken / context.apiKey.
 */

import { EventEmitter } from "node:events";
import * as ngrok from "@ngrok/ngrok";
import { Ngrok as NgrokApiClient } from "@ngrok/ngrok-api";
import { env } from "../../../config/env";
import type {
  TunnelAgent,
  TunnelProvider,
  TunnelProvisionInput,
  TunnelRecord,
} from "../types";
import { ProvisionFailedError, SlugTakenError } from "../types";

function resolveAuthtoken(input?: TunnelProvisionInput): string {
  const override = input?.context?.authtoken;
  const token = (typeof override === "string" && override) || env.NGROK_AUTHTOKEN;
  if (!token) {
    throw new ProvisionFailedError(
      "ngrok",
      "No authtoken configured. Set NGROK_AUTHTOKEN or pass context.authtoken.",
    );
  }
  return token;
}

function resolveApiKey(input?: TunnelProvisionInput): string | undefined {
  const override = input?.context?.apiKey;
  return (typeof override === "string" && override) || env.NGROK_API_KEY || undefined;
}

/** ngrok-api throws a plain deserialized error object, not an Error instance. */
function errorMessage(err: unknown): string {
  const e = err as { msg?: string } | undefined;
  return e?.msg ?? (err instanceof Error ? err.message : String(err));
}

function isConflict(err: unknown): boolean {
  const e = err as { statusCode?: number } | undefined;
  if (e?.statusCode === 409) return true;
  return /already (reserved|exists|in use)|conflict|belongs|forbidden/i.test(errorMessage(err));
}

/** Resource id of a reserved domain we already own (by name), or undefined. */
async function findOwnedDomainId(apiKey: string, domain: string): Promise<string | undefined> {
  const client = new NgrokApiClient({ apiToken: apiKey });
  const domains = await client.reservedDomains.list();
  return domains.find((d) => d.domain === domain)?.id;
}

export const ngrokProvider: TunnelProvider = {
  name: "ngrok",

  async preflight() {
    if (!env.NGROK_AUTHTOKEN) {
      return {
        ok: false,
        reason: "ngrok provider requires NGROK_AUTHTOKEN to be configured.",
      };
    }
    return { ok: true };
  },

  async create(input) {
    const authtoken = resolveAuthtoken(input);
    const apiKey = resolveApiKey(input);

    if (input.slug) {
      if (apiKey) {
        let reservationId: string;
        try {
          const created = await new NgrokApiClient({ apiToken: apiKey }).reservedDomains.create({
            domain: input.slug,
            region: "us",
          });
          reservationId = created.id;
        } catch (err) {
          if (!isConflict(err)) {
            throw new ProvisionFailedError("ngrok", errorMessage(err));
          }
          // Conflict may just mean we already own it (re-provision) — verify before rejecting.
          const ownedId = await findOwnedDomainId(apiKey, input.slug);
          if (!ownedId) {
            throw new SlugTakenError("ngrok", input.slug);
          }
          reservationId = ownedId;
        }
        // externalId is the rd_... resource id, not the hostname — see delete().
        return {
          externalId: reservationId,
          slug: input.slug,
          publicUrl: `https://${input.slug}`,
        };
      }

      // No API key — probe-connect to confirm the hostname is actually usable.
      let probe: ngrok.Listener;
      try {
        probe = await ngrok.forward({ addr: input.port, authtoken, domain: input.slug });
      } catch (err) {
        const message = errorMessage(err);
        if (/domain|hostname/i.test(message) && /taken|use|reserved|belongs|forbidden/i.test(message)) {
          throw new SlugTakenError("ngrok", input.slug);
        }
        throw new ProvisionFailedError("ngrok", message);
      }
      const publicUrl = probe.url() ?? `https://${input.slug}`;
      await probe.close();
      return {
        externalId: input.slug,
        slug: input.slug,
        publicUrl,
      };
    }

    // No slug — learn ngrok's auto-assigned hostname by probe-connecting once.
    let probe: ngrok.Listener;
    try {
      probe = await ngrok.forward({ addr: input.port, authtoken });
    } catch (err) {
      throw new ProvisionFailedError("ngrok", errorMessage(err));
    }
    const publicUrl = probe.url();
    await probe.close();
    if (!publicUrl) {
      throw new ProvisionFailedError("ngrok", "ngrok did not return a public URL for the new listener.");
    }
    const slug = new URL(publicUrl).hostname;
    return { externalId: slug, slug, publicUrl };
  },

  async delete(externalId) {
    // Only rd_... ids are reservations we actually created — a bare
    // hostname means nothing was reserved, so there's nothing to delete.
    if (!externalId.startsWith("rd_")) {
      return;
    }
    const apiKey = env.NGROK_API_KEY;
    if (!apiKey) {
      console.warn("[tunneling.ngrok] delete skipped — no NGROK_API_KEY to remove reservation", { externalId });
      return;
    }
    try {
      await new NgrokApiClient({ apiToken: apiKey }).reservedDomains.delete(externalId);
    } catch (err) {
      console.warn("[tunneling.ngrok] delete failed", {
        externalId,
        error: errorMessage(err),
      });
    }
  },

  async connect(record: TunnelRecord, port: number) {
    const authtoken = resolveAuthtoken();
    const listener = await ngrok.forward({
      addr: port,
      authtoken,
      domain: record.slug,
    });
    return new NgrokTunnelAgent(listener);
  },
};

class NgrokTunnelAgent extends EventEmitter implements TunnelAgent {
  private connected = true;
  private closing = false;

  constructor(private readonly listener: ngrok.Listener) {
    super();
    // join() settles when the forwarding task exits; only signal we get.
    void this.listener.join().then(
      () => this.handleExit(null),
      (err) => this.handleExit(err),
    );
  }

  private handleExit(err: unknown): void {
    this.connected = false;
    if (this.closing) {
      this.emit("close");
      return;
    }
    this.emit("disconnect", 0, err ? errorMessage(err) : "listener task exited unexpectedly");
  }

  get isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.closing = true;
    this.connected = false;
    void this.listener.close();
  }
}
