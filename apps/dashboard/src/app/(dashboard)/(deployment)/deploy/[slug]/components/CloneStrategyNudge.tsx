"use client";

/**
 * `useCloneStrategyGate` — reads the two saved signals the deploy sidebar needs
 * to resolve HOW a repo gets cloned for a self-hosted server deploy:
 *
 *   - `preference`     — the persisted clone-strategy choice
 *                        (`userSettings.cloneStrategyPreference`). "local" means
 *                        the user explicitly chose to build on the API host.
 *   - `hasGlobalToken` — whether a custom global PAT is saved.
 *
 * The sidebar combines these with live GitHub availability (gh CLI / Openship
 * App) to pick ONE path deterministically — it does not prompt when the answer
 * is knowable. The only UI is `<DeployCredentialModal>`, shown by the sidebar
 * solely for the genuine no-credential dead-end; that modal writes
 * `cloneStrategyPreference` back when the user picks.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useState } from "react";
import { settingsApi, type CloneStrategyPreference } from "@/lib/api";

interface CloneStrategyGateResult {
  /** Latest preference value (null while initial fetch is in flight). */
  preference: CloneStrategyPreference | null;
  /** True if the user has already saved a global PAT. */
  hasGlobalToken: boolean;
}

export function useCloneStrategyGate(): CloneStrategyGateResult {
  const [preference, setPreference] = useState<CloneStrategyPreference | null>(null);
  const [hasGlobalToken, setHasGlobalToken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await settingsApi.get();
        if (cancelled) return;
        setPreference(res.cloneStrategyPreference);
        setHasGlobalToken(res.cloneToken.hasToken);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/(deployment)/deploy/[slug]/components/CloneStrategyNudge");
        // Silent — these signals are advisory; the sidebar falls back to live
        // GitHub availability and, ultimately, the recovery modal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { preference, hasGlobalToken };
}
