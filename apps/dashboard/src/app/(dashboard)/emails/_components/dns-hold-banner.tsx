"use client";

/**
 * Full-width DNS hold banner. Renders ABOVE the two-column grid when the
 * install is paused after step 11 (DKIM) waiting for the user to publish
 * DNS records. Dominant by design - mail delivery breaks without these.
 *
 * Two paths forward:
 *   - "I've set the records - continue" - manual publication, then resume
 *   - "Auto-configure DNS" - opens the shared `useModal` picker. Today the
 *     selected provider surfaces a "coming soon" panel; the per-provider
 *     API integration (Cloudflare token form, Route 53 SDK, etc.) is the
 *     next chunk of work and lives entirely behind this modal.
 */

import { useState } from "react";
import { Globe, Loader2, Sparkles, ChevronRight, ArrowLeft } from "lucide-react";
import type { DnsRecords } from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import { DnsRecordsView } from "@/components/shared/DnsRecordsView";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface DnsHoldBannerProps {
  records: DnsRecords;
  /** Mail domain (e.g. "oblien.com") - used to render Name as `@` / subdomain prefix. */
  domain: string;
  /**
   * Install-flow uses this to render "The install resumes from step N (SSL
   * certificate)". When omitted (e.g. the additional-domain banner), the
   * resume copy is dropped - caller supplies its own `description` instead.
   */
  resumeStep?: number;
  /** Override the default install-step heading. */
  title?: string;
  /** Override the default install-step description block. */
  description?: React.ReactNode;
  acknowledging: boolean;
  onAcknowledge: () => void;
}

interface Provider {
  id: string;
  label: string;
  /** simpleicons.org slug - fetched as `https://cdn.simpleicons.org/{slug}`. */
  slug: string;
  /** Brand colour as the SVG tint (simpleicons official-color URL suffix). */
  color: string;
}

const PROVIDERS: Provider[] = [
  { id: "cloudflare", label: "Cloudflare", slug: "cloudflare", color: "F38020" },
  { id: "hostinger", label: "Hostinger", slug: "hostinger", color: "673DE6" },
  { id: "route53", label: "AWS Route 53", slug: "amazonwebservices", color: "FF9900" },
  { id: "digitalocean", label: "DigitalOcean", slug: "digitalocean", color: "0080FF" },
  { id: "namecheap", label: "Namecheap", slug: "namecheap", color: "DE3910" },
  { id: "google", label: "Google Cloud DNS", slug: "googlecloud", color: "4285F4" },
];

// ─── Banner ──────────────────────────────────────────────────────────────────

export function DnsHoldBanner({
  records,
  domain,
  resumeStep,
  title,
  description,
  acknowledging,
  onAcknowledge,
}: DnsHoldBannerProps) {
  const { t } = useI18n();
  const { showModal, hideModal } = useModal();

  const heading = title ?? t.emails.dns.heading;
  const body =
    description ??
    (resumeStep !== undefined ? (
      <>
        {t.emails.dns.bodyBefore}
        <strong>{t.emails.dns.action}</strong>
        {interpolate(t.emails.dns.bodyAfterResume, { resumeStep: String(resumeStep) })}
      </>
    ) : (
      <>
        {t.emails.dns.bodyBefore}
        <strong>{t.emails.dns.action}</strong>
        {t.emails.dns.bodyAfter}
      </>
    ));

  const openAutoConfigure = () => {
    // Capture the modal id at the call-site so the close handlers inside
    // the modal's customContent can dismiss it. JS closures hold a
    // reference to `modalId`, which gets its real value synchronously
    // before any onClose fires.
    let modalId: string;
    modalId = showModal({
      maxWidth: "32rem",
      showCloseButton: true,
      closable: true,
      customContent: (
        <AutoConfigureModal onClose={() => hideModal(modalId)} />
      ),
    });
  };

  return (
    <div className="bg-warning-bg border border-warning-border rounded-2xl p-6 mb-6">
      <div className="flex items-start gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-warning-bg flex items-center justify-center shrink-0">
          <Globe className="size-5 text-warning" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-warning">
            {heading}
          </h2>
          <p className="text-sm text-warning/80 mt-1 leading-snug">
            {body}
          </p>
        </div>
      </div>

      <div className="mb-5">
        <DnsRecordsView records={records} domain={domain} />
      </div>

      <div className="flex items-center justify-between gap-3 pt-4 border-t border-warning-border">
        <button
          onClick={openAutoConfigure}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-warning-border text-warning hover:bg-warning-bg transition-colors"
        >
          <Sparkles className="size-4" />
          {t.emails.dns.autoConfigure}
        </button>
        <button
          onClick={onAcknowledge}
          disabled={acknowledging}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-warning-solid text-white hover:bg-warning-solid/90 transition-colors disabled:opacity-50"
        >
          {acknowledging ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Globe className="size-4" />
          )}
          {t.emails.dns.action}
        </button>
      </div>
    </div>
  );
}

