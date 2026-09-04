/**
 * THE host-control resolver — may OpenShip deploy to the machine it runs on?
 *
 * "Host control" governs whether this box is itself a deploy target: the isLocal
 * "This Server" row, and every host-OS operation that reaches the machine through
 * the container→host SSH channel (or LocalExecutor on a bare install). Turning it
 * off (`openship up --no-host-control`) makes the box control-plane-only.
 *
 * Precedence (DELIBERATELY the productMode direction, NOT authMode's):
 *   1. Not a self-hosted target (SaaS / desktop / Oblien runtime) → always false.
 *      The isLocal row is withheld on those anyway (localServerOwnerOrg), so this
 *      keeps the client-facing "effective" value in agreement with the backend
 *      and ends the isServerHost-vs-target divergence for the UI.
 *   2. instance_settings.host_control_enabled — the operator's Settings toggle.
 *   3. OPENSHIP_HOST_CONTROL env — the install-time default.
 *
 * Why DB-overrides-env here even though this gates privileged behavior (host-root
 * deploys, unlike the presentation-only productMode): the operator's explicit need
 * is to re-enable from Settings what `--no-host-control` disabled, "from settings
 * again anytime". The escalation risk is contained at the WRITE — setup.controller
 * gates it to the box-owning org's owner, the same gate createServer's loopback
 * adoption uses. adapters (@repo/adapters) cannot import @repo/db, so the resolved
 * override is PUSHED into it via setHostControlOverride (mirrors product-mode.ts's
 * relationship to the settings write).
 */

import { resolvePlatformConfig } from "./controller-helpers";

/** The raw env floor, parsed exactly as @repo/adapters does, so an unset DB value
 *  resolves to the same answer the executor gate would give on its own. */
function envHostControlDisabled(): boolean {
  return process.env.OPENSHIP_HOST_CONTROL?.trim().toLowerCase() === "false";
}

/** Cached because /health/env is unauthenticated and polled by every dashboard
 *  load. Cleared by every instance-settings write. */
let cached: boolean | null = null;
let cacheGeneration = 0;

/**
 * Effective "host control is ENABLED" for THIS instance right now. This is the
 * value the dashboard reads (raw + effective) and the client gate keys on.
 */
export async function resolveHostControlEnabled(): Promise<boolean> {
  // Host control is meaningless off a self-hosted box: the SaaS control plane and
  // desktop never register the isLocal row. Checked first so no stored value or env
  // var can advertise a target that localServerOwnerOrg would refuse to create.
  if (resolvePlatformConfig().target !== "selfhosted") return false;

  if (cached !== null) return cached;
  const generation = cacheGeneration;

  // Unreadable settings fall back to the env default rather than failing closed —
  // refusing to honour a stored enable because one query blipped would silently
  // strand a box that the operator turned back on.
  let resolved: boolean;
  try {
    const { repos } = await import("@repo/db");
    const stored = (await repos.instanceSettings.get())?.hostControlEnabled;
    resolved = stored ?? !envHostControlDisabled();
  } catch {
    resolved = !envHostControlDisabled();
  }

  if (generation === cacheGeneration) cached = resolved;
  return resolved;
}

/**
 * Push the stored override into @repo/adapters so the synchronous host-op gates
 * (hostControlDisabled → createHostExecutor / hostChannelHealth / the self-server
 * + listServers gates) reflect the operator's choice without going async.
 *
 * A null stored value pushes `null`, which makes adapters fall back to reading the
 * env var itself — identical to today's behaviour for an instance that never used
 * the toggle. Called once at boot (after the DB is reachable) and on every write.
 */
export async function syncHostControlOverride(): Promise<void> {
  const { repos } = await import("@repo/db");
  const { setHostControlOverride } = await import("@repo/adapters");
  let stored: boolean | null = null;
  try {
    stored = (await repos.instanceSettings.get())?.hostControlEnabled ?? null;
  } catch {
    // DB unreadable: leave the override cleared so the env floor governs.
    stored = null;
  }
  // Store polarity is "enabled"; the adapters override polarity is "disabled".
  setHostControlOverride(stored === null ? null : !stored);
}

/** Clear the cached effective value — called after setup.controller writes. */
export function clearHostControlCache() {
  cacheGeneration += 1;
  cached = null;
}
