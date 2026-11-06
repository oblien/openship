"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { ipAddressVersion } from "@repo/core";
import type { MailFail2banStatus } from "@repo/contracts";
import { reportCaughtError } from "@repo/core/diagnostics";
import { Icon } from "@repo/ui/icons";
import { mailAdminApi } from "@/lib/api";
import { getActiveOrganizationId, subscribeActiveOrganization } from "@/lib/api/client";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Skeleton } from "./_shared/skeleton";

type Change = { action: "ban" | "unban"; ip: string; jail: string };

export function Fail2banDrawer({
  serverId,
  isOpen,
  onClose,
}: {
  serverId: string;
  isOpen: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const organization = useSyncExternalStore(
    subscribeActiveOrganization,
    getActiveOrganizationId,
    () => null,
  );
  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      label={t.emailsAdmin.fail2ban.title}
      closeLabel={t.emailsAdmin.shared.close}
      width="640px"
    >
      {isOpen && <Fail2banPanel key={`${organization}:${serverId}`} serverId={serverId} />}
    </Drawer>
  );
}

/** Lazy, server-scoped reads. Neither opening Health nor its poll reads jail details. */
function Fail2banPanel({ serverId }: { serverId: string }) {
  const { t, locale, dir } = useI18n();
  const isolate = (value: string) => (dir === "rtl" ? `\u2066${value}\u2069` : value);
  const copy = t.emailsAdmin.fail2ban;
  const [status, setStatus] = useState<MailFail2banStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [jail, setJail] = useState("");
  const [ip, setIp] = useState("");
  const [review, setReview] = useState<Change | null>(null);
  const [acting, setActing] = useState(false);
  const request = useRef(0);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const canManage = status?.canManage === true && !loading && !error && !acting;

  const load = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await mailAdminApi.fail2ban.status(serverId);
      if (alive.current && sequence === request.current) setStatus(result);
    } catch (cause) {
      reportCaughtError(cause, "dashboard/emails/fail2ban-status");
      if (alive.current && sequence === request.current) {
        setError(cause instanceof Error ? cause.message : t.emailsAdmin.fail2ban.failed);
        setReview(null);
      }
    } finally {
      if (alive.current && sequence === request.current) setLoading(false);
    }
  }, [serverId, t.emailsAdmin.fail2ban.failed]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      request.current++;
    };
  }, [load]);

  function reviewBan(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !ipAddressVersion(ip.trim()) || !status?.jails.includes(jail)) return;
    setCompleted(false);
    setActionError(null);
    setReview({ action: "ban", ip: ip.trim(), jail });
  }

  async function apply() {
    if (!review || !canManage || inFlight.current) return;
    inFlight.current = true;
    setActing(true);
    setActionError(null);
    setCompleted(false);
    try {
      await mailAdminApi.fail2ban[review.action](serverId, review.ip, review.jail);
      if (!alive.current) return;
      setReview(null);
      setCompleted(true);
      if (review.action === "ban") setIp("");
    } catch (cause) {
      reportCaughtError(cause, "dashboard/emails/fail2ban-action");
      if (alive.current)
        setActionError(cause instanceof Error ? cause.message : t.emailsAdmin.shared.actionFailed);
    } finally {
      // A lost mutation response is uncertain too. Re-read rather than changing
      // the ban list optimistically or treating a timeout as proof of failure.
      if (alive.current) {
        await load();
        setActing(false);
      }
      inFlight.current = false;
    }
  }

  return (
    <>
      <header className="px-5 pt-6 pb-4 pe-16 rtl:pe-5 rtl:ps-16">
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5" aria-busy={loading}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {status &&
              interpolate(copy.checkedAt, {
                time: new Date(status.checkedAt).toLocaleTimeString(locale),
              })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setReview(null);
              void load();
            }}
            disabled={loading || acting}
          >
            <Icon name="refresh" className={loading ? "animate-spin" : ""} />
            {t.emailsAdmin.shared.reload}
          </Button>
        </div>
        {error && (
          <div role="alert" className="space-y-1 text-sm text-danger">
            <p>{copy.failed}</p>
            <p>{error}</p>
            {status && <p className="text-muted-foreground">{copy.stale}</p>}
          </div>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-danger">
            {actionError}
          </p>
        )}
        {completed && (
          <p role="status" className="text-sm text-muted-foreground">
            {copy.completed}
          </p>
        )}
        {!status && loading && (
          <div className="space-y-3" aria-label={copy.title}>
            <Skeleton className="h-28 w-full rounded-2xl" />
            <Skeleton className="h-28 w-full rounded-2xl" />
          </div>
        )}
        {status?.jails.length === 0 && !error && (
          <p className="py-5 text-sm text-muted-foreground">{copy.emptyJails}</p>
        )}
        {status?.jails.map((name) => {
          const detail = status.details[name];
          return (
            <section key={name} className="rounded-2xl bg-card p-4" aria-label={name}>
              <h3 className="break-all font-medium">{name}</h3>
              <dl className="my-4 grid grid-cols-3 gap-3 text-sm">
                {[
                  [copy.banned, detail.currentlyBanned],
                  [copy.failedNow, detail.currentlyFailed],
                  [copy.totalBans, detail.totalBanned],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              {detail.bannedIps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.emptyBans}</p>
              ) : (
                <ul className="divide-y divide-border/40">
                  {detail.bannedIps.map((address) => (
                    <li key={address} className="flex items-center justify-between gap-3 py-2">
                      <bdi dir="ltr" className="min-w-0 break-all font-mono text-xs">
                        {address}
                      </bdi>
                      {status.canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canManage}
                          aria-label={`${copy.unban} ${address} (${name})`}
                          onClick={() => {
                            setActionError(null);
                            setCompleted(false);
                            setReview({ action: "unban", ip: address, jail: name });
                          }}
                        >
                          {copy.unban}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {status && !status.canManage && (
          <p className="text-sm text-muted-foreground">{copy.readOnly}</p>
        )}
        {status?.canManage && status.jails.length > 0 && (
          <form onSubmit={reviewBan} className="space-y-3 rounded-2xl bg-card p-4">
            <h3 className="font-medium">{copy.ban}</h3>
            <label className="block space-y-1.5 text-sm">
              <span>{copy.jail}</span>
              <CustomSelect
                value={jail}
                onChange={(value) => {
                  setJail(value);
                  setReview(null);
                }}
                options={status.jails.map((value) => ({ value, label: value }))}
                placeholder={copy.chooseJail}
                aria-label={copy.jail}
                variant="filled"
                triggerClassName="bg-muted/60 hover:bg-muted"
                disabled={!canManage}
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>{copy.address}</span>
              <Input
                variant="filled"
                dir="ltr"
                value={ip}
                onChange={(event) => {
                  setIp(event.target.value);
                  setReview(null);
                }}
                placeholder="203.0.113.10"
                autoComplete="off"
                spellCheck={false}
                disabled={!canManage}
              />
            </label>
            <p className="text-xs text-muted-foreground">{copy.banHint}</p>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={!canManage || !status.jails.includes(jail) || !ipAddressVersion(ip.trim())}
            >
              {copy.reviewBan}
            </Button>
          </form>
        )}
      </div>
      {review && (
        <footer
          className="shrink-0 space-y-3 border-t border-border/50 bg-card px-5 py-4"
          aria-live="polite"
        >
          <p className="break-words text-sm">
            {interpolate(review.action === "ban" ? copy.banReview : copy.unbanReview, {
              ip: isolate(review.ip),
              jail: isolate(review.jail),
            })}
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={acting} onClick={() => setReview(null)}>
              {t.emailsAdmin.shared.cancel}
            </Button>
            <Button
              size="sm"
              variant={review.action === "ban" ? "destructive" : "default"}
              disabled={!canManage}
              onClick={() => void apply()}
            >
              {acting && <Icon name="spinner" className="animate-spin" />}
              {review.action === "ban" ? copy.ban : copy.unban}
            </Button>
          </div>
        </footer>
      )}
    </>
  );
}
