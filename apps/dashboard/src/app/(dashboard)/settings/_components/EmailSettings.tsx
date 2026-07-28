"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Mail, Send, Check } from "lucide-react";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n } from "@/components/i18n-provider";
import { MAIL_PROVIDERS, mailProvider, matchSmtpProvider, type MailProviderId } from "@/lib/mail-providers";
import { PillSwitcher } from "@/components/ui/PillSwitcher";

/**
 * Instance SMTP transport — the operator's own mail server, used for ALL
 * system mail (password resets, verification, invites, notifications). Writes
 * to instance_settings via /system/settings/email; the password is encrypted
 * server-side and never returned, so the field stays blank on load and a blank
 * save keeps the stored one. Self-hosted only.
 */

const INPUT =
  "w-full px-3.5 py-2.5 rounded-xl border border-border/50 bg-muted/30 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none transition-all focus:ring-2 focus:ring-primary/20";
const LABEL = "block text-sm font-medium text-muted-foreground mb-1.5";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Pull the address out of a "Name <email>" From value, or the bare value. */
const extractEmail = (v: string): string => {
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1] : v).trim();
};

export function EmailSettings() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const e = t.settings.email;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);

  const [provider, setProvider] = useState<MailProviderId>("custom");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");

  // Pick a provider preset → prefill host + port (+ a fixed username where the
  // relay requires one). Fields stay editable; "Custom" leaves them as-is.
  // Presets are shared with the mail app's wizard.
  const applyProvider = (id: MailProviderId) => {
    setProvider(id);
    if (id === "custom") return;
    const p = mailProvider(id);
    setHost(p.smtpHost);
    setPort(String(p.smtpPort));
    // Reset the username to the preset's fixed one (SendGrid "apikey", Resend
    // "resend", …) or clear it — otherwise a fixed username leaks across a
    // switch (e.g. "apikey" left behind when you pick Gmail).
    setUser(p.user ?? "");
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await systemApi.getEmailSettings();
      setConfigured(!!res.configured);
      setHasPassword(!!res.hasPassword);
      setHost(res.host ?? "");
      setPort(res.port != null ? String(res.port) : "587");
      setUser(res.user ?? "");
      setFrom(res.from ?? "");
      setPassword("");
      setProvider(matchSmtpProvider(res.host));
    } catch {
      /* silent — leave the form empty */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!host.trim()) {
      showToast(e.hostRequired, "error", e.toastTitle);
      return;
    }
    // Reject a mistyped port client-side — otherwise Number("58a") → NaN →
    // JSON null → the API would silently fall back to 587.
    let portNum: number | undefined;
    const pt = port.trim();
    if (pt) {
      if (!/^\d{1,5}$/.test(pt) || Number(pt) < 1 || Number(pt) > 65535) {
        showToast(e.portInvalid, "error", e.toastTitle);
        return;
      }
      portNum = Number(pt);
    }
    // SMTP auth uses username + password. The username is an EMAIL for some
    // providers (Gmail, Mailgun) but a token/literal for others (SendGrid
    // "apikey", SES IAM user, Postmark token). The From address recipients see
    // can only default to the username when the username IS an email — otherwise
    // a real From is required, or the send fails with an invalid sender.
    const fromRaw = from.trim();
    const fromEmail = extractEmail(fromRaw);
    const userIsEmail = EMAIL_RE.test(user.trim());
    if (!userIsEmail && !EMAIL_RE.test(fromEmail)) {
      showToast(e.fromRequired, "error", e.toastTitle);
      return;
    }
    if (fromRaw && !EMAIL_RE.test(fromEmail)) {
      showToast(e.fromInvalid, "error", e.toastTitle);
      return;
    }
    setSaving(true);
    try {
      await systemApi.updateEmailSettings({
        host: host.trim(),
        port: portNum,
        user: user.trim(),
        // Blank keeps the stored password (we never received it to resend).
        password: password || undefined,
        from: from.trim() || undefined,
      });
      showToast(e.saved, "success", e.toastTitle);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, e.saveFailed), "error", e.toastTitle);
    } finally {
      setSaving(false);
    }
  }

  async function disable() {
    setSaving(true);
    try {
      await systemApi.updateEmailSettings({ host: "" });
      showToast(e.disabled, "success", e.toastTitle);
      setPassword("");
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, e.saveFailed), "error", e.toastTitle);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (!configured) {
      showToast(e.saveFirst, "error", e.toastTitle);
      return;
    }
    if (!testTo.trim()) return;
    setTesting(true);
    try {
      const res = await systemApi.sendTestEmail(testTo.trim());
      if (res.ok) {
        showToast(e.testSent, "success", e.toastTitle);
      } else {
        showToast(res.error || e.testFailed, "error", e.toastTitle);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, e.testFailed), "error", e.toastTitle);
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection icon={Mail} title={e.title} description={e.description}>
      {loading ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {e.loading}
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">{e.intro}</p>

          {configured ? (
            <span className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-medium text-success">
              <Check className="size-3.5" /> {e.configuredBadge}
            </span>
          ) : (
            <p className="mb-4 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">{e.notConfigured}</p>
          )}

          <div className="mb-4">
            <label className={LABEL}>{e.providerLabel}</label>
            <PillSwitcher
              options={MAIL_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.label,
                logo: p.logo,
                logoSrc: p.logoSrc,
              }))}
              value={provider}
              onChange={applyProvider}
            />
            {mailProvider(provider).hint && (
              <p className="mt-2 text-xs text-muted-foreground/80">{mailProvider(provider).hint}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_120px]">
            <div>
              <label className={LABEL}>{e.hostLabel}</label>
              <input
                className={INPUT}
                value={host}
                onChange={(ev) => {
                  setHost(ev.target.value);
                  setProvider("custom");
                }}
                placeholder={e.hostPlaceholder}
              />
            </div>
            <div>
              <label className={LABEL}>{e.portLabel}</label>
              <input
                className={INPUT}
                value={port}
                onChange={(ev) => setPort(ev.target.value)}
                inputMode="numeric"
                placeholder="587"
              />
            </div>
          </div>

          <div className="mt-4">
            <label className={LABEL}>{e.userLabel}</label>
            <input
              className={INPUT}
              value={user}
              onChange={(ev) => setUser(ev.target.value)}
              placeholder={e.userPlaceholder}
              autoComplete="off"
            />
          </div>

          <div className="mt-4">
            <label className={LABEL}>{e.passwordLabel}</label>
            <input
              type="password"
              className={INPUT}
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              placeholder={hasPassword ? e.passwordKeepPlaceholder : e.passwordPlaceholder}
              autoComplete="new-password"
            />
          </div>

          <div className="mt-4">
            <label className={LABEL}>{e.fromLabel}</label>
            <input
              className={INPUT}
              value={from}
              onChange={(ev) => setFrom(ev.target.value)}
              placeholder={e.fromPlaceholder}
            />
            <p className="mt-1 text-xs text-muted-foreground/70">
              {EMAIL_RE.test(user.trim()) ? e.fromHint : e.fromHintRequired}
            </p>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? e.saving : e.save}
            </button>
            {configured && (
              <button
                type="button"
                onClick={disable}
                disabled={saving}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-danger disabled:opacity-50"
              >
                {e.disable}
              </button>
            )}
          </div>

          {/* Send test — verifies the saved SMTP against a live send. */}
          <div className="mt-6 rounded-xl border border-border/50 bg-muted/20 p-4">
            <p className="mb-1 text-sm font-medium text-foreground">{e.testTitle}</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                className={INPUT}
                value={testTo}
                onChange={(ev) => setTestTo(ev.target.value)}
                placeholder={e.testPlaceholder}
                type="email"
              />
              <button
                type="button"
                onClick={sendTest}
                disabled={testing || !configured || !testTo.trim()}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
              >
                {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {testing ? e.sending : e.sendTest}
              </button>
            </div>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
