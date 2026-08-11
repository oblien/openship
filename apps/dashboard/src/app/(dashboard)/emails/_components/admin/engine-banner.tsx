"use client";

/**
 * Panel-level mail-engine notice — the answer to "the admin panel is throwing
 * errors and there is nothing I can press".
 *
 * Every tab in here talks to Postfix/Dovecot/vmail over SSH, so when the engine
 * isn't serving they ALL fail. Before this, each one discovered that separately
 * and printed its own red line (or, worse, a raw `No such container:
 * openship-mail-db`), and none of them offered a way out. One banner at the top of
 * the panel states the condition once and carries the single next step:
 *
 *   - engine present but stopped → **Start the engine**, dispatched through the
 *     shared {@link useInfraFix} repair path (`docker start` / `systemctl start`
 *     + re-verify :25/:993 — no reinstall, no config rewrite, safe on a live
 *     mailbox). Same code path as the Fix button in the fleet views.
 *   - no engine at all → the re-run-setup wizard entry, the only thing that can
 *     legitimately recreate one, and NOT something to fire off a banner click.
 *
 * Renders nothing when the engine is serving, and nothing when `engine` is absent
 * — absent means the probe couldn't conclude, and a failed read must never be
 * shown as a broken server.
 */

import Link from "next/link";
import { AlertTriangle, RotateCw, Wrench } from "lucide-react";

import type { MailEngineState } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { useInfraFix } from "@/hooks/useInfraFix";
import { useReattachActiveFix } from "@/hooks/useReattachActiveFix";

export function MailEngineBanner({
  serverId,
  engine,
  onRepaired,
}: {
  serverId: string;
  engine: MailEngineState | undefined;
  /** Re-read status once the repair session ends, so the banner clears itself. */
  onRepaired: () => void;
}) {
  const { t } = useI18n();
  const fix = useInfraFix();
  const c = t.emailsAdmin.engine;

  // Refresh recovery: if the mail-engine repair is already running (e.g. the
  // operator hit Start, then reloaded), re-open its live modal instead of just
  // re-showing this static banner. onRepaired clears the banner when it lands.
  // Called BEFORE the early return to satisfy rules-of-hooks.
  useReattachActiveFix({
    containerTargets: [
      { serverId, component: "mail", label: t.servers.containers.componentMail, onDone: onRepaired },
    ],
  });

  if (!engine || engine.running) return null;

  const gone = engine.flavor === "none";

  return (
    <div className="relative overflow-hidden rounded-2xl border border-danger-border bg-danger-bg">
      <div
        aria-hidden
        className="absolute -top-12 -end-12 size-44 rounded-full bg-danger-bg blur-3xl pointer-events-none"
      />
      <div className="relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="size-9 shrink-0 rounded-xl border border-danger-border bg-danger-bg flex items-center justify-center">
          <AlertTriangle className="size-4 text-danger" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold leading-snug text-danger">
            {gone ? c.missingTitle : c.downTitle}
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-danger/90">
            {gone ? c.missingBody : c.downBody}
          </p>
          {/* Why there is no container to look at on this box. */}
          {engine.flavor === "host" && (
            <p className="mt-1 text-[12px] leading-relaxed text-danger/75">{c.legacyNote}</p>
          )}
        </div>
        {gone ? (
          <Link
            href={`/emails?serverId=${encodeURIComponent(serverId)}&force=wizard`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-danger-solid px-3.5 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            <RotateCw className="size-3.5" />
            {c.rerunSetup}
          </Link>
        ) : (
          <button
            type="button"
            // No local "starting" state: the repair runs in the shared modal,
            // which owns the progress display, and `onDone` only fires on
            // SUCCESS — a local spinner here would stick forever on a failed
            // start. The banner clears itself when the refreshed status says the
            // engine is serving.
            onClick={() =>
              fix(
                { serverId, component: "mail", action: "repair", label: t.servers.containers.componentMail },
                { onDone: onRepaired },
              )
            }
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-danger-solid px-3.5 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            <Wrench className="size-3.5" />
            {c.start}
          </button>
        )}
      </div>
    </div>
  );
}
