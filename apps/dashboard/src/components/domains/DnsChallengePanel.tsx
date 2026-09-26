"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import type { DomainDnsChallenge } from "@repo/contracts";
import { domainsApi, getApiErrorMessage } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import DnsRecordCard from "./DnsRecordCard";
import DnsConfiguration from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DnsConfiguration";
import type { DomainDnsRecord } from "@/lib/api/domains";

const working = (run: DomainDnsChallenge | null) =>
  !!run && ["preparing", "checking", "installing", "cancelling"].includes(run.status);
const active = (run: DomainDnsChallenge | null) => working(run) || run?.status === "waiting";

/** Poll only while a bounded worker runs. Waiting for user DNS has no worker,
 * auto-retry, open stream or repeated ACME order. Reopening loads the saved TXT. */
export default function DnsChallengePanel({
  domainId,
  hostname,
  mode = "automatic",
  renew = false,
  onChanged,
  onClose,
}: {
  domainId: string;
  hostname: string;
  mode?: "automatic" | "manual";
  renew?: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const c = t.projectSettings.domains.wildcard;
  const [run, setRun] = useState<DomainDnsChallenge | null>(null);
  const [selected, setSelected] = useState(mode);
  const [records, setRecords] = useState<DomainDnsRecord[] | undefined>();
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const completed = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const applyRun = useCallback((next: DomainDnsChallenge | null) => {
    setRun(next);
    if (next && active(next)) setSelected(next.mode);
    if (next?.status === "completed" && completed.current !== next.id) {
      completed.current = next.id;
      changed.current();
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const version = ++requestVersion.current;
    heading.current?.focus({ preventScroll: true });
    setLoading(true);
    setBusy(false);
    setRun(null);
    setRecords(undefined);
    setRecordsError(null);
    setError(null);
    // Saved TXT is control-plane state. Loading it must not wait for an SSH
    // connection used to discover the server's routing address.
    domainsApi
      .dnsChallenge(domainId)
      .then(({ data }) => {
        if (!stopped && version === requestVersion.current) applyRun(data);
      })
      .catch((err) => {
        if (!stopped && version === requestVersion.current)
          setError(getApiErrorMessage(err, c.loadFailed));
      })
      .finally(() => {
        if (!stopped && version === requestVersion.current) setLoading(false);
      });
    domainsApi
      .records(domainId)
      .then(({ data }) => {
        if (!stopped) setRecords(data.records);
      })
      .catch((err) => {
        if (!stopped) setRecordsError(getApiErrorMessage(err, c.recordsFailed));
      });
    return () => {
      stopped = true;
      requestVersion.current++;
    };
  }, [domainId, reload, applyRun, c.loadFailed, c.recordsFailed]);

  useEffect(() => {
    if (!working(run) || busy || error) return;
    let stopped = false;
    const version = requestVersion.current;
    const timer = setTimeout(() => {
      domainsApi
        .dnsChallenge(domainId)
        .then(({ data }) => {
          if (!stopped && version === requestVersion.current) applyRun(data);
        })
        .catch((err) => {
          if (!stopped && version === requestVersion.current)
            setError(getApiErrorMessage(err, c.loadFailed));
        });
    }, 2500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [domainId, run, busy, error, applyRun, c.loadFailed]);

  const act = async (action: "start" | "check" | "cancel") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const version = ++requestVersion.current;
    try {
      const result =
        action === "start"
          ? await domainsApi.startDnsChallenge(domainId, { mode: selected, force: renew })
          : action === "check"
            ? await domainsApi.checkDnsChallenge(domainId, run!.id)
            : await domainsApi.cancelDnsChallenge(domainId, run!.id);
      if (version === requestVersion.current) {
        applyRun(result.data);
        // Starting also changes the domain's renewal mode and diagnostics.
        if (action === "start" && result.data.status !== "completed") changed.current();
      }
    } catch (err) {
      if (version === requestVersion.current) setError(getApiErrorMessage(err, c.actionFailed));
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };
  const locked = busy || active(run);
  const button =
    "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section
      aria-label={`${c.title}: ${hostname}`}
      className="min-w-0 rounded-2xl bg-card p-5 sm:p-6"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3
            ref={heading}
            tabIndex={-1}
            className="text-base font-semibold text-foreground outline-none"
          >
            {c.title}
          </h3>
          <p className="mt-1 break-all font-mono text-sm text-muted-foreground">{hostname}</p>
          {hostname.startsWith("*.") && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.scope}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={c.close}
          className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      {loading ? (
        <div aria-label={c.loading} aria-busy="true" className="space-y-3 animate-pulse">
          <div className="h-5 w-2/3 rounded bg-muted" />
          <div className="h-20 rounded-xl bg-muted" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <h4 className="text-sm font-medium text-foreground">{c.routing}</h4>
            {recordsError ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-warning">
                  {recordsError}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setReload((value) => value + 1)}
                  className={`${button} bg-muted text-foreground`}
                >
                  <Icon name="refresh" className="size-4" />
                  {c.refresh}
                </button>
              </div>
            ) : records === undefined ? (
              <div
                aria-label={c.loading}
                aria-busy="true"
                className="h-24 animate-pulse rounded-xl bg-muted"
              />
            ) : (
              <DnsConfiguration
                domain={hostname}
                domainId={domainId}
                mode="selfhosted"
                records={records}
                showHeader={false}
              />
            )}
          </div>
          <div className="min-w-0 space-y-4">
            <h4 className="text-sm font-medium text-foreground">{c.certificate}</h4>
            <div
              className="flex gap-1 rounded-xl bg-muted/50 p-1"
              role="group"
              aria-label={c.certificate}
            >
              {(["automatic", "manual"] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={selected === choice}
                  disabled={locked}
                  onClick={() => setSelected(choice)}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed ${selected === choice ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {c[choice]}
                </button>
              ))}
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {selected === "manual" ? c.manualHint : c.automaticHint}
            </p>
            {selected === "automatic" && (
              <a
                href="/settings?tab=dns"
                className="inline-flex text-sm font-medium text-primary hover:underline"
              >
                {t.autoDns.connect}
              </a>
            )}
            {run && (
              <p
                role="status"
                className={`flex items-center gap-2 text-sm font-medium ${run.status === "completed" ? "text-success" : "text-foreground"}`}
              >
                {working(run) && <Icon name="spinner" className="size-4 animate-spin" />}
                {c.states[run.status]}
              </p>
            )}
            {run?.record && (
              <div className="space-y-3">
                <DnsRecordCard record={{ ...run.record, host: run.record.name }} />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {active(run) ? c.txtHint : c.cleanup}
                </p>
                {active(run) && (
                  <p className="text-sm text-muted-foreground">
                    {interpolate(c.expires, {
                      date: new Date(run.expiresAt).toLocaleString(locale),
                    })}
                  </p>
                )}
              </div>
            )}
            {run?.error && (
              <p role="alert" className="text-sm leading-relaxed text-warning">
                {run.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {!active(run) && (
                <button
                  type="button"
                  disabled={busy || !!error}
                  onClick={() => void act("start")}
                  className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
                >
                  {busy && <Icon name="spinner" className="size-4 animate-spin" />}
                  {renew ? c.renew : selected === "manual" ? c.startManual : c.startAutomatic}
                </button>
              )}
              {run?.status === "waiting" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act("check")}
                  className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
                >
                  {c.check}
                </button>
              )}
              {run?.mode === "manual" &&
                ["preparing", "waiting", "checking"].includes(run.status) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("cancel")}
                    className={`${button} bg-muted text-foreground hover:bg-muted/80`}
                  >
                    {c.cancel}
                  </button>
                )}
            </div>
            {run?.logs && (
              <details className="rounded-xl bg-muted/40 p-3">
                <summary className="cursor-pointer text-sm font-medium text-foreground">
                  {c.logs}
                </summary>
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-muted-foreground">
                  {run.logs}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="mt-4 space-y-2">
          <p role="alert" className="text-sm text-warning">
            {error}
          </p>
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => setReload((value) => value + 1)}
            className={`${button} bg-muted text-foreground`}
          >
            <Icon name="refresh" className="size-4" />
            {c.refresh}
          </button>
        </div>
      )}
    </section>
  );
}
