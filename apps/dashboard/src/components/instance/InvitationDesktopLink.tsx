"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useState } from "react";
import { desktopInstanceLink, invitationClaimPath } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDeploymentInfo } from "@/hooks/useDeploymentInfo";
import { copyText } from "@/lib/clipboard";

/** Invitation delivery changes only how Desktop opens the existing claim
 * screen. Browser and Desktop still authenticate and accept on that instance. */
export function InvitationDesktopLink({ invitationId }: { invitationId: string }) {
  const { t } = useI18n();
  const copy = t.misc.acceptInvite;
  const info = useDeploymentInfo();
  const [link, setLink] = useState<{ address: string; href: string } | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLink(null);
    setCopied(false);
    setShowFallback(false);
    if (window.desktop?.isDesktop || !info?.selfHosted) return;
    try {
      const address = new URL(invitationClaimPath(invitationId), window.location.origin).href;
      setLink({ address, href: desktopInstanceLink(address) });
    } catch {
      /* An instance without a secure public URL still supports browser acceptance. */
    }
  }, [invitationId, info?.selfHosted]);

  if (!link) return null;
  return (
    <div className="space-y-3 rounded-xl bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild className="flex-1">
          <a href={link.href} onClick={() => setShowFallback(true)} rel="noreferrer">
            <Icon name="monitor" className="size-4" />
            {copy.desktopOpen}
          </a>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={copied ? copy.desktopCopied : copy.desktopCopy}
          onClick={() => {
            void copyText(link.address)
              .then(() => setCopied(true))
              .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/components/instance/InvitationDesktopLink"); return setShowFallback(true); });
          }}
        >
          <Icon name={copied ? "check" : "copy"} className="size-4" />
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground" role="status">
        {copied
          ? copy.desktopCopied
          : showFallback
            ? copy.desktopFallback
            : copy.desktopDescription}
      </p>
      {showFallback && (
        <Input
          variant="filled"
          className="bg-background"
          aria-label={copy.desktopCopy}
          value={link.address}
          readOnly
          dir="ltr"
          onFocus={(event) => event.target.select()}
        />
      )}
    </div>
  );
}
