"use client";

/**
 * Post-install celebration modal — restrained, monochrome, no gradients, no
 * halos, no status pills. It states that mail is live and offers exactly one
 * action: send a test to an address the operator can actually read.
 *
 * Rendered through the shared modal host (useModal → ui/Modal) on the same
 * FormModalContent scaffold as the admin tabs' dialogs, so it inherits the one
 * modal shell instead of hand-rolling an overlay.
 */

import { useState } from "react";
import { mailAdminApi } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { Field, FormModalContent, inputClassName } from "./_shared/form-modal-content";
import { useHostedModal } from "./_shared/hosted-modal";

interface WelcomeModalProps {
  serverId: string;
  /**
   * Domain to send the welcome test FROM. The server authenticates as
   * `postmaster@<domain>` using the credential it stored when this domain
   * was provisioned (install postmaster lives in `state.secrets`; additional
   * domains live in `state.additionalDomains[domain].postmasterPassword`).
   * Surfaced as copy in the headline / "sent from" line.
   */
  domain: string;
  onClose: () => void;
}

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function WelcomeModal({ serverId, domain, onClose }: WelcomeModalProps) {
  useHostedModal({
    open: true,
    onClose,
    maxWidth: "480px",
    content: () => (
      <WelcomeContent serverId={serverId} domain={domain} onClose={onClose} />
    ),
  });
  return null;
}

function WelcomeContent({
  serverId,
  domain,
  onClose,
}: {
  serverId: string;
  domain: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const w = t.emailsAdmin.welcome;
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="p-6 space-y-5">
        <div>
          <h3 className="text-xl font-bold text-foreground mb-1">{w.sentTitle}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {w.sentBefore}
            <span className="font-mono text-[12.5px] text-foreground">
              postmaster@{domain}
            </span>
            {w.sentMiddle}
            <span className="font-mono text-[12.5px] text-foreground break-all">{email}</span>
            {w.sentAfter}
          </p>
        </div>
        <div className="flex items-center justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {w.gotIt}
          </button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    const v = email.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) throw new Error(w.invalidEmail);
    await mailAdminApi.testEmail.send(serverId, v, domain);
    setSent(true);
  };

  return (
    <FormModalContent
      title={w.liveTitle}
      submitLabel={w.sendTest}
      submittingLabel={w.sending}
      onSubmit={submit}
      onCancel={onClose}
      cancelLabel={w.skip}
      disabled={!email.trim()}
    >
      <p className="text-sm text-muted-foreground leading-relaxed -mt-1">
        <span className="font-mono text-[12.5px] text-foreground">{domain}</span>
        {w.liveDescAfter}
      </p>
      <Field label={w.sendToLabel}>
        <input
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          spellCheck={false}
          className={inputClassName}
        />
      </Field>
    </FormModalContent>
  );
}
