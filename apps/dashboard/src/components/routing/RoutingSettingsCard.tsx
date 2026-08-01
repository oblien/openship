"use client";

import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Globe, Shield, Server, Eye, EyeOff, Link2, Hash, CornerUpRight } from "lucide-react";
import { domainsApi } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";
import { useModal } from "@/context/ModalContext";
import { CustomSelect } from "@/components/ui/CustomSelect";
import DnsConfiguration from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DnsConfiguration";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { normalizeSubdomain, normalizeSubdomainInput } from "@/utils/subdomain";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

export interface RoutingSettingsCardProps {
  projectName: string;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
  targetMode?: "proxy" | "static";
  targetPath?: string;
  disabled?: boolean;
  liveUrl?: string | null;
  exposed?: boolean;
  onExposedChange?: (value: boolean) => void | Promise<void>;
  ports?: string[] | null;
  exposedPort?: string;
  readOnlyTarget?: {
    label: string;
    value: string;
    icon?: "port" | "path";
  };
  onExposedPortChange?: (value: string) => void | Promise<void>;
  onTargetPathChange?: (value: string) => void | Promise<void>;
  onDomainTypeChange: (value: "free" | "custom") => void | Promise<void>;
  onDomainChange: (value: string) => void | Promise<void>;
  onCustomDomainChange: (value: string) => void | Promise<void>;
  saveMode?: "change" | "explicit";
  /** Optional control rendered on the RIGHT of the Free/Custom row (e.g. an
   *  "add domain" button when the parent hides its own header). */
  actionSlot?: React.ReactNode;
  /** Place the exposed-port field to the RIGHT of the domain input (label above)
   *  instead of on its own row below — saves height when there's horizontal room. */
  portInline?: boolean;
  /** Hide the Free/Custom segmented — the caller drives `domainType` from its
   *  own outer control (avoids a redundant nested toggle). */
  hideTypeToggle?: boolean;
  /** Auto-clean a typed `www.` prefix off the custom hostname on commit — set for
   *  the PRIMARY/apex input only (never the `www.<apex>` variant endpoint, which
   *  would collapse into the apex). The `www.` variant is added via the card's own
   *  "Include www" switch, so a user typing `www.example.com` as their primary
   *  gets `example.com` + the toggle, not a conflicting duplicate route. */
  stripWww?: boolean;
  /**
   * Canonical redirect: serve a 30x to another of the project's hostnames instead
   * of the app. Omit the whole prop to hide the control — the parent decides
   * whether it applies (there's nothing to redirect to with one hostname, and
   * Openship Cloud owns routing for cloud projects, so it's refused there).
   *
   * `targets` are the project's OTHER hostnames; picking "" means serve normally.
   */
  redirect?: {
    to: string;
    status: number;
    targets: string[];
    onChange: (next: { to: string; status: number }) => void | Promise<void>;
  };
}

