"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Shared consent actions: inside the page rail, fixed on mobile, or pinned
 * below the inline dialog body.
 *
 * Why fixed and not just at the end of the page: `::-webkit-scrollbar { display:
 * none }` is global, so a scrolled-away Authorize button gives the user no visual
 * cue that it exists. On a screen where the whole point is an explicit decision,
 * the decision has to stay on screen.
 */

import { Button } from "@/components/ui/button";
import { useAccessCopy } from "./access-copy";

export function ConsentActions({
  variant,
  busy,
  submitting,
  canAuthorize,
  onDeny,
  onAuthorize,
}: {
  variant: "rail" | "fixed" | "inline";
  busy: boolean;
  submitting: null | "accept" | "deny";
  canAuthorize: boolean;
  onDeny: () => void;
  onAuthorize: () => void;
}) {
  const m = useAccessCopy();

  const buttons = (
    <div className="flex items-center gap-2">
      <Button variant="outline" className="flex-1" disabled={busy} onClick={onDeny}>
        {submitting === "deny" ? <UiIcon name="spinner" className="size-4 animate-spin" /> : m.deny}
      </Button>
      <Button className="flex-1" disabled={busy || !canAuthorize} onClick={onAuthorize}>
        {submitting === "accept" ? (
          <UiIcon name="spinner" className="size-4 animate-spin" />
        ) : (
          m.authorize
        )}
      </Button>
    </div>
  );

  if (variant === "inline")
    return (
      <div className="shrink-0 border-t border-border/40 bg-card px-6 py-4">
        <div className="ms-auto max-w-sm">{buttons}</div>
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