// ─── Auto-configure modal content ────────────────────────────────────────────

/**
 * Rendered as `customContent` inside the shared Modal frame. Owns its own
 * "list view ↔ selected-provider view" state so the modal frame doesn't
 * need to know about provider selection.
 */
function AutoConfigureModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Provider | null>(null);

  if (selected) {
    return (
      <ProviderComingSoon
        provider={selected}
        onBack={() => setSelected(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="p-6">
      <div className="mb-5">
        <div className="flex items-center gap-2.5 mb-1">
          <Sparkles className="size-4 text-warning" />
          <h3 className="text-base font-semibold text-foreground">
            {t.emails.dns.autoConfigure}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground/80 leading-relaxed">
          {t.emails.dns.autoConfigureDesc}
        </p>
      </div>

      <div className="space-y-1.5">
        {PROVIDERS.map((p) => (
          <ProviderRow key={p.id} provider={p} onSelect={() => setSelected(p)} />
        ))}
      </div>

      <button
        onClick={onClose}
        className="w-full mt-3 px-4 py-3 rounded-xl text-start hover:bg-muted/40 transition-colors border border-dashed border-border/60"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center shrink-0">
            <Globe className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {t.emails.dns.otherManual}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {t.emails.dns.otherManualDesc}
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

function ProviderRow({
  provider,
  onSelect,
}: {
  provider: Provider;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const description = (t.emails.dns.providers as Record<string, string>)[provider.id] ?? "";
  return (
    <button
      onClick={onSelect}
      className="w-full px-4 py-3 rounded-xl text-start hover:bg-muted/40 transition-colors group"
    >
      <div className="flex items-center gap-3">
        <ProviderLogo provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {provider.label}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {description}
          </div>
        </div>
        <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-foreground transition-colors shrink-0 rtl:rotate-180" />
      </div>
    </button>
  );
}

/**
 * Brand logo via simpleicons.org CDN. The `https://cdn.simpleicons.org/{slug}/{hex}`
 * endpoint returns the SVG tinted in the brand's official colour. If the
 * fetch ever 404s (slug renamed upstream), the <img> falls back to alt text
 * inside the rounded tile so the row still renders cleanly.
 */
function ProviderLogo({ provider }: { provider: Provider }) {
  return (
    <div className="w-8 h-8 rounded-lg bg-muted/40 flex items-center justify-center shrink-0 overflow-hidden">
      <img
        src={`https://cdn.simpleicons.org/${provider.slug}/${provider.color}`}
        alt=""
        aria-hidden
        className="w-5 h-5"
        loading="lazy"
      />
    </div>
  );
}

function ProviderComingSoon({
  provider,
  onBack,
  onClose,
}: {
  provider: Provider;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="p-6">
      <div className="mb-5">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="size-3.5 rtl:rotate-180" />
          {t.emails.dns.pickAnother}
        </button>
        <div className="flex items-center gap-3">
          <ProviderLogo provider={provider} />
          <h3 className="text-base font-semibold text-foreground">
            {provider.label}
          </h3>
        </div>
      </div>

      <div className="rounded-xl border border-warning-border bg-warning-bg p-4 mb-5">
        <p className="text-sm font-medium text-warning">
          {interpolate(t.emails.dns.comingSoon, { provider: provider.label })}
        </p>
        <p className="text-xs text-warning/80 mt-1.5 leading-relaxed">
          {t.emails.dns.comingSoonBefore}
          <strong>{t.emails.dns.action}</strong>
          {t.emails.dns.comingSoonAfter}
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors"
        >
          {t.emails.dns.gotIt}
        </button>
      </div>
    </div>
  );
}
