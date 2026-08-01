"use client";

/**
 * Deny / Authorize. One component, two mount points: inside the sticky rail on
 * large screens, and as a fixed bottom bar below `lg`.
 *
 * Why fixed and not just at the end of the page: `::-webkit-scrollbar { display:
 * none }` is global, so a scrolled-away Authorize button gives the user no visual
 * cue that it exists. On a screen where the whole point is an explicit decision,
 * the decision has to stay on screen.
 */

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export function ActionBar({
  variant,
  busy,
  submitting,
  canAuthorize,
  onDeny,
  onAuthorize,
}: {
  variant: "rail" | "fixed";
  busy: boolean;
  submitting: null | "accept" | "deny";
  canAuthorize: boolean;
  onDeny: () => void;
  onAuthorize: () => void;
}) {
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;

  const buttons = (
    <div className="flex items-center gap-2">
      <Button variant="outline" className="flex-1" disabled={busy} onClick={onDeny}>
        {submitting === "deny" ? <Loader2 className="size-4 animate-spin" /> : m.deny}
      </Button>
      <Button className="flex-1" disabled={busy || !canAuthorize} onClick={onAuthorize}>
        {submitting === "accept" ? <Loader2 className="size-4 animate-spin" /> : m.authorize}
      </Button>
    </div>
  );

  // `shrink-0` matters: this is the pinned footer of the rail's flex column, and
  // without it the buttons would compress instead of the scroll area shrinking.
  if (variant === "rail") return <div className="hidden shrink-0 lg:block">{buttons}</div>;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border/60 bg-card/95 px-4 py-3 backdrop-blur lg:hidden"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {buttons}
    </div>
  );
}
