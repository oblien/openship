"use client";

/**
 * Sending tab — outbound delivery mode for a self-hosted mail server.
 *
 * Receiving (MX / IMAP / DKIM / DMARC / PTR) is unchanged by anything here — it
 * always stays on this server. This tab only controls the OUTBOUND path:
 *   - Direct delivery (default): Postfix delivers to MX itself.
 *   - Relay via Amazon SES (or any SMTP relay): Postfix relays through a trusted
 *     smarthost, and the DNS tab gains the SES send-hop records (SPF include +
 *     DKIM CNAMEs + MAIL FROM). All backed by /mail/admin/:serverId/relay.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Send, ShieldCheck, Trash2 } from "lucide-react";
import { mailAdminApi, getApiErrorMessage } from "@/lib/api";
import type { AdminDomain, ConfigureRelayPayload, OutboundRelayStatus } from "@/lib/api/mail-admin";
import { MAIL_PROVIDERS, mailProvider, matchSmtpProvider, type MailProviderId } from "@/lib/mail-providers";
import { AppLogo } from "@/components/AppLogo";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

// Relay-capable providers only: SES + the send-only SMTP relays + custom.
// Gmail/Fastmail are receiving providers, not smarthosts.
const RELAY_PROVIDERS = MAIL_PROVIDERS.filter((p) => p.id === "ses" || p.sendOnly || p.id === "custom");

type DkimRow = { name: string; value: string };
/** One domain's SES identity: MAIL FROM subdomain + up to 3 DKIM CNAME rows. */
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

