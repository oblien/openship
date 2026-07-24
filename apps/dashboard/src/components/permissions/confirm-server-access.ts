import type { PickerGrant } from "@/lib/api";

/**
 * Shared "you are about to grant server access" confirm. Granting a user access
 * to a server is high-blast-radius: server access covers every deployment and
 * its data, the apps running on it, stored secrets/env, terminal access, and any
 * connected integrations (GitHub tokens / deploy keys held for that server). So
 * both grant-commit paths — the member-access editor and the invite flow — funnel
 * through this ONE helper before persisting, rather than each re-implementing the
 * warning. (The PAT token-scope picker deliberately does NOT use it: that's a
 * different actor model.)
 */

// Minimal structural view of the modal API — kept inline so this helper doesn't
// couple to ModalContext's internal config type.
type ShowModal = (config: {
  title?: string;
  message?: string;
  icon?: string;
  onClose?: () => void;
  buttons?: { label: string; onClick: () => void; variant?: "primary" | "secondary" | "danger" }[];
}) => string;
type HideModal = (id?: string) => void;

export interface ServerGrantDelta {
  /** A wildcard ("*" = all servers) server grant is being newly added. */
  wildcard: boolean;
  /** Specific server ids newly granted (excludes the wildcard). */
  ids: string[];
}

/**
 * Server grants present in `next` but not already in `previous` (by resourceId).
 * Only additions trigger the warning — re-saving an unchanged existing grant, or
 * editing an unrelated (e.g. project) grant, must not nag. For the invite flow
 * pass `previous = []` so every server grant counts as new.
 */
export function serversNewlyGranted(previous: PickerGrant[], next: PickerGrant[]): ServerGrantDelta {
  const had = new Set(
    previous
      .filter((g) => g.resourceType === "server" && g.permissions.length > 0)
      .map((g) => g.resourceId),
  );
  const added = next.filter(
    (g) => g.resourceType === "server" && g.permissions.length > 0 && !had.has(g.resourceId),
  );
  return {
    wildcard: added.some((g) => g.resourceId === "*"),
    ids: added.filter((g) => g.resourceId !== "*").map((g) => g.resourceId),
  };
}

export function hasNewServerGrant(delta: ServerGrantDelta): boolean {
  return delta.wildcard || delta.ids.length > 0;
}

/**
 * Show the warning and resolve to the owner's decision (true = proceed). Resolves
 * false on cancel or any dismissal (backdrop / close button), so the caller can
 * safely abort. Copy is passed in fully resolved — the helper stays i18n-agnostic.
 */
export function confirmServerAccess(opts: {
  showModal: ShowModal;
  hideModal: HideModal;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let id = "";
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    id = opts.showModal({
      title: opts.title,
      message: opts.message,
      icon: "warning",
      // Backdrop / X dismissal is treated as "cancel".
      onClose: () => done(false),
      buttons: [
        // secondary buttons don't auto-close → close explicitly.
        { label: opts.cancelLabel, variant: "secondary", onClick: () => { opts.hideModal(id); done(false); } },
        // danger auto-closes after onClick; done(true) runs first so the trailing
        // onClose → done(false) is a no-op.
        { label: opts.confirmLabel, variant: "danger", onClick: () => done(true) },
      ],
    });
  });
}
