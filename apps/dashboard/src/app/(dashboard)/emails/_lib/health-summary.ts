/**
 * The one-line verdict at the top of the Health tab.
 *
 * Three independent readings arrive on their own schedules — daemons and outbound
 * delivery on a 10s poll, DNS on demand — and the banner has to turn them into a
 * single sentence an operator can act on. That means a priority order, and the
 * order is the whole point:
 *
 *   red   = something is broken right now (a REQUIRED daemon down, DNS failing, or
 *           mail not leaving the box)
 *   amber = working, but with something worth looking at (an advisory daemon down,
 *           records that only warn, a daemon this host doesn't ship, mail waiting
 *           in the queue)
 *   green = all three readings clean
 *
 * A reading we couldn't take never colours the banner. An observed SMTP timeout
 * that the API could not attribute still warns: receiving mail is unverified.
 *
 * Lives out here, as a pure function, because that ordering is the part most
 * likely to be quietly wrong — see ./health-summary.test.ts.
 */

import { AlertTriangle, Check, CheckCircle2, CircleX } from "lucide-react";

import { interpolate } from "@/components/i18n-provider";
import type {
  DnsCheck,
  MailComponentHealth,
  MailDeliveryHealth,
  MailPortReachability,
} from "@/lib/api";

export type HealthDict = (typeof import("@/i18n/locales/en/emailsAdmin.json"))["health"];

export interface BannerSummary {
  Icon: typeof Check;
  banner: string;
  iconBg: string;
  iconColor: string;
  textColor: string;
  label: string;
  sub: string;
}

export function summarizeHealth(
  components: MailComponentHealth[] | null,
  checks: DnsCheck[] | null,
  delivery: MailDeliveryHealth | null,
  h: HealthDict,
  reachability: MailPortReachability | null = null,
): BannerSummary | null {
  if (!components && !checks && !delivery && !reachability) return null;

  // Down splits by SEVERITY before anything else. A dead ClamAV and a dead Postfix
  // are both `failed`, but only one of them means this box has stopped being a mail
  // server — and one bucket painted the banner red for either, so an advisory daemon
  // read as an outage. The marker is the server's (the same one the install gate
  // uses); grading it off a key list here would be a second definition.
  //
  // `!== "advisory"` rather than `=== "required"`: severity is required in TypeScript
  // but arrives as unvalidated JSON, and a row an older API didn't stamp must fail
  // SAFE to required — landing in neither bucket would give the banner a heading with
  // no sentence under it.
  //
  // "Missing" stays its own bucket: a unit this host never shipped is a different
  // operator problem from one that exists and is failing.
  //
  // `informational` is dropped BEFORE that split, and it has to be: the fail-safe above
  // would otherwise sort it into `requiredDown` and paint the banner RED for a daemon
  // nothing consults (GH-240 — spamd, while amavis scores spam in-process). Explicitly
  // opting a row out is a different act from an older API forgetting to stamp one, which
  // is why this is a separate marker and not a third value of the same test.
  const graded = components?.filter((c) => c.severity !== "informational") ?? [];
  const down = graded.filter((c) => c.status === "failed" || c.status === "inactive");
  const requiredDown = down.filter((c) => c.severity !== "advisory");
  const advisoryDown = down.filter((c) => c.severity === "advisory");
  const missingComponents = graded.filter((c) => c.status === "missing");
  const dnsFails = checks?.filter((c) => c.status === "fail").length ?? 0;
  const dnsWarns = checks?.filter((c) => c.status === "warn").length ?? 0;

  const deliveryFails = delivery?.status === "fail";
  const reachabilityFails = reachability?.status === "fail";
  // Trust the API's classification. An unknown result with a failed TCP probe
  // needs attention even though it cannot establish an inbound-mail outage.
  const reachabilityUnverified =
    reachability?.status === "unknown" &&
    reachability.ports.some((port) => port.status === "blocked");
  // Mail waiting in the queue is worth the operator's eyes, but a warn here is
  // also how a healthy MTA rides out a receiver's greylist - so it colours the
  // banner amber and points at the card, never red.
  // Non-null for every delivery warn: the server only warns on a queue that has
  // something in it, so this doubles as the "delivery is warning" flag below and
  // the banner can't end up with a heading and no sentence under it.
  const queueNote =
    delivery?.status === "warn" && delivery.queued > 0
      ? interpolate(
          delivery.queued === 1
            ? h.summary.almostSubQueueOne
            : h.summary.almostSubQueueOther,
          { count: String(delivery.queued) },
        )
      : null;

  const allClean =
    down.length === 0 &&
    missingComponents.length === 0 &&
    dnsFails === 0 &&
    dnsWarns === 0 &&
    !deliveryFails &&
    !reachabilityFails &&
    !reachabilityUnverified &&
    !queueNote;

  if (allClean && (components || checks || delivery || reachability)) {
    return {
      Icon: CheckCircle2,
      banner: "bg-success-bg border-success-border",
      iconBg: "bg-success-bg",
      iconColor: "text-success",
      textColor: "text-success",
      label: h.summary.allGoodLabel,
      sub: h.summary.allGoodSub,
    };
  }

  // Amber: nothing REQUIRED is down and nothing hard-fails. Advisory daemons that are
  // down, daemons this host never shipped, warn-only DNS records and a queue with
  // something in it all live here — one branch, so a box with two amber causes gets one
  // sentence instead of whichever branch happened to come first. (That merge is a
  // deliberate behaviour change for one combination: missing daemons alongside DNS
  // warnings used to drop the DNS sentence.)
  if (requiredDown.length === 0 && dnsFails === 0 && !deliveryFails && !reachabilityFails) {
    const almost: string[] = [];
    almost.push(...advisoryNotes(advisoryDown, h));
    // The heading names the most consequential amber cause: a daemon that is down and
    // meant to be running outranks one this host never shipped.
    const namesMissing = missingComponents.map((c) => c.label).join(", ");
    const labelNamesMissing = advisoryDown.length === 0 && missingComponents.length > 0;
    if (missingComponents.length > 0) {
      // When the heading already names them, the sub explains; when it doesn't, the sub
      // has to name them, or "Mail still works without it" refers to nothing.
      almost.push(
        labelNamesMissing
          ? missingComponents.length === 1
            ? h.summary.notInstalledSubOne
            : h.summary.notInstalledSubOther
          : interpolate(h.summary.partNotInstalled, { names: namesMissing }),
      );
    }
    if (dnsWarns > 0) {
      almost.push(
        interpolate(dnsWarns === 1 ? h.summary.almostSubOne : h.summary.almostSubOther, { count: String(dnsWarns) }),
      );
    }
    if (queueNote) almost.push(queueNote);
    if (reachabilityUnverified) almost.push(h.reachability.unknownHint);
    const label =
      advisoryDown.length > 0
        ? h.summary.degradedLabel
        : labelNamesMissing
          ? interpolate(h.summary.notInstalledLabel, { names: namesMissing })
          : h.summary.almostLabel;
    return {
      Icon: AlertTriangle,
      banner: "bg-warning-bg border-warning-border",
      iconBg: "bg-warning-bg",
      iconColor: "text-warning",
      textColor: "text-warning",
      label,
      sub: almost.join(" · "),
    };
  }

  const parts: string[] = [];
  if (requiredDown.length > 0) {
    parts.push(interpolate(h.summary.partDown, { names: requiredDown.map((c) => c.label).join(", ") }));
  }
  // An advisory daemon down beside a real outage still gets named — it just doesn't
  // get to be the reason the banner is red.
  parts.push(...advisoryNotes(advisoryDown, h));
  if (missingComponents.length > 0) {
    parts.push(
      interpolate(h.summary.partNotInstalled, { names: missingComponents.map((c) => c.label).join(", ") }),
    );
  }
  if (dnsFails > 0) {
    parts.push(interpolate(dnsFails === 1 ? h.summary.partDnsOne : h.summary.partDnsOther, { count: String(dnsFails) }));
  }
  // Only a delivery `fail` earns a line here. A backlog next to a dead daemon is
  // that daemon's symptom, and repeating it would bury the cause.
  if (deliveryFails) parts.push(h.summary.partDelivery);
  if (reachabilityFails) parts.push(h.summary.partReachability);

  return {
    Icon: CircleX,
    banner: "bg-danger-bg border-danger-border",
    iconBg: "bg-danger-bg",
    iconColor: "text-danger",
    textColor: "text-danger",
    label: h.summary.issuesLabel,
    sub: parts.join(" · "),
  };
}