export function RoutingSettingsCard({
  projectName,
  domain,
  customDomain,
  domainType,
  targetMode = "proxy",
  targetPath,
  disabled = false,
  exposed,
  onExposedChange,
  ports,
  exposedPort,
  readOnlyTarget,
  onExposedPortChange,
  onTargetPathChange,
  onDomainTypeChange,
  onDomainChange,
  onCustomDomainChange,
  saveMode = "change",
  actionSlot,
  portInline = false,
  hideTypeToggle = false,
  stripWww = false,
  redirect,
}: RoutingSettingsCardProps) {
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const w = t.widgets.routing.settingsCard;
  const portListId = useId();
  const { showModal } = useModal();
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [dnsMode, setDnsMode] = useState<"cloud" | "selfhosted" | "external">("cloud");
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [draftDomain, setDraftDomain] = useState(domain);
  const [draftCustomDomain, setDraftCustomDomain] = useState(customDomain);
  const [draftPort, setDraftPort] = useState(exposedPort ?? "");
  const [draftTargetPath, setDraftTargetPath] = useState(targetPath ?? "/");

  useEffect(() => {
    setDraftDomain(domain);
  }, [domain]);

  useEffect(() => {
    setDraftCustomDomain(customDomain);
  }, [customDomain]);

  useEffect(() => {
    setDraftPort(exposedPort ?? "");
  }, [exposedPort]);

  useEffect(() => {
    setDraftTargetPath(targetPath ?? "/");
  }, [targetPath]);

  const visible = exposed ?? true;
  const hasPortOptions = (ports ?? []).length > 0;
  const showsPortTarget = targetMode === "proxy" && typeof exposedPort !== "undefined" && onExposedPortChange;
  const showsPathTarget = targetMode === "static" && onTargetPathChange;
  const showsReadOnlyTarget = !showsPortTarget && !showsPathTarget && Boolean(readOnlyTarget?.value);
  const portOptions = useMemo(
    () => (ports ?? []).map((value) => {
      const parts = value.split(":");
      return parts.length === 2 ? parts[1].split("/")[0] : parts[0].split("/")[0];
    }),
    [ports],
  );

  const previewHostname = domainType === "custom" ? draftCustomDomain : "";
  const freePreview = `${draftDomain || projectName || "my-project"}.${baseDomain}`;

  const fetchRecords = useCallback(async (hostname: string) => {
    if (!hostname || hostname.length < 3 || !hostname.includes(".")) return;
    setLoadingRecords(true);
    try {
      const res = await domainsApi.previewRecords(hostname);
      setDnsRecords(res.data.records);
      setDnsMode(res.data.mode);
    } catch {
      setDnsRecords([]);
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useEffect(() => {
    if (domainType !== "custom" || !previewHostname) {
      setDnsRecords([]);
      return;
    }

    const timer = setTimeout(() => {
      void fetchRecords(previewHostname);
    }, 400);

    return () => clearTimeout(timer);
  }, [domainType, previewHostname, fetchRecords]);

  const hasRecords = dnsRecords.length > 0 && dnsRecords.every((record) => record.value);

  // "View DNS" → the shared glassy modal, reusing the DnsConfiguration record
  // card so this and the pre-deploy DNS modal are one implementation / one look.
  const openDnsRecords = () => {
    showModal({
      maxWidth: "560px",
      showCloseButton: true,
      customContent: (
        <div className="p-5">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Server className="size-4 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">{w.dnsConfiguration}</h3>
              <p className="text-xs text-muted-foreground">
                {interpolate(w.addRecordsFor, { hostname: previewHostname })}
              </p>
            </div>
          </div>
          <DnsConfiguration
            domain={previewHostname}
            records={dnsRecords}
            mode={dnsMode === "cloud" ? "cloud" : "selfhosted"}
            showHeader={false}
          />
        </div>
      ),
    });
  };

  const commitFreeDomain = () => {
    const next = normalizeSubdomain(draftDomain);
    void onDomainChange(next);
  };

  // Clean a typed `www.` off the PRIMARY hostname (apex input only) — see stripWww.
  const cleanCustomHost = (value: string) => {
    const lowered = value.toLowerCase();
    return stripWww ? lowered.replace(/^www\./, "") : lowered;
  };

  const commitCustomDomain = () => {
    const cleaned = cleanCustomHost(draftCustomDomain);
    if (cleaned !== draftCustomDomain) setDraftCustomDomain(cleaned);
    void onCustomDomainChange(cleaned);
  };

  // Strip on blur (not per-keystroke, which would fight the user typing "www.").
  // Explicit mode commits the draft; change mode re-commits the already-live value.
  const handleCustomDomainBlur = () => {
    if (saveMode === "explicit") {
      if (draftCustomDomain !== customDomain || cleanCustomHost(draftCustomDomain) !== draftCustomDomain) {
        commitCustomDomain();
      }
    } else if (stripWww) {
      const cleaned = cleanCustomHost(customDomain);
      if (cleaned !== customDomain) void onCustomDomainChange(cleaned);
    }
  };

  const commitPort = () => {
    if (onExposedPortChange) {
      void onExposedPortChange(draftPort);
    }
  };

  const commitTargetPath = () => {
    if (onTargetPathChange) {
      void onTargetPathChange(draftTargetPath.trim() || "/");
    }
  };

  // Exposed-port field placed to the RIGHT of the domain input. No label above
  // (it used to float over empty space beside the label-less domain input); the
  // placeholder + aria-label carry the meaning and both fields are a plain h-11
  // so the row aligns cleanly with no dead whitespace.
  const portInlineField = showsPortTarget ? (
    <div className="shrink-0">
      <input
        type="text"
        inputMode="numeric"
        aria-label={w.exposedPort}
        title={w.exposedPort}
        value={saveMode === "explicit" ? draftPort : exposedPort}
        onChange={(event) => {
          if (saveMode === "explicit") setDraftPort(event.target.value);
          else void onExposedPortChange!(event.target.value);
        }}
        onBlur={() => {
          if (saveMode === "explicit" && draftPort !== (exposedPort ?? "")) commitPort();
        }}
        placeholder={w.exposedPort}
        disabled={disabled}
        list={hasPortOptions ? portListId : undefined}
        className="w-24 h-11 rounded-2xl border border-border/50 bg-background/60 px-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
      />
      {hasPortOptions && (
        <datalist id={portListId}>
          {portOptions.map((port) => (
            <option key={port} value={port} />
          ))}
        </datalist>
      )}
    </div>
  ) : null;

  // Canonical-redirect row. A redirecting hostname serves nothing of its own — it
  // answers a 30x to another hostname of the SAME project — so the target list is
  // closed (never a free-text host, which would be an open redirect) and the
  // status picker only appears once a target is chosen.
  const redirectRow =
    redirect && redirect.targets.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <CornerUpRight className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-muted-foreground">{w.redirectTo}</span>
        </div>
        <div className="min-w-[190px] flex-1">
          <CustomSelect
            value={redirect.to}
            onChange={(next) => void redirect.onChange({ to: next, status: redirect.status || 301 })}
            options={[
              { value: "", label: w.redirectServeApp },
              ...redirect.targets.map((target) => ({
                value: target,
                label: interpolate(w.redirectToHost, { hostname: target }),
              })),
            ]}
          />
        </div>
        {redirect.to ? (
          <div className="w-[132px]">
            <CustomSelect
              value={String(redirect.status || 301)}
              onChange={(next) => void redirect.onChange({ to: redirect.to, status: Number(next) })}
              options={[
                { value: "301", label: w.redirectPermanent },
                { value: "302", label: w.redirectTemporary },
              ]}
            />
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div className="space-y-3">
      {typeof exposed === "boolean" && onExposedChange && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {visible ? <Eye className="size-4 text-info" /> : <EyeOff className="size-4 text-muted-foreground" />}
            <span className="text-sm font-medium text-foreground">
              {visible ? w.publiclyExposed : w.internalOnly}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void onExposedChange(!visible)}
            disabled={disabled}
            className={`relative rounded-full transition-colors duration-200 ${visible ? "bg-info-solid" : "bg-muted-foreground/20"}`}
            style={{ height: "22px", width: "40px" }}
          >
            <span className={`absolute top-0.5 start-0.5 w-[18px] h-[18px] rounded-full bg-background shadow-sm transition-transform duration-200 ${visible ? "translate-x-[18px] rtl:-translate-x-[18px]" : "translate-x-0"}`} />
          </button>
        </div>
      )}

      {visible && (
        <div className="space-y-2">
          {(!hideTypeToggle || (!portInline && actionSlot)) && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {!hideTypeToggle && (
                  <>
                    <button
                      type="button"
                      onClick={() => void onDomainTypeChange("free")}
                      disabled={disabled}
                      aria-label={w.freeSubdomain}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${domainType === "free" ? "bg-primary/10 text-primary ring-1 ring-primary/15" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}
                    >
                      {w.free}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDomainTypeChange("custom")}
                      disabled={disabled}
                      aria-label={w.customDomain}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${domainType === "custom" ? "bg-primary/10 text-primary ring-1 ring-primary/15" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}
                    >
                      {w.custom}
                    </button>
                  </>
                )}
              </div>
              {/* When the port is inline, the add-domain "+" moves to the end of
                  the input row (after Exposed port); otherwise it sits here. */}
              {!portInline && actionSlot}
            </div>
          )}

          {domainType === "free" ? (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <div className="flex-1 flex items-center rounded-2xl border border-border/50 bg-background/60 overflow-hidden h-11">
                  <input
                    value={saveMode === "explicit" ? draftDomain : domain}
                    onChange={(event) => {
                      const next = normalizeSubdomainInput(event.target.value);
                      if (saveMode === "explicit") {
                        setDraftDomain(next);
                      } else {
                        void onDomainChange(next);
                      }
                    }}
                    onBlur={() => {
                      // Commit on blur so a typed change isn't silently lost if the
                      // modal is closed without clicking the inline Save pill.
                      if (saveMode === "explicit" && draftDomain !== domain) commitFreeDomain();
                    }}
                    placeholder={projectName || "my-project"}
                    className="min-w-0 flex-1 h-full ps-3.5 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                  />
                  <span className="shrink-0 ps-2 pe-3.5 text-sm text-muted-foreground">.{baseDomain}</span>
                </div>
                {saveMode === "explicit" && draftDomain !== domain && (
                  <button
                    type="button"
                    onClick={commitFreeDomain}
                    disabled={disabled}
                    className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {w.save}
                  </button>
                )}
              </div>
              {portInline && portInlineField}
              {portInline && actionSlot}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <div className="flex-1 flex items-center rounded-2xl border border-border/50 bg-background/60 overflow-hidden h-11">
                  <input
                    value={saveMode === "explicit" ? draftCustomDomain : customDomain}
                    onChange={(event) => {
                      const next = event.target.value.toLowerCase();
                      if (saveMode === "explicit") {
                        setDraftCustomDomain(next);
                      } else {
                        void onCustomDomainChange(next);
                      }
                    }}
                    onBlur={handleCustomDomainBlur}
                    placeholder="app.example.com"
                    className="flex-1 h-full px-3.5 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                  />
                </div>
                {saveMode === "explicit" && draftCustomDomain !== customDomain && (
                  <button
                    type="button"
                    onClick={commitCustomDomain}
                    disabled={disabled}
                    className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {w.save}
                  </button>
                )}
                </div>
                {portInline && portInlineField}
                {portInline && actionSlot}
              </div>

              {/* DNS hint — shown ONLY once records actually resolve. The
                  "checking…" loading state was dropped: it flashed on every
                  keystroke and jittered the card height. DNS isn't required up
                  front (verified later at preflight / in domain settings). */}
              {hasRecords && (
                <div className="rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Server className="size-3 text-muted-foreground shrink-0" />
                    <p className="text-sm text-muted-foreground flex-1">
                      {interpolate(w.addRecordHint, {
                        primary: dnsRecords.find((record) => record.type !== "TXT")?.type ?? "",
                        txt: "TXT",
                      })}
                    </p>
                    {hasRecords && (
                      <button
                        type="button"
                        onClick={openDnsRecords}
                        className="text-xs text-primary hover:text-primary/80 font-medium shrink-0 transition-colors"
                      >
                        {w.viewRecords}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {redirectRow}

          {!portInline && showsPortTarget && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Hash className="size-3.5 text-muted-foreground" />
                <span className="text-[13px] text-muted-foreground font-medium">{w.exposedPort}</span>
              </div>
              <input
                type="text"
                inputMode="numeric"
                value={saveMode === "explicit" ? draftPort : exposedPort}
                onChange={(event) => {
                  if (saveMode === "explicit") {
                    setDraftPort(event.target.value);
                  } else {
                    void onExposedPortChange(event.target.value);
                  }
                }}
                onBlur={() => {
                  if (saveMode === "explicit" && draftPort !== (exposedPort ?? "")) commitPort();
                }}
                placeholder="3000"
                disabled={disabled}
                list={hasPortOptions ? portListId : undefined}
                className="w-24 px-3 py-2 rounded-xl text-sm bg-muted/30 border border-border/40 text-foreground outline-none"
              />
              {hasPortOptions && (
                <datalist id={portListId}>
                  {portOptions.map((port) => (
                    <option key={port} value={port} />
                  ))}
                </datalist>
              )}
              {saveMode === "explicit" && draftPort !== (exposedPort ?? "") && (
                <button
                  type="button"
                  onClick={commitPort}
                  disabled={disabled}
                  className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {w.save}
                </button>
              )}
            </div>
          )}

          {showsReadOnlyTarget && readOnlyTarget ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {readOnlyTarget.icon === "path" ? (
                  <Link2 className="size-3.5 text-muted-foreground" />
                ) : (
                  <Hash className="size-3.5 text-muted-foreground" />
                )}
                <span className="text-[13px] text-muted-foreground font-medium">
                  {readOnlyTarget.label}
                </span>
              </div>
              <span className="text-[13px] font-medium text-foreground">
                {readOnlyTarget.value}
              </span>
            </div>
          ) : null}

          {showsPathTarget && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Link2 className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] text-muted-foreground font-medium">{w.staticPath}</span>
                </div>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    value={saveMode === "explicit" ? draftTargetPath : (targetPath || "/")}
                    onChange={(event) => {
                      if (saveMode === "explicit") {
                        setDraftTargetPath(event.target.value);
                      } else {
                        void onTargetPathChange(event.target.value || "/");
                      }
                    }}
                    placeholder="/"
                    disabled={disabled}
                    className="flex-1 px-3 py-2 rounded-xl text-sm bg-muted/30 border border-border/40 text-foreground outline-none"
                  />
                  {saveMode === "explicit" && draftTargetPath !== (targetPath ?? "/") && (
                    <button
                      type="button"
                      onClick={commitTargetPath}
                      disabled={disabled}
                      className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {w.save}
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {interpolate(w.staticPathHint, { path: "/" })}
              </p>
            </div>
          )}

        </div>
      )}
    </div>
  );
}
