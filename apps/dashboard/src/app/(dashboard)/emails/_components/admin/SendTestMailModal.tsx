"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Send Test Mail modal.
 *
 * The server flow loads the provisioned domains for the given mail server, lets the
 * operator pick which domain to send AS, and POSTs to
 * `mail/admin/:serverId/test-email`. The backend ensures (creates if
 * missing) an `openship@<fromDomain>` mailbox and authenticates as that
 * identity — so SMTP AUTH user == MAIL FROM and Postfix's
 * `reject_sender_login_mismatch` policy is satisfied. Subject and body
 * are hardcoded server-side; this form only collects recipient + sender
 * domain. Managed sending uses the selected domain and its Cloud API receipt.
 *
 * Rendered through the dashboard's shared modal host (useModal → ui/Modal) so
 * it has the same shell, scrim and stacking as every other modal; the form body
 * is the same FormModalContent scaffold the admin tabs use.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagedMailReceipt, SendingDomainStatus } from "@repo/contracts/managed-mail";
import { managedMailApi } from "@/lib/api/managed-mail";
import { useScopedMutation, useScopedResource } from "@/hooks/use-scoped-resource";
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

type Target =
  | { serverId: string; managedDomain?: never; onStatus?: never; onSubmitted?: never }
  | { serverId?: never; managedDomain: SendingDomainStatus; onStatus(status: SendingDomainStatus): void; onSubmitted(): void };

type Props = Target & {
  open: boolean;
  onClose: () => void;
};

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
  smtpResponse?: string;
  receipt?: ManagedMailReceipt;
}

export function SendTestMailModal({ open, onClose, ...target }: Props) {
  useHostedModal({
    open,
    onClose,
    maxWidth: "520px",
    content: () => <SendTestMailContent {...target} onClose={onClose} />,
  });
  return null;
}

function SendTestMailContent({
  serverId,
  managedDomain,
  onStatus,
  onSubmitted,
  onClose,
}: Target & { onClose: () => void }) {
  const [recipient, setRecipient] = useState("");
  const [senderDomain, setSenderDomain] = useState(managedDomain?.domain ?? "");
  const attempt = useRef<{ to: string; key: string } | null>(null);
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [loadingDomains, setLoadingDomains] = useState(!managedDomain);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const { showToast } = useToast();
  const { t } = useI18n();
  const s = t.emailsAdmin.sendTest;
  // The modal host captures its opening props. Re-read a pending domain while
  // the recipient is being entered so activation never discards the draft.
  const pendingId = managedDomain && managedDomain.state !== "ready" ? managedDomain.id : undefined;
  const readiness = useScopedResource(
    useCallback(async () => pendingId ? managedMailApi.sender(pendingId) : null, [pendingId]),
    pendingDomainInterval,
  );
  useEffect(() => {
    if (readiness.data) onStatus?.(readiness.data);
  }, [readiness.data, onStatus]);
  const currentDomain = readiness.data ?? managedDomain;
  const waiting = currentDomain && currentDomain.state !== "ready";

  // Active domains only — the test would fail at SMTP auth otherwise.
  useEffect(() => {
    if (!serverId) return;
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

  const trimmedRecipient = managedDomain ? recipient.trim() : recipient.trim().toLowerCase();
  const ready =
    EMAIL_RE.test(trimmedRecipient) && senderDomain.length > 0 && !loadingDomains && !waiting;

  const submit = async () => {
    if (managedDomain) {
      if (attempt.current?.to !== trimmedRecipient)
        attempt.current = { to: trimmedRecipient, key: crypto.randomUUID() };
      const res = await managedMailApi.testEmail(managedDomain.id, {
        to: trimmedRecipient, idempotencyKey: attempt.current.key,
      });
      setResult(res);
      onSubmitted();
      return;
    }
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
        {managedDomain ? null : s.sendsFromAfter}
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
      {waiting && <div role="status" className="space-y-1 text-sm text-muted-foreground">
        <p>{currentDomain.state === "verification_failed" ? t.emails.cloudClient.verification.failed
          : currentDomain.state === "disabled" ? t.emailsAdmin.domains.disabled : t.emails.cloudClient.testDelivery.waiting}</p>
        {currentDomain.reason && <p>{currentDomain.reason}</p>}
        {readiness.error && <p role="alert">{readiness.error}</p>}
        <button type="button" disabled={readiness.loading || readiness.refreshing} onClick={readiness.refresh} className="underline">{t.actions.refresh}</button>
      </div>}

      {!managedDomain && <Field label={s.fromDomainLabel} hint={s.fromHint}>
        <CustomSelect
          value={senderDomain}
          options={domains.map((d) => ({ value: d.domain, label: d.domain }))}
          onChange={setSenderDomain}
          disabled={loadingDomains || domains.length === 0}
          placeholder={loadingDomains ? s.loadingDomains : s.noActiveDomains}
        />
      </Field>}

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
  const delivery = t.emails.cloudClient.testDelivery;
  const [receipt, setReceipt] = useState(result.receipt);
  const check = useScopedMutation();
  const failed = receipt && ["failed", "bounced", "complained", "suppressed"].includes(receipt.state);
  const inbox = recipientInboxLink(result.to);
  return (
    <section aria-label={s.toastTitle} className="p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${failed ? "bg-danger-bg text-danger" : receipt && receipt.state !== "delivered" ? "bg-muted text-foreground" : "bg-success-bg text-success"}`}>
          <UiIcon name={receipt && receipt.state !== "delivered" ? "mail" : "check-circle"} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-bold text-foreground mb-1">{receipt ? s.toastTitle : s.sentTitle}</h3>
          {receipt ? <div role="status" className="space-y-2 text-sm">
            <p className="font-medium">{delivery.states[receipt.state]}</p>
            <p className="break-all text-muted-foreground">{result.from} → {result.to}</p>
            <p className="break-all text-xs text-muted-foreground">{delivery.messageId} <code>{receipt.id}</code></p>
            {receipt.reason && <p>{receipt.reason}</p>}
          </div> : <p className="text-sm text-muted-foreground leading-relaxed">
            {s.sentCheckBefore}
            <span className="font-mono text-[12.5px] text-foreground break-all">
              {result.to}
            </span>
            {s.sentCheckMiddle}
            <span className="font-mono text-[12.5px] text-foreground break-all">
              {result.from}
            </span>
            {s.sentCheckAfter}
          </p>}
          {result.smtpResponse && <p className="mt-2 font-mono text-[11.5px] text-muted-foreground/80 break-all">
            {result.smtpResponse}
          </p>}
          {check.error && <p role="alert" className="mt-2 text-sm text-danger">{check.error}</p>}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        {receipt && !failed && receipt.state !== "delivered" && (
          <button type="button" disabled={check.busy} className="text-sm text-muted-foreground hover:text-foreground" onClick={async () => {
            const current = await check.execute(() => managedMailApi.message(receipt.id));
            if (current) setReceipt(current);
          }}>{check.busy ? t.emailsAdmin.dns.loading : t.actions.refresh}</button>
        )}
        {inbox && (
          <a
            href={inbox.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors"
          >
            <UiIcon name="external-link" className="size-3.5" />
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
    </section>
  );
}

function pendingDomainInterval(domain: SendingDomainStatus | null) {
  return domain?.state === "verifying" || domain?.state === "pending_dns" ? 30_000 : 0;
}
