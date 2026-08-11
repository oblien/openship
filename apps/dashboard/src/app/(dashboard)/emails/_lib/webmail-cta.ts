/**
 * Which of the hero card's three mutually-exclusive webmail CTAs to render.
 *
 * Same reason `view-gate` exists: the slot used to be a two-branch ternary on
 * `installed && url`, which folded a THIRD state into the deploy branch. When the
 * API can't read a webmail's route rows it degrades on purpose — `installed: true`,
 * `routingUnknown: true`, no hostname and no URL — so a deployed webmail rendered a
 * "Deploy webmail" button. That is wrong advice, not just a wrong word: nothing is
 * missing to deploy, and a redeploy cannot fix a failed routing read.
 *
 * `routingUnknown` already has a reader on the deploy wizard (it stops prefilling a
 * domain it never saw); this is the same signal read on the display side.
 */

export type WebmailCta =
  /** Address known — link straight at it. */
  | { kind: "open"; url: string }
  /** Installed, address unreadable — the project owns the route rows and the logs. */
  | { kind: "project"; projectId: string }
  /** Genuinely not installed, or installed outside Openship with no project row. */
  | { kind: "deploy" };

export interface WebmailCtaInput {
  installed: boolean;
  url: string;
  /** The API could not read the routing, rather than there being none. */
  routingUnknown?: boolean;
  /** Absent when the webmail was adopted or deployed outside Openship. */
  projectId?: string | null;
}

export function webmailCta(webmail: WebmailCtaInput | undefined): WebmailCta {
  if (!webmail) return { kind: "deploy" };
  if (webmail.installed && webmail.url) return { kind: "open", url: webmail.url };
  // Only when there is somewhere to send them. An adopted webmail whose route we
  // also couldn't read has no project page, and "deploy" is then the honest offer —
  // it is how an out-of-band install becomes a managed one.
  if (webmail.installed && webmail.routingUnknown && webmail.projectId) {
    return { kind: "project", projectId: webmail.projectId };
  }
  return { kind: "deploy" };
}
