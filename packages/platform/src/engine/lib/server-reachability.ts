/**
 * Per-operation reachability memo over the SINGLE connection authority
 * (`sshManager.probeReachable`). The actual check — config source, TCP probe,
 * circuit breaker — lives in `ssh-manager`; this only dedups repeated probes of
 * the same server within one op (e.g. a teardown manifest with several
 * deployments on the same host) so we don't re-probe N times.
 *
 * Deliberately NOT module-global: a cached "unreachable" must not outlive the
 * op, or a server that recovered would stay falsely marked down. Cross-op
 * fast-fail is already handled by the breaker cooldown inside ssh-manager.
 */
import { sshManager } from "./ssh-manager";

export interface ReachabilityProbe {
  isReachable(serverId: string): Promise<boolean>;
}

export function createReachabilityProbe(): ReachabilityProbe {
  const cache = new Map<string, Promise<boolean>>();
  return {
    isReachable(serverId: string): Promise<boolean> {
      const cached = cache.get(serverId);
      if (cached) return cached;
      const pending = sshManager.probeReachable(serverId);
      cache.set(serverId, pending);
      return pending;
    },
  };
}
