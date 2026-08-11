"use client";

/**
 * Sending tab — the outbound path for a self-hosted mail server.
 *
 * Receiving (MX / IMAP / DKIM / DMARC / PTR) is unchanged by anything here — it
 * always stays on this server. This tab only decides how outbound mail LEAVES:
 *   - Direct delivery (default): Postfix delivers to each MX itself.
 *   - Relay: Postfix hands off to a smarthost (any provider in the registry, or a
 *     plain SMTP server), and the DNS tab gains that provider's send-hop records.
 *
 * Layout is main + sticky aside: the aside owns the DECISION (direct vs relay),
 * the live summary of what's about to be saved, and the actions; the main column
 * owns the configuration. Nothing here is applied until the aside's button is
 * pressed, which is why the summary reads from form state rather than the server's.
 *
 * Provider differences are DATA, not branches: `@repo/core`'s RELAY_PROVIDERS says
 * whether a provider is regional (region field) or fixed-host (host field), which
 * SPF token it publishes (and so whether the operator must supply one), whether it
 * issues DKIM CNAMEs, and whether it supports a custom MAIL FROM domain. Adding a
 * provider is a registry entry — this file does not learn its name.
 *
 * The `contact@example.com` case: scope "selected" accepts whole domains AND
 * single addresses, so one mailbox can send through an external provider while
 * still receiving (IMAP) here. `@repo/core`'s relay-senders helpers are the same
 * ones the API validates with, so this form can't accept what the server rejects.
 * All backed by /mail/admin/:serverId/relay.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, Send, ShieldCheck, Trash2, X } from "lucide-react";
import {
  hasRelaySelection,
  implicitTlsUnsupported,
  isSenderAddress,
  normalizeSenderAddress,
  relayedDomainsFor,
  relayProvider,
  relayProviderSpfInclude,
  resolveRelayHost,
} from "@repo/core";
import { mailAdminApi, getApiErrorMessage } from "@/lib/api";
import type { AdminDomain, ConfigureRelayPayload, OutboundRelayStatus } from "@/lib/api/mail-admin";
import { MAIL_PROVIDERS, mailProvider, type MailProviderId } from "@/lib/mail-providers";
import { AppLogo } from "@/components/AppLogo";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";

// Smarthost-capable presets only: the send-only relays + a plain SMTP server.
// Gmail/Fastmail are mailbox providers, not smarthosts.
const RELAY_PRESETS = MAIL_PROVIDERS.filter((p) => p.sendOnly || p.id === "custom");

/** Which outbound path the operator is choosing — not yet what's live. */
type Mode = "direct" | "relay";

type DkimRow = { name: string; value: string };
/** One domain's identity AT THE PROVIDER: MAIL FROM subdomain + DKIM CNAME rows. */
type Identity = { mailFrom: string; dkim: DkimRow[] };
const emptyDkim = (): DkimRow[] => [
  { name: "", value: "" },
  { name: "", value: "" },
  { name: "", value: "" },
];
const emptyIdentity = (): Identity => ({ mailFrom: "", dkim: emptyDkim() });
const padDkim = (rows?: { name: string; value: string }[]): DkimRow[] => {
  const src = rows ?? [];
  return [0, 1, 2].map((i) => src[i] ?? { name: "", value: "" });
};
const dkimToArr = (rows: DkimRow[]) =>
  rows.filter((r) => r.name.trim() && r.value.trim()).map((r) => ({ name: r.name.trim(), value: r.value.trim() }));

/** The UI preset for a saved relay id (several presets share `custom`). */
const presetForRelay = (relay: OutboundRelayStatus): MailProviderId =>
  relay.provider === "custom"
    ? "custom"
    : MAIL_PROVIDERS.find((p) => p.backendProvider === relay.provider)?.id ?? "custom";