export function SendingTab({ serverId, primaryDomain }: { serverId: string; primaryDomain: string }) {
  const { t } = useI18n();
  const s = t.emailsAdmin.sending;
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<OutboundRelayStatus | null>(null);
  const [domainList, setDomainList] = useState<AdminDomain[]>([]);

  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [providerId, setProviderId] = useState<MailProviderId>("ses");
  const [region, setRegion] = useState("us-east-1");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // SES identity per domain (primary + each relayed additional domain).
  const [identities, setIdentities] = useState<Record<string, Identity>>({});
  const getIdentity = (d: string): Identity => identities[d] ?? emptyIdentity();
  const setIdentity = (d: string, next: Identity) => setIdentities((cur) => ({ ...cur, [d]: next }));

  const isSes = providerId === "ses";
  const preset = mailProvider(providerId);

  const seedFromStatus = useCallback((relay: OutboundRelayStatus | null) => {
    if (!relay) return;
    const pid: MailProviderId = relay.provider === "ses" ? "ses" : matchSmtpProvider(relay.host);
    setProviderId(pid);
    setScope(relay.scope === "selected" ? "selected" : "all");
    setSelectedDomains(relay.domains ?? []);
    setRegion(relay.region ?? "us-east-1");
    setHost(relay.host ?? "");
    setPort(String(relay.port ?? 587));
    setUsername(relay.username ?? "");
    // Primary identity lives in the top-level fields; additional domains in `identities`.
    const seeded: Record<string, Identity> = {
      [primaryDomain]: { mailFrom: relay.mailFromDomain ?? "", dkim: padDkim(relay.sesDkim) },
    };
    for (const [d, id] of Object.entries(relay.identities ?? {})) {
      seeded[d] = { mailFrom: id.mailFromDomain ?? "", dkim: padDkim(id.sesDkim) };
    }
    setIdentities(seeded);
  }, [primaryDomain]);

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

  // Prefill host/port/username from the preset when switching provider (unless
  // editing the already-saved provider — keep the stored values then).
  const onProvider = (id: MailProviderId) => {
    setProviderId(id);
    const p = mailProvider(id);
    if (id !== "ses") setHost(p.smtpHost);
    setPort(String(p.smtpPort || 587));
    setUsername(p.user ?? "");
  };

  const toggleDomain = (d: string) =>
    setSelectedDomains((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));

  const portOk = useMemo(() => /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535, [port]);
  const scopeOk = scope === "all" || selectedDomains.length > 0;
  const canSave =
    portOk && scopeOk && username.trim() !== "" && (isSes ? region.trim() !== "" : host.trim() !== "") && (!!current?.hasPassword || password.trim() !== "");

  const relayedDomains = useMemo(
    () => (scope === "all" ? domainList.map((d) => d.domain) : selectedDomains),
    [scope, domainList, selectedDomains],
  );

  const save = async () => {
    setSaving(true);
    try {
      const routing = { scope, domains: scope === "selected" ? selectedDomains : undefined };
      // Primary domain's identity → top-level; every other relayed domain → identities map.
      const primaryId = identities[primaryDomain];
      const identitiesPayload: Record<string, { mailFromDomain?: string; sesDkim?: { name: string; value: string }[] }> = {};
      for (const d of relayedDomains) {
        if (d === primaryDomain) continue;
        const id = identities[d];
        if (!id) continue;
        const dk = dkimToArr(id.dkim);
        if (id.mailFrom.trim() || dk.length) {
          identitiesPayload[d] = { mailFromDomain: id.mailFrom.trim() || undefined, sesDkim: dk };
        }
      }
      const payload: ConfigureRelayPayload = isSes
        ? {
            provider: "ses",
            ...routing,
            region: region.trim(),
            port: Number(port),
            username: username.trim(),
            password: password || undefined,
            mailFromDomain: primaryId?.mailFrom.trim() || undefined,
            sesDkim: primaryId ? dkimToArr(primaryId.dkim) : [],
            identities: Object.keys(identitiesPayload).length ? identitiesPayload : undefined,
          }
        : {
            provider: "custom",
            ...routing,
            host: host.trim(),
            port: Number(port),
            username: username.trim(),
            password: password || undefined,
          };
      const res = await mailAdminApi.relay.save(serverId, payload);
      setCurrent(res.relay);
      setPassword("");
      showToast(isSes ? `${s.saved} ${s.dnsHint}` : s.saved, "success", s.title);
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
      showToast(s.disabled, "success", s.title);
    } catch (err) {
      showToast(getApiErrorMessage(err, s.disableFailed), "error", s.title);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="h-40 animate-pulse rounded-2xl border border-border/50 bg-card" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{s.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{s.subtitle}</p>
      </div>

      {/* Current mode */}
      <div className="flex items-center gap-2 text-sm">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${current?.enabled ? "bg-success-bg text-success" : "bg-muted/50 text-muted-foreground"}`}>
          <span className={`size-1.5 rounded-full ${current?.enabled ? "bg-success" : "bg-muted-foreground/50"}`} />
          {current?.enabled ? s.statusOn : s.statusOff}
        </span>
      </div>

      {/* Mode explainer cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border/50 bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Send className="size-4 text-muted-foreground" strokeWidth={1.8} />
            {s.modeDirectTitle}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.modeDirectDesc}</p>
        </div>
        <div className="rounded-2xl border border-primary/30 bg-primary/[0.04] p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ShieldCheck className="size-4 text-primary" strokeWidth={1.8} />
            {s.modeRelayTitle}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.modeRelayDesc}</p>
        </div>
      </div>

      {/* Relay config */}
      <div className="space-y-4 rounded-2xl border border-border/50 bg-card p-5">
        {/* Routing scope — which domains relay */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">{s.scopeLabel}</label>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-border/50 bg-muted/25 p-1">
            {(["all", "selected"] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setScope(val)}
                aria-pressed={scope === val}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                  scope === val ? "bg-card text-foreground shadow-sm ring-1 ring-inset ring-border/70" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {val === "all" ? s.scopeAll : s.scopeSelected}
              </button>
            ))}
          </div>
          {/* "selected" leaves non-chosen senders delivering direct (off-SES) —
              flag it so an "everything via SES" expectation isn't silently broken. */}
          <p className={`text-xs ${scope === "selected" ? "text-warning" : "text-muted-foreground/80"}`}>
            {scope === "all" ? s.scopeAllHint : s.scopeSelectedHint}
          </p>
          {scope === "selected" && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {domainList.length === 0 && <span className="text-xs text-muted-foreground/70">{s.noDomains}</span>}
              {domainList.map((d) => {
                const on = selectedDomains.includes(d.domain);
                return (
                  <button
                    key={d.domain}
                    type="button"
                    onClick={() => toggleDomain(d.domain)}
                    aria-pressed={on}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] transition-all ${
                      on ? "border-primary/40 bg-primary/[0.06] text-foreground" : "border-border/50 text-muted-foreground hover:bg-muted/30"
                    }`}
                  >
                    <span className={`size-1.5 rounded-full ${on ? "bg-primary" : "bg-muted-foreground/30"}`} />
                    {d.domain}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Provider */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">{s.provider}</label>
          <div className="flex flex-wrap gap-2">
            {RELAY_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onProvider(p.id)}
                aria-pressed={providerId === p.id}
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all ${
                  providerId === p.id ? "border-primary/40 bg-primary/[0.06] text-foreground" : "border-border/50 text-muted-foreground hover:bg-muted/30"
                }`}
              >
                <AppLogo appId={`mailprov:${p.id}`} slug={p.logo} src={p.logoSrc} className="size-4" />
                {p.label}
              </button>
            ))}
          </div>
          {preset.hint && <p className="text-xs text-muted-foreground/80">{preset.hint}</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {isSes ? (
            <Field label={s.region} value={region} onChange={setRegion} placeholder="us-east-1" />
          ) : (
            <Field label={s.host} value={host} onChange={setHost} placeholder="smtp.example.com" />
          )}
          <Field label={s.port} value={port} onChange={setPort} placeholder="587" invalid={!portOk} />
          <Field label={s.username} value={username} onChange={setUsername} placeholder="AKIA…" />
          <Field
            label={s.password}
            value={password}
            onChange={setPassword}
            type="password"
            placeholder={current?.hasPassword ? s.passwordKeep : ""}
          />
        </div>

        {/* SES identity per relayed domain — SES verifies each domain separately. */}
        {isSes && relayedDomains.length > 0 && (
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium text-foreground">{s.identitiesTitle}</p>
              <p className="mt-0.5 text-xs text-muted-foreground/80">{s.identitiesHint}</p>
            </div>
            <div className="space-y-2">
              {relayedDomains.map((d) => (
                <IdentityEditor
                  key={d}
                  domain={d}
                  isPrimary={d === primaryDomain}
                  value={getIdentity(d)}
                  onChange={(next) => setIdentity(d, next)}
                  s={s}
                />
              ))}
            </div>
          </div>
        )}

        {/* Guidance */}
        {isSes && (
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

        <div className="flex items-center justify-between gap-2 pt-1">
          {current?.enabled ? (
            <button
              type="button"
              onClick={disable}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-danger hover:bg-danger-bg/60 disabled:opacity-50"
            >
              <Trash2 className="size-4" strokeWidth={1.8} />
              {s.disable}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving || !canSave}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {current?.enabled ? s.update : s.save}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Labels the identity editor pulls from the `sending` i18n namespace. */
type IdentityLabels = {
  mailFromDomain: string;
  mailFromHint: string;
  dkimTitle: string;
  dkimHint: string;
  dkimName: string;
  dkimValue: string;
  identityPrimary: string;
};

/** One relayed domain's SES identity — collapsed by default (optional to fill). */
function IdentityEditor({
  domain,
  isPrimary,
  value,
  onChange,
  s,
}: {
  domain: string;
  isPrimary: boolean;
  value: Identity;
  onChange: (next: Identity) => void;
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
          {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
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
          <Field label={s.mailFromDomain} value={value.mailFrom} onChange={(v) => onChange({ ...value, mailFrom: v })} placeholder={`bounce.${domain}`} />
          <p className="text-xs text-muted-foreground/80">{s.mailFromHint}</p>
          <div>
            <p className="text-sm font-medium text-foreground">{s.dkimTitle}</p>
            <p className="mt-0.5 text-xs text-muted-foreground/80">{s.dkimHint}</p>
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
