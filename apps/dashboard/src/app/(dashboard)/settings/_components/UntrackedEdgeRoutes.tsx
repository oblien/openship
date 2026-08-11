"use client";

/**
 * Untracked edge routes — hostnames this machine serves with no Openship record.
 *
 * Edge config lives on the host and outlives its DB rows on purpose: record-only
 * delete ("Remove from Openship only") keeps the workload AND its route running.
 * The leftover then has two very different failure modes, which is the whole
 * reason this card exists:
 *
 *   app route (proxy)  → the container is gone, so it 502s. Loud, self-announcing.
 *   static files       → the built output is still on disk, so it keeps answering
 *                        200 with the removed project's content — possibly on a
 *                        hostname since handed to another project. Silent.
 *
 * Static therefore sorts first (server-side) and is the row that gets the warning
 * tone. Removal is one named hostname at a time, never a sweep: a sweep would undo
 * exactly the guarantee that produced these.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileWarning, RefreshCw, Route, ServerOff, X } from "lucide-react";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage, systemApi, type EdgeOrphanScan, type UntrackedEdgeSite } from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { SettingsSection } from "./SettingsSection";

/** Same narrow cast DataTransferTab uses to reach the org plugin's member list. */
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: Array<{ userId: string; role: string }> } }>;
  };
}).organization;

export function UntrackedEdgeRoutes() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { data: session } = useSession();
  const copy = t.settings.edgeOrphans;

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [scan, setScan] = useState<EdgeOrphanScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<UntrackedEdgeSite | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    orgClient
      .listMembers()
      .then((res) => {
        if (cancelled) return;
        const me = res.data?.members?.find((m) => m.userId === session?.user?.id);
        setIsOwner(me?.role === "owner");
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await systemApi.listUntrackedEdgeSites();
      setScan(res.data);
    } catch (err) {
      // `scanned: false` carries its own reason; a transport failure is different,
      // so surface it rather than rendering a misleading "all clear".
      setScan({ scanned: false, reason: getApiErrorMessage(err, copy.unavailable), orphans: [], knownCount: 0 });
    } finally {
      setLoading(false);
    }
  }, [copy.unavailable]);

  // Owner-only, so don't spend an edge read until we know.
  useEffect(() => {
    if (isOwner === true) void refresh();
  }, [isOwner, refresh]);

  const remove = async (site: UntrackedEdgeSite) => {
    setRemoving(site.hostname);
    try {
      await systemApi.removeUntrackedEdgeSite(site.hostname);
      showToast(interpolate(copy.stopped, { hostname: site.hostname }), "success", copy.title);
      setConfirming(null);
      await refresh();
    } catch (err) {
      showToast(
        getApiErrorMessage(err, interpolate(copy.stopFailed, { hostname: site.hostname })),
        "error",
        copy.title,
      );
    } finally {
      setRemoving(null);
    }
  };

  // Same rule as DataTransferTab: non-owners see nothing rather than a denied card.
  if (isOwner !== true) return null;
  // Nothing to report and nothing to explain — don't take up space on the tab.
  if (scan?.scanned && scan.orphans.length === 0 && !loading) return null;

  return (
    <SettingsSection
      icon={Route}
      title={copy.title}
      description={copy.description}
      iconBg="bg-warning-bg"
      iconColor="text-warning"
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{copy.explain}</p>

        {!scan && loading && (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-xl bg-card p-4">
                <div className="h-4 w-48 rounded bg-muted" />
                <div className="mt-2 h-3 w-72 rounded bg-muted" />
              </div>
            ))}
          </div>
        )}

        {scan && !scan.scanned && (
          <div className="flex items-start gap-2 rounded-xl bg-muted/30 p-4">
            <ServerOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">{copy.unavailable}</p>
              {scan.reason && <p className="mt-0.5 text-xs text-muted-foreground">{scan.reason}</p>}
            </div>
          </div>
        )}

        {scan?.scanned &&
          scan.orphans.map((site) => {
            const isStatic = site.kind === "static";
            return (
              <div key={site.hostname} className="rounded-xl bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {isStatic ? (
                        <FileWarning className="size-4 shrink-0 text-warning" />
                      ) : (
                        <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate font-mono text-[13px] text-foreground">
                        {site.hostname}
                      </span>
                      <span
                        className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
                          isStatic ? "bg-warning-bg text-warning" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isStatic ? copy.kindStatic : copy.kindProxy}
                      </span>
                    </div>

                    <p className={`mt-1.5 text-xs ${isStatic ? "text-warning" : "text-muted-foreground"}`}>
                      {isStatic ? copy.staticWarning : copy.proxyWarning}
                    </p>

                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {isStatic ? copy.servingFrom : copy.proxyingTo}: {site.target}
                    </p>

                    {site.hostnames.length > 1 && (
                      <p className="mt-1 break-all text-[11px] text-muted-foreground">
                        {copy.alsoAnswers}:{" "}
                        {site.hostnames.filter((h) => h !== site.hostname).join(", ")}
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setConfirming(site)}
                    disabled={removing === site.hostname}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-danger-bg px-3 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger-bg disabled:opacity-50"
                  >
                    <X className="size-3.5" />
                    {removing === site.hostname ? copy.stopping : copy.stopServing}
                  </button>
                </div>

                {/* Inline confirm — this takes a hostname offline, so it states
                    exactly what is and isn't touched before the second click. */}
                {confirming?.hostname === site.hostname && (
                  <div className="mt-3 rounded-lg bg-danger-bg/40 p-3">
                    <p className="text-[13px] font-medium text-foreground">
                      {interpolate(copy.confirmTitle, { hostname: site.hostname })}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {copy.confirmBody}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void remove(site)}
                        disabled={removing === site.hostname}
                        className="rounded-lg bg-danger px-3 py-1.5 text-[12px] font-medium text-danger-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {removing === site.hostname ? copy.stopping : copy.confirmCta}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
                      >
                        {copy.cancel}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

        <div className="flex items-center justify-between gap-3">
          {scan?.scanned ? (
            <p className="text-[11px] text-muted-foreground">
              {interpolate(copy.comparedTo, { count: String(scan.knownCount) })}
            </p>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            {loading ? copy.scanning : copy.scan}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}
