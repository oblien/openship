/**
 * Which of /emails' four mutually-exclusive surfaces to render.
 *
 * This used to be four interdependent booleans inlined in the page, each
 * re-stating the others' negations (`!showAdmin && !showList && …`). That shape
 * hid a real bug: `?force=wizard` — written by the Advanced tab's "Re-run setup"
 * and by the engine banner when a box's mail engine has vanished — had no reader
 * at all, so both actions navigated straight back to the admin panel. Exactly one
 * view is possible at a time, so the gate returns one value and the exclusivity is
 * structural instead of something each condition has to restate.
 */
export type MailView = "admin" | "list" | "setup" | "progress";

export interface MailViewInput {
  /** The "add another mail server" flow is open. */
  addingNew: boolean;
  /** A server is selected (from the URL hint or the registry auto-open). */
  hasServer: boolean;
  /** Its /mail/status has arrived. */
  hasStatus: boolean;
  /** The `mail_servers` registry row says installed — the authority for day-2. */
  registryCompleted: boolean;
  /** Every step of the on-disk state file is complete (a just-finished install). */
  isCompleted: boolean;
  /** An install is streaming right now. */
  running: boolean;
  /** The state file has at least one completed/failed step. */
  hasStarted: boolean;
  /** A DNS or PTR hold is waiting on the operator. */
  gatesActive: boolean;
  /** An install finished in THIS session (drives the completion summary). */
  hasCompletionData: boolean;
  /** `?force=wizard` — deliberately re-open setup on an installed server. */
  forceWizard: boolean;
  /** Registered mail servers, for the "several, pick one" list. */
  serverCount: number;
}

export function resolveMailView(i: MailViewInput): MailView {
  // Day-2 admin. `forceWizard` suppresses ONLY this: it's the deliberate "give me
  // the setup form for a server that already has mail" case, so it never
  // manufactures a view of its own and a stale param can't strand the page.
  if (
    !i.addingNew &&
    i.hasServer &&
    i.hasStatus &&
    (i.registryCompleted || i.isCompleted) &&
    !i.running &&
    !i.gatesActive &&
    !i.forceWizard
  ) {
    return "admin";
  }

  if (!i.addingNew && !i.hasServer && i.serverCount > 1) return "list";

  // A live install and an operator-blocking hold outrank a forced re-run: opening
  // the form mid-stream would orphan a running install, and hiding a DNS/PTR gate
  // would bury the one thing waiting on a human.
  if (!i.running && !i.gatesActive && (i.forceWizard || (!i.hasStarted && !i.hasCompletionData))) {
    return "setup";
  }

  return "progress";
}
