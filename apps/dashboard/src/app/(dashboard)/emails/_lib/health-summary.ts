/**
 * The one-line verdict at the top of the Health tab.
 *
 * Three independent readings arrive on their own schedules — daemons and outbound
 * delivery on a 10s poll, DNS on demand — and the banner has to turn them into a
 * single sentence an operator can act on. That means a priority order, and the
 * order is the whole point:
 *
 *   red   = something is broken right now (a daemon down, DNS failing, or mail
 *           not leaving the box)
 *   amber = working, but with something worth looking at (records that only warn,
 *           a daemon this host doesn't ship, mail waiting in the queue)
 *   green = all three readings clean
 *
 * A reading we couldn't take never colours the banner. `unknown` means "we didn't
 * look", and grading it would turn an unreachable probe into an outage.
 *
 * Lives out here, as a pure function, because that ordering is the part most
 * likely to be quietly wrong — see ./health-summary.test.ts.
 */

import { AlertTriangle, Check, CheckCircle2, CircleX } from "lucide-react";

import { interpolate } from "@/components/i18n-provider";
import type { DnsCheck, MailComponentHealth, MailDeliveryHealth } from "@/lib/api";

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
): BannerSummary | null {
  if (!components && !checks && !delivery) return null;

  // Separate "missing" from "down" - a unit that isn't installed on this
  // host is a different operator problem than one that exists and is
  // failing. The banner names which is which so the user doesn't have
  // to scan the whole list to figure out what's broken.
  const downComponents =
    components?.filter(
      (c) => c.status === "failed" || c.status === "inactive",
    ) ?? [];
  const missingComponents =
    components?.filter((c) => c.status === "missing") ?? [];
  const dnsFails = checks?.filter((c) => c.status === "fail").length ?? 0;
  const dnsWarns = checks?.filter((c) => c.status === "warn").length ?? 0;

  const deliveryFails = delivery?.status === "fail";
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
    downComponents.length === 0 &&
    missingComponents.length === 0 &&
    dnsFails === 0 &&
    dnsWarns === 0 &&
    !deliveryFails &&
    !queueNote;

  if (allClean && (components || checks || delivery)) {
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

  if (
    downComponents.length === 0 &&
    missingComponents.length === 0 &&
    dnsFails === 0 &&
    !deliveryFails
  ) {
    const almost: string[] = [];
    if (dnsWarns > 0) {
      almost.push(
        interpolate(dnsWarns === 1 ? h.summary.almostSubOne : h.summary.almostSubOther, { count: String(dnsWarns) }),
      );
    }
    if (queueNote) almost.push(queueNote);
    return {
      Icon: AlertTriangle,
      banner: "bg-warning-bg border-warning-border",
      iconBg: "bg-warning-bg",
      iconColor: "text-warning",
      textColor: "text-warning",
      label: h.summary.almostLabel,
      sub: almost.join(" · "),
    };
  }

  // If only "missing" daemons (nothing actually down, no DNS fails), it's
  // a soft warning - the box doesn't ship that daemon. Don't paint the
  // whole banner red for that.
  if (
    downComponents.length === 0 &&
    missingComponents.length > 0 &&
    dnsFails === 0 &&
    !deliveryFails
  ) {
    const names = missingComponents.map((c) => c.label).join(", ");
    const sub =
      missingComponents.length === 1
        ? h.summary.notInstalledSubOne
        : h.summary.notInstalledSubOther;
    return {
      Icon: AlertTriangle,
      banner: "bg-warning-bg border-warning-border",
      iconBg: "bg-warning-bg",
      iconColor: "text-warning",
      textColor: "text-warning",
      label: interpolate(h.summary.notInstalledLabel, { names }),
      sub: queueNote ? `${sub} · ${queueNote}` : sub,
    };
  }

  const parts: string[] = [];
  if (downComponents.length > 0) {
    parts.push(interpolate(h.summary.partDown, { names: downComponents.map((c) => c.label).join(", ") }));
  }
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
