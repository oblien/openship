"use client";

import { useCallback } from "react";

import { useContainerApplyModal, useServerEdgeInstallModal } from "./useSystemPrepareModal";

/** What to do with a managed component on one server. */
export interface InfraFixTarget {
  serverId: string;
  component: "edge" | "mail";
  /** `update` swaps onto the pinned image; `repair` brings a down component back. */
  action: "update" | "repair";
  /** Human label for the modal copy ("Edge", "Mail engine"). */
  label?: string;
}

/**
 * The ONE place that decides which flow fixes a managed container, so every
 * surface that offers a fix (home issues card, the per-server Components rows, the
 * Servers-tab fleet card) dispatches identically instead of each hardcoding a
 * modal.
 *
 * The routing rule, in one line each:
 * - edge + `repair` → the FIRST-INSTALL stream, because recovering an edge may
 *   require 80/443 takeover consent and that prompt only exists there. It also
 *   covers an absent edge (`docker rm -f` first, so a stopped leftover is replaced).
 * - mail + `repair` → the container-apply stream with `intent=repair`, which starts
 *   the stopped engine in place. Never the install path: mail's bring-up rewrites
 *   secret env-files and would destroy a live mailbox.
 * - anything + `update` → the container-apply stream (rollback-guarded image swap).
 *
 * A `containerMissing` mail engine has no fix here at all — callers must not offer
 * one, since recreating it needs the secrets only the mail-setup wizard holds.
 */
export function useInfraFix() {
  const openApply = useContainerApplyModal();
  const openEdgeInstall = useServerEdgeInstallModal();

  return useCallback(
    (target: InfraFixTarget, opts?: { onDone?: () => void }): string => {
      if (target.action === "repair" && target.component === "edge") {
        return openEdgeInstall(target.serverId, { onDone: opts?.onDone });
      }
      return openApply(target.serverId, target.component, {
        label: target.label,
        intent: target.action,
        onDone: opts?.onDone,
      });
    },
    [openApply, openEdgeInstall],
  );
}
