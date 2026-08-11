"use client";

import { useCallback, useState } from "react";

import { getApiErrorMessage } from "@/lib/api/client";
import { runResolution, type SystemIssue } from "@/lib/api/issues";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/components/toast";
import { useInfraFix } from "@/hooks/useInfraFix";

/**
 * Running a row's fix — shared by the feed page and the home attention card.
 *
 * The remediation itself arrives ON the row (`resolveWith` is a call, `infraFix` is a
 * modal flow), so all this owns is the wrapper every surface needs identically: which
 * mechanism, one row busy at a time, a confirm before anything destructive, and a
 * failure toast that prefers the server's own reason — several refusals are actionable
 * ("deploy this project first"), and a flat "try again" tells the operator to repeat
 * something that cannot work.
 *
 * It exists as a hook rather than a helper because both callers need the busy id to
 * render, and because that confirm is exactly the rule that must not have two copies.
 */
export function useIssueActions(
  /** Re-read the caller's own feed after a fix lands. */
  reload: (opts?: { silent?: boolean }) => void | Promise<void>,
) {
  const { t } = useI18n();
  const c = t.issues.toast;
  const { toast } = useToast();
  const openInfraFix = useInfraFix();
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Apply the item's first carried resolution, then refresh. */
  const resolve = useCallback(
    async (issue: SystemIssue) => {
      const fix = issue.resolveWith[0];
      if (!fix || busyId) return;
      if (fix.destructive && !window.confirm(c.confirmDestructive)) return;
      setBusyId(issue.id);
      try {
        await runResolution(fix);
        toast("success", c.resolved, c.title);
        await reload({ silent: true });
      } catch (err) {
        toast("error", getApiErrorMessage(err, c.resolveFailed), c.title);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, c, toast, reload],
  );

  /**
   * Managed containers fix through a streamed modal, not an HTTP call — the flow can
   * need consent (port takeover) and its log is the only useful failure report.
   */
  const infraFix = useCallback(
    (issue: SystemIssue) => {
      if (!issue.infraFix) return;
      openInfraFix(
        { ...issue.infraFix, label: issue.title },
        { onDone: () => void reload({ silent: true }) },
      );
    },
    [openInfraFix, reload],
  );

  return { busyId, resolve, infraFix };
}
