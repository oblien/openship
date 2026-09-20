"use client";

/**
 * Send Test Mail modal.
 *
 * Loads the list of provisioned domains for the given mail server, lets the
 * operator pick which domain to send AS, and POSTs to
 * `mail/admin/:serverId/test-email`. The backend ensures (creates if
 * missing) an `openship@<fromDomain>` mailbox and authenticates as that
 * identity — so SMTP AUTH user == MAIL FROM and Postfix's
 * `reject_sender_login_mismatch` policy is satisfied. Subject and body
 * are hardcoded server-side; this form only collects recipient + sender
 * domain.
 *
 * Rendered through the dashboard's shared modal host (useModal → ui/Modal) so
 * it has the same shell, scrim and stacking as every other modal; the form body
 * is the same FormModalContent scaffold the admin tabs use.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink } from "lucide-react";
import {
  getApiErrorMessage,
  mailAdminApi,
  type AdminDomain,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Field, FormModalContent, inputClassName } from "./_shared/form-modal-content";
import { useHostedModal } from "./_shared/hosted-modal";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The mail server we're testing against. */
  serverId: string;
}

// Same regex used by welcome-modal.tsx for consistency with the rest of the
// mail-admin surface.
const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/**
 * Map the recipient's domain to a webmail deep link so the success
 * state can offer a one-click "open inbox" jump. Unknown providers
 * return null — UI falls back to just the Close button.
 *
 * Per-provider URLs are the canonical inbox entry; on mobile they
 * deep-link into the installed app (Gmail/Outlook honor their own
 * intent filters when invoked via these https origins).
 */
type InboxLabelKey =
  | "openGmail"
  | "openOutlook"
  | "openYahoo"
  | "openIcloud"
  | "openProton"
  | "openAol";

function recipientInboxLink(
  email: string,
): { labelKey: InboxLabelKey; href: string } | null {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;

  if (domain === "gmail.com" || domain === "googlemail.com") {
    return { labelKey: "openGmail", href: "https://mail.google.com/mail/u/0/#inbox" };
  }
  if (
    domain === "outlook.com" ||
    domain === "hotmail.com" ||
    domain === "live.com" ||
    domain === "msn.com"
  ) {
    return { labelKey: "openOutlook", href: "https://outlook.live.com/mail/0/inbox" };
  }
  if (domain.startsWith("yahoo.")) {
    return { labelKey: "openYahoo", href: "https://mail.yahoo.com/" };
  }
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com") {
    return { labelKey: "openIcloud", href: "https://www.icloud.com/mail" };
  }
  if (domain === "proton.me" || domain === "protonmail.com" || domain === "pm.me") {
    return { labelKey: "openProton", href: "https://mail.proton.me/u/0/inbox" };
  }
  if (domain === "aol.com") {
    return { labelKey: "openAol", href: "https://mail.aol.com/" };
  }
  return null;
}

interface SendResult {
  to: string;
  from: string;
  messageId: string;
  smtpResponse: string;
}

export function SendTestMailModal({ open, onClose, serverId }: Props) {
  useHostedModal({
    open,
    onClose,
    maxWidth: "520px",
    content: () => <SendTestMailContent serverId={serverId} onClose={onClose} />,
  });
  return null;
}

function SendTestMailContent({
  serverId,
  onClose,
}: {
  serverId: string;
  onClose: () => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [senderDomain, setSenderDomain] = useState("");
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const { showToast } = useToast();
  const { t } = useI18n();
  const s = t.emailsAdmin.sendTest;

  // Active domains only — the test would fail at SMTP auth otherwise.
  useEffect(() => {
    let cancelled = false;
    mailAdminApi.domains
      .list(serverId)
      .then((res) => {
        if (cancelled) return;
        const active = res.domains.filter((d) => d.active);
        setDomains(active);
        // Default to the first active domain (which, since vmail.domain is
        // ORDER BY'd by domain server-side, lands on the alphabetically-first
        // provisioned domain — good enough as a default given Props only
        // carries serverId).
        if (active.length > 0) setSenderDomain(active[0].domain);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(getApiErrorMessage(err, s.loadDomainsFailed));
      })
      .finally(() => {
        if (!cancelled) setLoadingDomains(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, s.loadDomainsFailed]);

  if (result) return <SentStage result={result} onClose={onClose} />;

  const trimmedRecipient = recipient.trim().toLowerCase();
  const ready =
    EMAIL_RE.test(trimmedRecipient) && senderDomain.length > 0 && !loadingDomains;

  const submit = async () => {
    const res = await mailAdminApi.testEmail.send(
      serverId,
      trimmedRecipient,
      senderDomain,
    );
    setResult(res);
    showToast(s.sentToast, "success", s.toastTitle);
  };

  return (
    <FormModalContent
      title={s.title}
      submitLabel={s.sendTest}
      submittingLabel={s.sending}
      onSubmit={submit}
      onCancel={onClose}
      disabled={!ready}
    >
      <p className="text-sm text-muted-foreground leading-relaxed -mt-1">
        {s.sendsFromBefore}
        <span className="font-mono text-[12.5px] text-foreground">
          openship@{senderDomain || "…"}
        </span>
        {s.sendsFromAfter}
      </p>

      <Field label={s.sendToLabel}>
        <input
          type="email"
          autoFocus
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          spellCheck={false}
          className={inputClassName}
        />
      </Field>

      <Field label={s.fromDomainLabel} hint={s.fromHint}>
        <CustomSelect
          value={senderDomain}
          options={domains.map((d) => ({ value: d.domain, label: d.domain }))}
          onChange={setSenderDomain}
          disabled={loadingDomains || domains.length === 0}
          placeholder={loadingDomains ? s.loadingDomains : s.noActiveDomains}
        />
      </Field>

      {/* The domain fetch failed, so there is nothing to authenticate as — said
          here rather than through FormModalContent, whose error slot only holds
          what the submit itself threw. */}
      {loadError && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
          {loadError}
        </div>
      )}
    </FormModalContent>
  );
}

function SentStage({
  result,
  onClose,
}: {
  result: SendResult;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const s = t.emailsAdmin.sendTest;
  const inbox = recipientInboxLink(result.to);
  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-success-bg text-success">
          <CheckCircle2 className="size-5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-bold text-foreground mb-1">{s.sentTitle}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {s.sentCheckBefore}
            <span className="font-mono text-[12.5px] text-foreground break-all">
              {result.to}
            </span>
            {s.sentCheckMiddle}
            <span className="font-mono text-[12.5px] text-foreground break-all">
              {result.from}
            </span>
            {s.sentCheckAfter}
          </p>
          <p className="mt-2 font-mono text-[11.5px] text-muted-foreground/80 break-all">
            {result.smtpResponse}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        {inbox && (
          <a
            href={inbox.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors"
          >
            <ExternalLink className="size-3.5" />
            {s[inbox.labelKey]}
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {s.close}
        </button>
      </div>
    </div>
  );
}