/**
 * Advisory is not "harmless", and the kinds of advisory-down have different
 * consequences — so the sentence is chosen by WHICH daemon it is.
 *
 *  - amavis / clamav: the engine's runtime amavis config (apps/email/engine/samples/
 *    amavisd/amavisd.conf, landed as /etc/amavis/conf.d/50-user) declares ONE scanner
 *    (clamav-socket) and `@av_scanners_backup = ()`, so with clamd gone there is nothing
 *    to scan with. The message is then DELIVERED UNSCANNED (GH-565): that config sets
 *    neither `$virus_scanners_failure_is_fatal` nor `$final_unchecked_destiny`, and
 *    `$undecipherable_subject_tag` is `undef`, so nothing defers it and nothing labels
 *    it. This copy used to promise the opposite ("may queue") — which left an operator
 *    waiting for mail to resume while unscanned mail was already landing in inboxes.
 *    Amavis still stamps `X-Virus-Scanned`; that header means amavis SAW the message,
 *    not that a scanner passed it. Failing closed is an opt-in documented in amavisd.conf.
 *  - freshclam: clamd keeps answering, so mail keeps flowing — against a signature set
 *    that has stopped moving forward. Scanned, but against ageing signatures.
 *  - spamd / iRedAPD / fail2ban: delivery is unaffected.
 */
const SCANNING_KEYS = new Set(["clamav", "amavis"]);
const SIGNATURE_KEYS = new Set(["freshclam"]);

function advisoryNotes(rows: MailComponentHealth[], h: HealthDict): string[] {
  if (rows.length === 0) return [];
  const names = (subset: MailComponentHealth[]) => subset.map((c) => c.label).join(", ");
  const scanning = rows.filter((c) => SCANNING_KEYS.has(c.key));
  const signatures = rows.filter((c) => SIGNATURE_KEYS.has(c.key));
  const other = rows.filter((c) => !SCANNING_KEYS.has(c.key) && !SIGNATURE_KEYS.has(c.key));
  const out: string[] = [];
  if (scanning.length > 0) out.push(interpolate(h.summary.partScanning, { names: names(scanning) }));
  if (signatures.length > 0) out.push(interpolate(h.summary.partSignatures, { names: names(signatures) }));
  if (other.length > 0) out.push(interpolate(h.summary.partAdvisory, { names: names(other) }));
  return out;
}
