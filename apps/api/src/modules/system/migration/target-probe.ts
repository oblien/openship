/**
 * GATE 3 (source-side) for migrate-control-plane → server.
 *
 * Before exporting/transferring anything, confirm the TARGET is a self-hosted
 * single-tenant box — NEVER a multi-tenant Openship Cloud instance. An
 * instance-scope `import --wipe` against the SaaS would TRUNCATE every tenant,
 * so this fails CLOSED: unreachable or unconfirmed → refuse.
 *
 * Pairs with GATE 1 (export/import refuse in CLOUD_MODE) and GATE 2
 * (restoreSubgraph wipe refuses in CLOUD_MODE) so the SaaS is unreachable as a
 * transfer target from four independent directions.
 */

import { safeErrorMessage } from "@repo/core";

export interface TargetProbe {
  reachable: boolean;
  /** The target advertised `cloudMode:true` on /api/health (multi-tenant SaaS). */
  cloudMode: boolean;
  status?: string;
  error?: string;
}

export class TargetIsCloudError extends Error {
  readonly code = "TARGET_IS_CLOUD" as const;
  constructor(url: string) {
    super(
      `Refusing to migrate: ${url} is a multi-tenant Openship Cloud instance, not a self-hosted box. ` +
        `A whole-instance import would wipe every tenant.`,
    );
    this.name = "TargetIsCloudError";
  }
}

export class TargetUnreachableError extends Error {
  readonly code = "TARGET_UNREACHABLE" as const;
  constructor(url: string, cause: string) {
    super(`Migration target ${url} could not be verified (${cause}). Refusing to transfer.`);
    this.name = "TargetUnreachableError";
  }
}

/**
 * Probe `<baseUrl>/api/health` for the `cloudMode` flag. `baseUrl` is any origin
 * that reaches the target's API — a public URL, or `http://127.0.0.1:<port>` when
 * probing over an SSH loopback tunnel. Never throws (returns a result).
 */
export async function probeTarget(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TargetProbe> {
  const f = opts.fetchImpl ?? fetch;
  const url = baseUrl.replace(/\/+$/, "");
  try {
    const res = await f(`${url}/api/health`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10000) });
    const data = (await res.json().catch(() => ({}))) as { status?: string; cloudMode?: boolean };
    return { reachable: res.ok, cloudMode: data.cloudMode === true, status: data.status };
  } catch (err) {
    return { reachable: false, cloudMode: false, error: safeErrorMessage(err) };
  }
}

/**
 * GATE 3: throw unless the target is a REACHABLE, self-hosted (non-cloud) box.
 * Fail-closed — an unreachable target or a cloud target both refuse.
 */
export async function assertTargetNotCloud(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TargetProbe> {
  const probe = await probeTarget(baseUrl, opts);
  if (!probe.reachable) throw new TargetUnreachableError(baseUrl, probe.error ?? "no /api/health response");
  if (probe.cloudMode) throw new TargetIsCloudError(baseUrl);
  return probe;
}