export function SendingTab({ serverId, primaryDomain }: { serverId: string; primaryDomain: string }) {
  const { t } = useI18n();
  const s = t.emailsAdmin.sending;
  const { showToast } = useToast();
  // Heading lives in the page header in mail view — see ../../_lib/mail-section.
  const hoisted = useMailRailOwnsTabs(serverId);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<OutboundRelayStatus | null>(null);
  const [domainList, setDomainList] = useState<AdminDomain[]>([]);

  const [mode, setMode] = useState<Mode>("direct");
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [addressDraft, setAddressDraft] = useState("");
  const [providerId, setProviderId] = useState<MailProviderId>("ses");
  const [region, setRegion] = useState("us-east-1");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [spfInclude, setSpfInclude] = useState("");
  // Identity per domain (primary + each relayed additional domain).
  const [identities, setIdentities] = useState<Record<string, Identity>>({});
  const getIdentity = (d: string): Identity => identities[d] ?? emptyIdentity();
  const setIdentity = (d: string, next: Identity) => setIdentities((cur) => ({ ...cur, [d]: next }));

  const preset = mailProvider(providerId);
  // Everything provider-specific comes from the registry, not from an id check.
  const spec = relayProvider(preset.backendProvider);

  const seedFromStatus = useCallback(
    (relay: OutboundRelayStatus | null) => {
      if (!relay) return;
      setMode(relay.enabled ? "relay" : "direct");
      setProviderId(presetForRelay(relay));
      setScope(relay.scope === "selected" ? "selected" : "all");
      setSelectedDomains(relay.domains ?? []);
      setAddresses(relay.addresses ?? []);
      setRegion(relay.region ?? "us-east-1");
      setHost(relay.host ?? "");
      setPort(String(relay.port ?? 587));
      setUsername(relay.username ?? "");
      setSpfInclude(relay.spfInclude ?? "");
      // Primary identity lives in the top-level fields; additional domains in `identities`.
      const seeded: Record<string, Identity> = {
        [primaryDomain]: { mailFrom: relay.mailFromDomain ?? "", dkim: padDkim(relay.sesDkim) },
      };
      for (const [d, id] of Object.entries(relay.identities ?? {})) {
        seeded[d] = { mailFrom: id.mailFromDomain ?? "", dkim: padDkim(id.sesDkim) };
      }
      setIdentities(seeded);
    },
    [primaryDomain],
  );

  useEffect(() => {
    let cancelled = false;
    mailAdminApi.domains
      .list(serverId)
      .then((r) => !cancelled && setDomainList(r.domains ?? []))
      .catch(() => {});
    mailAdminApi.relay
      .get(serverId)
      .then((r) => {
        if (cancelled) return;
        setCurrent(r.relay);
        seedFromStatus(r.relay);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [serverId, seedFromStatus]);

  // Prefill from the REGISTRY, not the mailbox catalog: the send side's default
  // port is the STARTTLS one (a 465 default would be unusable for a scoped relay),
  // and regional providers derive their host from the region instead.
  const onProvider = (id: MailProviderId) => {
    setProviderId(id);
    const next = relayProvider(mailProvider(id).backendProvider);
    setHost(next.regional ? "" : next.hostTemplate ?? "");
    setPort(String(next.defaultPort));
    setUsername(next.username ?? "");
    setSpfInclude(""); // the previous provider's token means nothing to this one
  };

  const toggleDomain = (d: string) =>
    setSelectedDomains((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const addAddress = () => {
    const value = normalizeSenderAddress(addressDraft);
    if (!isSenderAddress(value)) return;
    setAddresses((cur) => (cur.includes(value) ? cur : [...cur, value]));
    setAddressDraft("");
  };
  const draftInvalid = addressDraft.trim() !== "" && !isSenderAddress(addressDraft);

  const portNum = Number(port);
  const portOk = /^\d{1,5}$/.test(port) && portNum >= 1 && portNum <= 65535;
  // Mirrors the API's rule exactly (same helper): implicit TLS is server-wide, so
  // it can't coexist with a live direct-to-MX path.
  const portBlocked = implicitTlsUnsupported({ scope, port: portNum });
  const selectionOk = scope === "all" || hasRelaySelection({ domains: selectedDomains, addresses });
  const targetOk = spec.regional ? region.trim() !== "" : host.trim() !== "";
  const canSave =
    portOk &&
    !portBlocked &&
    selectionOk &&
    targetOk &&
    username.trim() !== "" &&
    (!!current?.hasPassword || password.trim() !== "");

  /** Domains that will carry the send-hop DNS — address domains included. */
  const relayedDomains = useMemo(
    () =>
      scope === "all"
        ? domainList.map((d) => d.domain)
        : relayedDomainsFor({ domains: selectedDomains, addresses }),
    [scope, domainList, selectedDomains, addresses],
  );

  const effectiveHost = resolveRelayHost({ provider: spec.id, host, region });
  const effectiveInclude = relayProviderSpfInclude({ provider: spec.id, spfInclude });

  const save = async () => {
    setSaving(true);
    try {
      // Primary domain's identity → top-level; every other relayed domain → identities
      // map. Skipped entirely for a provider that issues no records: the state was
      // seeded from whatever was saved before, and re-sending it would republish the
      // old provider's CNAMEs on the DNS tab under the new one.
      const primaryId = identities[primaryDomain];
      const identitiesPayload: Record<string, { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] }> = {};
      if (spec.providerDkim || spec.mailFrom) {
        for (const d of relayedDomains) {
          if (d === primaryDomain) continue;
          const id = identities[d];
          if (!id) continue;
          const dk = spec.providerDkim ? dkimToArr(id.dkim) : [];
          const mailFrom = spec.mailFrom ? id.mailFrom.trim() : "";
          if (mailFrom || dk.length) {
            identitiesPayload[d] = { mailFromDomain: mailFrom || undefined, sesDkim: dk };
          }
        }
      }
      // One payload for every provider — the registry already decided which fields
      // mean anything, and the API validates the same way.
      const payload: ConfigureRelayPayload = {
        provider: spec.id,
        scope,
        domains: scope === "selected" ? selectedDomains : undefined,
        addresses: scope === "selected" ? addresses : undefined,
        region: spec.regional ? region.trim() : undefined,
        host: spec.regional ? undefined : host.trim(),
        port: portNum,
        username: username.trim(),
        password: password || undefined,
        // Persist an override only when it differs from the provider's own token,
        // so the stored row doesn't pin a value the registry may later correct.
        spfInclude: spfInclude.trim() && spfInclude.trim() !== spec.spfInclude ? spfInclude.trim() : undefined,
        mailFromDomain: spec.mailFrom ? primaryId?.mailFrom.trim() || undefined : undefined,
        sesDkim: spec.providerDkim && primaryId ? dkimToArr(primaryId.dkim) : [],
        identities: Object.keys(identitiesPayload).length ? identitiesPayload : undefined,
      };
      const res = await mailAdminApi.relay.save(serverId, payload);
      setCurrent(res.relay);
      setPassword("");
      setMode("relay");
      showToast(effectiveInclude || spec.providerDkim ? `${s.saved} ${s.dnsHint}` : s.saved, "success", s.title);
    } catch (err) {
      showToast(getApiErrorMessage(err, s.saveFailed), "error", s.title);
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    setSaving(true);
    try {
      await mailAdminApi.relay.disable(serverId);
      setCurrent(null);
      setPassword("");
      setMode("direct");
      showToast(s.disabled, "success", s.title);
    } catch (err) {
      showToast(getApiErrorMessage(err, s.disableFailed), "error", s.title);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        <div className="h-64 animate-pulse rounded-2xl border border-border/50 bg-card" />
        <div className="h-64 animate-pulse rounded-2xl border border-border/50 bg-card" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!hoisted && (
        <div>
          <h3 className="text-lg font-semibold text-foreground">{s.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{s.subtitle}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        {/* ── Main column: configuration ─────────────────────────────────── */}
        <div className="min-w-0 space-y-5">
          {mode === "direct" ? (
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Send className="size-4 text-muted-foreground" strokeWidth={1.8} />
                {s.modeDirectTitle}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.modeDirectDesc}</p>
              <div className="mt-4 rounded-xl bg-info-bg/60 px-4 py-3.5">
                <p className="text-sm font-medium text-info">{s.modeRelayTitle}</p>
                <p className="mt-1 text-xs leading-relaxed text-info/90">{s.modeRelayDesc}</p>
                <button
                  type="button"
                  onClick={() => setMode("relay")}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <ShieldCheck className="size-4" strokeWidth={1.8} />
                  {s.setUpRelay}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Which senders relay */}
              <div className="space-y-4 rounded-2xl border border-border/50 bg-card p-5">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">{s.sendersTitle}</h4>
                  <p className="mt-0.5 text-xs text-muted-foreground/80">
                    {scope === "all" ? s.scopeAllHint : s.scopeSelectedHint}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-1 rounded-xl border border-border/50 bg-muted/25 p-1">
                  {(["all", "selected"] as const).map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setScope(val)}
                      aria-pressed={scope === val}
                      className={`rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                        scope === val
                          ? "bg-card text-foreground shadow-sm ring-1 ring-inset ring-border/70"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {val === "all" ? s.scopeAll : s.scopeSelected}
                    </button>
                  ))}
                </div>

                {scope === "selected" && (
                  <div className="space-y-4">
                    {/* Whole domains */}
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {s.sendersDomains}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {domainList.length === 0 && (
                          <span className="text-xs text-muted-foreground/70">{s.noDomains}</span>
                        )}
                        {domainList.map((d) => {
                          const on = selectedDomains.includes(d.domain);
                          return (
                            <button
                              key={d.domain}
                              type="button"
                              onClick={() => toggleDomain(d.domain)}
                              aria-pressed={on}
                              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] transition-all ${
                                on
                                  ? "border-primary/40 bg-primary/[0.06] text-foreground"
                                  : "border-border/50 text-muted-foreground hover:bg-muted/30"
                              }`}
                            >
                              <span className={`size-1.5 rounded-full ${on ? "bg-primary" : "bg-muted-foreground/30"}`} />
                              {d.domain}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Individual senders — the contact@example.com case */}
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {s.sendersAddresses}
                      </p>
                      <p className="text-xs leading-relaxed text-muted-foreground/80">{s.sendersAddressesHint}</p>
                      {addresses.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {addresses.map((a) => (
                            <span
                              key={a}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/[0.06] px-2.5 py-1.5 text-[13px] text-foreground"
                            >
                              {a}
                              <button
                                type="button"
                                onClick={() => setAddresses((cur) => cur.filter((x) => x !== a))}
                                aria-label={`${s.removeSender} ${a}`}
                                className="text-muted-foreground transition-colors hover:text-danger"
                              >
                                <X className="size-3.5" strokeWidth={2} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-2 pt-0.5">
                        <input
                          value={addressDraft}
                          onChange={(e) => setAddressDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addAddress();
                            }
                          }}
                          placeholder={s.senderPlaceholder}
                          spellCheck={false}
                          className={`min-w-0 flex-1 rounded-xl border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 ${
                            draftInvalid ? "border-danger/50" : "border-border/50"
                          }`}
                        />
                        <button
                          type="button"
                          onClick={addAddress}
                          disabled={!isSenderAddress(addressDraft)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/40 disabled:opacity-40"
                        >
                          <Plus className="size-4" strokeWidth={1.8} />
                          {s.addSender}
                        </button>
                      </div>
                      {draftInvalid && <p className="text-xs text-danger">{s.senderInvalid}</p>}
                    </div>

                    {!selectionOk && <p className="text-xs text-warning">{s.noSenders}</p>}
                  </div>
                )}
              </div>

              {/* Provider + credentials */}
              <div className="space-y-4 rounded-2xl border border-border/50 bg-card p-5">
                <h4 className="text-sm font-semibold text-foreground">{s.credentialsTitle}</h4>

                <div className="flex flex-wrap gap-2">
                  {RELAY_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onProvider(p.id)}
                      aria-pressed={providerId === p.id}
                      className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all ${
                        providerId === p.id
                          ? "border-primary/40 bg-primary/[0.06] text-foreground"
                          : "border-border/50 text-muted-foreground hover:bg-muted/30"
                      }`}
                    >
                      <AppLogo appId={`mailprov:${p.id}`} slug={p.logo} src={p.logoSrc} className="size-4" />
                      {p.label}
                    </button>
                  ))}
                </div>
                {preset.hint && <p className="text-xs text-muted-foreground/80">{preset.hint}</p>}

                <div className="grid gap-3 sm:grid-cols-2">
                  {spec.regional ? (
                    <Field
                      label={interpolate(s.regionFor, { provider: spec.label })}
                      value={region}
                      onChange={setRegion}
                      placeholder="us-east-1"
                    />
                  ) : (
                    <Field label={s.host} value={host} onChange={setHost} placeholder="smtp.example.com" />
                  )}
                  <Field label={s.port} value={port} onChange={setPort} placeholder="587" invalid={!portOk || portBlocked} />
                  <Field label={s.username} value={username} onChange={setUsername} placeholder="smtp-user" />
                  <Field
                    label={s.password}
                    value={password}
                    onChange={setPassword}
                    type="password"
                    placeholder={current?.hasPassword ? s.passwordKeep : ""}
                  />
                </div>
                {portBlocked && <p className="text-xs text-danger">{s.port465Blocked}</p>}

                {/* Always editable, never hidden. Providers whose token is account- or
                    region-specific have none in the registry (blank = we leave SPF
                    alone rather than guess), and the ones that do still need an
                    override path — Mailgun EU is a different include, and hiding the
                    field would silently reset it on the next save. */}
                <div className="space-y-1.5">
                  <Field
                    label={s.spfIncludeLabel}
                    value={spfInclude}
                    onChange={setSpfInclude}
                    placeholder={spec.spfInclude ?? "include:spf.example.net"}
                  />
                  {!spec.spfInclude && <p className="text-xs text-muted-foreground/80">{s.spfIncludeHint}</p>}
                </div>
              </div>

              {/* Provider-side domain identity (DKIM CNAMEs + MAIL FROM) */}
              {spec.providerDkim && relayedDomains.length > 0 && (
                <div className="space-y-3 rounded-2xl border border-border/50 bg-card p-5">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      {interpolate(s.identityTitle, { provider: spec.label })}
                    </h4>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
                      {interpolate(s.identityHint, { provider: spec.label })}
                    </p>
                  </div>
                  <div className="space-y-2">
                    {relayedDomains.map((d) => (
                      <IdentityEditor
                        key={d}
                        domain={d}
                        isPrimary={d === primaryDomain}
                        value={getIdentity(d)}
                        onChange={(next) => setIdentity(d, next)}
                        providerLabel={spec.label}
                        supportsMailFrom={!!spec.mailFrom}
                        s={s}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* SES-specific gotchas (sandbox, IAM SMTP creds) — SES only. */}
              {spec.id === "ses" && (
                <div className="rounded-xl bg-info-bg/60 px-4 py-3 text-xs text-info">
                  <p className="font-medium">{s.guidanceTitle}</p>
                  <ul className="mt-1.5 list-disc space-y-1 ps-4 text-info/90">
                    <li>{s.guidanceVerify}</li>
                    <li>{s.guidanceSandbox}</li>
                    <li>{s.guidanceCreds}</li>
                    <li>{s.guidanceDns}</li>
                    <li>{s.guidanceSystem}</li>
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Aside: the decision, a live summary, and the actions ────────── */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="space-y-3 rounded-2xl border border-border/50 bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-foreground">{s.pathTitle}</h4>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  current?.enabled ? "bg-success-bg text-success" : "bg-muted/50 text-muted-foreground"
                }`}
              >
                <span className={`size-1.5 rounded-full ${current?.enabled ? "bg-success" : "bg-muted-foreground/50"}`} />
                {current?.enabled ? s.statusOn : s.statusOff}
              </span>
            </div>

            <div className="space-y-2">
              <PathOption
                icon={<Send className="size-4" strokeWidth={1.8} />}
                title={s.modeDirectTitle}
                desc={s.modeDirectDesc}
                active={mode === "direct"}
                onClick={() => setMode("direct")}
              />
              <PathOption
                icon={<ShieldCheck className="size-4" strokeWidth={1.8} />}
                title={current?.enabled || mode === "relay" ? spec.label : s.modeRelayTitle}
                desc={s.modeRelayDesc}
                active={mode === "relay"}
                onClick={() => setMode("relay")}
              />
            </div>
          </div>

          {/* Live summary of what Save will apply — form state, not server state. */}
          {mode === "relay" && (
            <div className="space-y-2.5 rounded-2xl border border-border/50 bg-card p-4">
              <h4 className="text-sm font-semibold text-foreground">{s.summaryTitle}</h4>
              <SummaryRow label={s.provider} value={spec.label} />
              <SummaryRow label={s.summaryTarget} value={effectiveHost ? `${effectiveHost}:${port}` : "—"} mono />
              {/* Two rows instead of one interpolated count — no plural forms to
                  translate, and it reads as the two things you actually picked. */}
              {scope === "all" ? (
                <SummaryRow label={s.summarySenders} value={s.scopeAll} />
              ) : (
                <>
                  <SummaryRow label={s.sendersDomains} value={String(selectedDomains.length)} />
                  <SummaryRow label={s.sendersAddresses} value={String(addresses.length)} />
                </>
              )}
              <SummaryRow label={s.spfIncludeLabel} value={effectiveInclude ?? s.spfNone} mono={!!effectiveInclude} />
              {current?.updatedAt && (
                <SummaryRow label={s.summaryUpdated} value={new Date(current.updatedAt).toLocaleString()} />
              )}
            </div>
          )}

          <div className="space-y-2 rounded-2xl border border-border/50 bg-card p-4">
            {mode === "relay" ? (
              <>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !canSave}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {current?.enabled ? s.update : s.save}
                </button>
                {current?.enabled && (
                  <button
                    type="button"
                    onClick={disable}
                    disabled={saving}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger-bg/60 disabled:opacity-50"
                  >
                    <Trash2 className="size-4" strokeWidth={1.8} />
                    {s.disable}
                  </button>
                )}
              </>
            ) : current?.enabled ? (
              <>
                {/* The relay is live; choosing Direct is an action, not a view. */}
                <button
                  type="button"
                  onClick={disable}
                  disabled={saving}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-danger px-4 py-2.5 text-sm font-medium text-danger-foreground transition-colors hover:bg-danger/90 disabled:opacity-50"
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {s.switchToDirect}
                </button>
                <p className="text-xs leading-relaxed text-warning">{s.switchToDirectHint}</p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">{s.directActive}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One outbound-path choice in the aside — a radio card, not a link. */
function PathOption({
  icon,
  title,
  desc,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`w-full rounded-xl border px-3.5 py-3 text-start transition-all ${
        active
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/50 hover:bg-muted/30"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className={active ? "text-primary" : "text-muted-foreground"}>{icon}</span>
        {title}
      </span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{desc}</span>
    </button>
  );
}

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-all text-end text-foreground ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/** Labels the identity editor pulls from the `sending` i18n namespace. */
type IdentityLabels = {
  mailFromDomain: string;
  mailFromHint: string;
  dkimRecords: string;
  dkimRecordsHint: string;
  dkimName: string;
  dkimValue: string;
  identityPrimary: string;
};

/** One relayed domain's provider identity — collapsed by default (optional). */
function IdentityEditor({
  domain,
  isPrimary,
  value,
  onChange,
  providerLabel,
  supportsMailFrom,
  s,
}: {
  domain: string;
  isPrimary: boolean;
  value: Identity;
  onChange: (next: Identity) => void;
  providerLabel: string;
  supportsMailFrom: boolean;
  s: IdentityLabels;
}) {
  const [open, setOpen] = useState(false);
  const filled = value.mailFrom.trim() !== "" || value.dkim.some((r) => r.name.trim() || r.value.trim());
  const setRow = (i: number, patch: Partial<DkimRow>) =>
    onChange({ ...value, dkim: value.dkim.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <div className="rounded-xl border border-border/40 bg-muted/[0.15]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-start"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {open ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          {domain}
          {isPrimary && (
            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {s.identityPrimary}
            </span>
          )}
        </span>
        <span className={`size-1.5 rounded-full ${filled ? "bg-success" : "bg-muted-foreground/30"}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/40 px-4 py-3">
          {/* MAIL FROM is registry data: only SES supports a custom bounce domain
              today, and offering the field elsewhere would publish dead records. */}
          {supportsMailFrom && (
            <>
              <Field
                label={s.mailFromDomain}
                value={value.mailFrom}
                onChange={(v) => onChange({ ...value, mailFrom: v })}
                placeholder={`bounce.${domain}`}
              />
              <p className="text-xs text-muted-foreground/80">{s.mailFromHint}</p>
            </>
          )}
          <div>
            <p className="text-sm font-medium text-foreground">{interpolate(s.dkimRecords, { provider: providerLabel })}</p>
            <p className="mt-0.5 text-xs text-muted-foreground/80">{s.dkimRecordsHint}</p>
            <div className="mt-2 space-y-2">
              {value.dkim.map((row, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-2">
                  <input
                    value={row.name}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                    placeholder={s.dkimName}
                    className="w-full rounded-lg border border-border/50 bg-muted/30 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                  <input
                    value={row.value}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                    placeholder={s.dkimValue}
                    className="w-full rounded-lg border border-border/50 bg-muted/30 px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  invalid?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-xl border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 ${
          invalid ? "border-danger/50" : "border-border/50"
        }`}
      />
    </div>
  );
}
