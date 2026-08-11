"use client";

import { useState } from "react";
import {
  Mail,
  Play,
  Server,
  Shield,
  Globe,
  Key,
  AlertTriangle,
  Eye,
  EyeOff,
  Sparkles,
} from "lucide-react";
import ServerSelector, { type ServerOption } from "@/components/shared/ServerSelector";
import { AdoptMailModal } from "./adopt-mail-modal";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * Browser-side strong-password generation. 18 random bytes →
 * base64url-encoded (24-char). Same scheme used in the change-password
 * modal so behavior is consistent across "set" and "rotate" flows.
 */
function generatePassword(): string {
  const buf = new Uint8Array(18);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Optional outbound-relay config collected at install time (SES, all domains).
 *  Per-domain routing + identities are configured later in the Sending tab. */
export interface SetupRelay {
  enabled: boolean;
  region: string;
  username: string;
  password: string;
}

interface MailSetupFormProps {
  domain: string;
  adminPassword: string;
  running: boolean;
  selectedServerId: string | null;
  relay: SetupRelay;
  onRelayChange: (r: SetupRelay) => void;
  onDomainChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onServerSelect: (s: ServerOption | null) => void;
  onStart: () => void;
  /** Called after an existing mail server is re-adopted from a scan. */
  onAdopted: (serverId: string) => void;
}

export function MailSetupForm({
  domain,
  adminPassword,
  running,
  selectedServerId,
  relay,
  onRelayChange,
  onDomainChange,
  onPasswordChange,
  onServerSelect,
  onStart,
  onAdopted,
}: MailSetupFormProps) {
  const { t } = useI18n();
  const [adoptOpen, setAdoptOpen] = useState(false);
  const rl = t.emails.setup.relay;
  // Relay is optional; when toggled on, its fields become required to start.
  const relayReady = !relay.enabled || (!!relay.region.trim() && !!relay.username.trim() && !!relay.password.trim());
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
      {/* Setup form */}
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
            <Mail className="size-5 text-violet-500" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-foreground">{t.emails.setup.title}</h2>
            <p className="text-sm text-muted-foreground">
              {t.emails.setup.subtitle}
            </p>
          </div>
        </div>

        {/* Always show the server picker. Even when the page auto-selected the
            sole server, the operator must be able to confirm WHICH server mail
            installs on, switch to a different one, or add a new server (the
            selector's built-in "Add server" → /servers/new). Auto-select is a
            convenient default, not a reason to hide the choice. */}
        <ServerSelector value={selectedServerId} onSelect={onServerSelect} />

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t.emails.setup.domainLabel}
            </label>
            <input
              type="text"
              value={domain}
              onChange={(e) => onDomainChange(e.target.value)}
              placeholder={t.emails.setup.domainPlaceholder}
              className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              {t.emails.setup.willBeAtBefore}
              <strong>mail.{domain || "example.com"}</strong>
            </p>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="block text-sm font-medium text-foreground">
                {t.emails.setup.adminPasswordLabel}
              </label>
              <span className="text-xs text-muted-foreground/70">
                postmaster@{domain || "your-domain.com"}
              </span>
            </div>
            <PasswordField
              value={adminPassword}
              onChange={onPasswordChange}
              placeholder={t.emails.setup.passwordPlaceholder}
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              {t.emails.setup.passwordHint}
            </p>
          </div>

          {/* Optional: relay outbound through Amazon SES from the start. */}
          <div className="rounded-xl border border-border/50 bg-muted/[0.15] p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={relay.enabled}
                onChange={(e) => onRelayChange({ ...relay, enabled: e.target.checked })}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{rl.toggle}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{rl.hint}</span>
              </span>
            </label>
            {relay.enabled && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <RelayField label={rl.region} value={relay.region} onChange={(v) => onRelayChange({ ...relay, region: v })} placeholder="us-east-1" />
                <RelayField label={rl.username} value={relay.username} onChange={(v) => onRelayChange({ ...relay, username: v })} placeholder="AKIA…" />
                <div className="sm:col-span-2">
                  <RelayField label={rl.password} value={relay.password} onChange={(v) => onRelayChange({ ...relay, password: v })} placeholder="" type="password" />
                </div>
                <p className="sm:col-span-2 text-xs text-muted-foreground/80">{rl.perDomainNote}</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            onClick={onStart}
            disabled={!domain || !adminPassword || !selectedServerId || !relayReady || running}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="size-4" />
            {t.emails.setup.startSetup}
          </button>
          {/* Disaster recovery: re-adopt a mail server already installed on a
              server (e.g. after losing the orchestrator PC) without reinstalling. */}
          <button
            type="button"
            onClick={() => setAdoptOpen(true)}
            disabled={running}
            className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            {t.emails.setup.adoptCta}
          </button>
        </div>
      </div>

      <AdoptMailModal
        isOpen={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        onAdopted={onAdopted}
      />

      {/* Info sidebar */}
      <div className="space-y-4">
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <p className="text-xs text-muted-foreground/60 uppercase tracking-wider font-semibold mb-4">
            {t.emails.setup.whatInstalled}
          </p>
          <div className="space-y-3">
            {[
              { icon: Server, label: t.emails.setup.features.stackLabel, desc: t.emails.setup.features.stackDesc },
              { icon: Shield, label: t.emails.setup.features.sslLabel, desc: t.emails.setup.features.sslDesc },
              { icon: Globe, label: t.emails.setup.features.dnsLabel, desc: t.emails.setup.features.dnsDesc },
              { icon: Key, label: t.emails.setup.features.adminLabel, desc: t.emails.setup.features.adminDesc },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <item.icon className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-warning-bg border border-warning-border rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="size-4 text-warning mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">{t.emails.setup.prerequisites}</p>
              <ul className="text-xs text-muted-foreground mt-1.5 space-y-1 list-disc list-inside">
                <li>{t.emails.setup.prereq1}</li>
                <li>{t.emails.setup.prereq2}</li>
                <li>{t.emails.setup.prereq3}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Simple labeled field (relay setup) ─────────────────────────────────────

function RelayField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
      />
    </div>
  );
}

// ─── Password field with reveal + generate ───────────────────────────────────

/**
 * Password input bundled with two affordances the user expects from a
 * "create credentials" form: a reveal toggle (so you can verify what you
 * typed) and a Generate button (so you can opt out of choosing one). The
 * generated value is auto-revealed so the user can read + copy it from
 * the field before submitting.
 */
function PasswordField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);

  const generate = () => {
    onChange(generatePassword());
    setRevealed(true);
  };

  return (
    <div className="relative flex items-stretch gap-2">
      <div className="relative flex-1">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2.5 pe-10 rounded-xl border border-border bg-background text-sm font-mono placeholder:font-sans placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="absolute end-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground/70 hover:text-foreground transition-colors"
          title={revealed ? t.emails.setup.hide : t.emails.setup.reveal}
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <button
        type="button"
        onClick={generate}
        className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-border/60 bg-background text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
        title={t.emails.setup.generateTitle}
      >
        <Sparkles className="size-3.5" />
        {t.emails.setup.generate}
      </button>
    </div>
  );
}
