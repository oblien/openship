"use client";

/**
 * PTR (reverse DNS) hold gate. Renders AFTER `dnsAcknowledged` flips true
 * but before step 12 (SSL). Same shape as the DNS banner but:
 *
 *   - The records are configured at the VPS provider's panel
 *     (Hostinger / DigitalOcean / AWS / etc.), NOT at the DNS provider.
 *     That's the #1 confusion source - most users assume rDNS lives with
 *     the rest of their DNS. This banner exists to call out the
 *     difference explicitly.
 *
 *   - There's nothing to copy-paste into a "Name → Value" form; PTRs
 *     are usually a single text box per IP on the VPS provider's panel.
 *     We surface each (IP, hostname) pair clearly + a manual-verify hint.
 *
 *   - No "auto-configure" button. The few providers that offer rDNS API
 *     access (AWS Route 53 for EIPs, etc.) need elevated credentials we
 *     don't want to ask for; manual is the right default.
 */

import { useState } from "react";
import { Loader2, Network, Copy, Check } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface PtrHoldBannerProps {
  ipv4: string;
  ipv6: string | null;
  target: string;
  resumeStep: number;
  acknowledging: boolean;
  onAcknowledge: () => void;
}

export function PtrHoldBanner({
  ipv4,
  ipv6,
  target,
  resumeStep,
  acknowledging,
  onAcknowledge,
}: PtrHoldBannerProps) {
  const { t } = useI18n();
  return (
    <div className="bg-info-bg border border-info-border rounded-2xl p-6 mb-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-info-bg flex items-center justify-center shrink-0">
          <Network className="size-5 text-info" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-info">
            {t.emails.ptr.heading}
          </h2>
          <p className="text-sm text-info mt-1 leading-snug">
            {t.emails.ptr.bodyBefore}
            <strong>{t.emails.ptr.bodyStrongPanel}</strong>
            {t.emails.ptr.bodyMid}
            <strong>{t.emails.ptr.bodyStrongNot}</strong>
            {interpolate(t.emails.ptr.bodyAfter, { resumeStep: String(resumeStep) })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-5">
        <PtrCard label="IPv4 PTR" ip={ipv4} target={target} required />
        {ipv6 && <PtrCard label="IPv6 PTR" ip={ipv6} target={target} />}
      </div>

      <div className="rounded-xl bg-info-bg border border-info-border p-3 mb-5">
        <p className="text-xs text-info leading-relaxed">
          <strong>{t.emails.ptr.howTo}</strong>{t.emails.ptr.howToBody}
          <code className="font-mono text-foreground">{target}</code>
          {t.emails.ptr.howToAfter}
        </p>
        <p className="text-xs text-info leading-relaxed mt-2">
          <strong>{t.emails.ptr.verifyWith}</strong>{" "}
          <code className="font-mono text-foreground">dig +short -x {ipv4}</code>
          {t.emails.ptr.shouldReturn}
          <code className="font-mono text-foreground">{target}.</code>
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-4 border-t border-info-border">
        <button
          onClick={onAcknowledge}
          disabled={acknowledging}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-info-solid text-white hover:bg-info-solid/90 transition-colors disabled:opacity-50"
        >
          {acknowledging ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Network className="size-4" />
          )}
          {t.emails.ptr.action}
        </button>
      </div>
    </div>
  );
}

function PtrCard({
  label,
  ip,
  target,
  required,
}: {
  label: string;
  ip: string;
  target: string;
  required?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<"ip" | "target" | null>(null);
  const copy = async (which: "ip" | "target", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // Non-HTTPS context - silently no-op.
    }
  };
  return (
    <div className="bg-card rounded-xl border border-border/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          {label}
        </span>
        {!required && (
          <span className="text-[11px] text-muted-foreground ms-auto">
            {t.emails.ptr.recommended}
          </span>
        )}
      </div>
      <div className="space-y-2 font-mono text-[12px]">
        <PtrField
          fieldLabel={t.emails.ptr.ipLabel}
          value={ip}
          copied={copied === "ip"}
          onCopy={() => copy("ip", ip)}
        />
        <PtrField
          fieldLabel={t.emails.ptr.setTo}
          value={target}
          copied={copied === "target"}
          onCopy={() => copy("target", target)}
        />
      </div>
    </div>
  );
}

function PtrField({
  fieldLabel,
  value,
  copied,
  onCopy,
}: {
  fieldLabel: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-muted-foreground font-sans w-12 shrink-0 mt-0.5">
        {fieldLabel}
      </span>
      <div className="flex-1 min-w-0 bg-muted/40 rounded-md px-2 py-1.5 text-foreground/90 break-all">
        {value}
      </div>
      <button
        onClick={onCopy}
        className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
        title={t.emails.ptr.copy}
      >
        {copied ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}
