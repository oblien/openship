"use client";

/**
 * Reputation warm-up banner - sits at the top of the admin panel for the
 * first ~7 days after a domain starts sending, telling the operator that
 * early mail may land in spam while reputation builds. Dismissable;
 * dismissal and the warm-up start timestamp are kept in localStorage keyed
 * by `serverId:domain` so each domain on a multi-domain mail server has
 * its own independent banner + clock.
 *
 * Visual: amber-tinted card with a soft gradient, two short lines, an
 * "I know" dismiss link. Designed to read like a one-time editorial note
 * rather than an error or warning.
 */

import { useEffect, useState } from "react";
import { Clock3, X } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

const WARMUP_WINDOW_DAYS = 7;
export const REPUTATION_STORAGE_PREFIX = "openship:mail:reputation:";

/**
 * Per-domain localStorage key used by `ReputationBanner`. Exported so the
 * post-ack flow in DomainsTab can seed `installedAt = Date.now()` at the
 * moment the operator confirms DNS, which is when the new domain starts
 * accepting/sending mail in earnest.
 */
export function reputationStorageKey(serverId: string, domain: string): string {
  return `${REPUTATION_STORAGE_PREFIX}${serverId}:${domain}`;
}

interface ReputationBannerProps {
  serverId: string;
  domain: string;
}

interface StoredState {
  installedAt: number;
  dismissed: boolean;
}

function readState(key: string): StoredState | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredState;
    if (typeof parsed.installedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(key: string, state: StoredState) {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

export function ReputationBanner({ serverId, domain }: ReputationBannerProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!serverId || !domain || typeof window === "undefined") return;
    const key = reputationStorageKey(serverId, domain);
    const now = Date.now();
    let state = readState(key);

    if (!state) {
      state = { installedAt: now, dismissed: false };
      writeState(key, state);
    }

    if (state.dismissed) return;

    const elapsedDays = (now - state.installedAt) / (1000 * 60 * 60 * 24);
    if (elapsedDays >= WARMUP_WINDOW_DAYS) return;

    setVisible(true);
  }, [serverId, domain]);

  const dismiss = () => {
    const key = reputationStorageKey(serverId, domain);
    const current = readState(key) ?? { installedAt: Date.now(), dismissed: false };
    writeState(key, { ...current, dismissed: true });
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-warning-border bg-warning-bg">
      <div
        aria-hidden
        className="absolute -top-12 -end-12 size-44 rounded-full bg-warning-bg blur-3xl pointer-events-none"
      />
      <div className="relative flex items-start gap-3.5 p-4 pe-10 sm:pe-12">
        <div className="size-9 rounded-xl bg-warning-bg border border-warning-border flex items-center justify-center shrink-0">
          <Clock3
            className="size-4 text-warning"
            strokeWidth={2}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-warning leading-snug">
            {t.emailsAdmin.reputation.titlePrefix}
            <span className="font-mono font-medium">{domain}</span>
          </p>
          <p className="text-[13px] text-warning leading-relaxed mt-0.5">
            {t.emailsAdmin.reputation.body}
            <button
              type="button"
              onClick={dismiss}
              className="font-medium text-warning underline-offset-4 hover:underline"
            >
              {t.emailsAdmin.reputation.dismissLink}
            </button>
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t.emailsAdmin.reputation.dismiss}
          className="absolute top-3 end-3 p-1 rounded-md text-warning hover:bg-warning-bg transition-colors"
        >
          <X className="size-3.5" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}
