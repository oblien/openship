import { hostChannelHealth, type HostChannelHealth } from "@repo/adapters";
import {
  HOST_CHANNEL_BLOCKED,
  HOST_CHANNEL_OPT_OUT,
  HOST_CHANNEL_RECHECK,
  HOST_CHANNEL_SYMPTOM,
  HOST_CHANNEL_UNAFFECTED,
  wrapText,
} from "@repo/core";
import { env } from "../config/env";

/**
 * Boot-time diagnosis of the container→host SSH channel (#490).
 *
 * The channel's address is host-LOCAL, so unlike a published container port it
 * traverses the host's filter/INPUT chain — where a default-deny ufw silently DROPs
 * it. `openship up` now probes during install; this covers boxes provisioned before
 * that existed, and any box whose firewall changed under a running install.
 *
 * Never throws and never blocks boot.
 */
export interface HostChannelBannerDeps {
  health: (timeoutMs?: number) => Promise<HostChannelHealth>;
  log: (line: string) => void;
}

const TITLES: Partial<Record<HostChannelHealth["code"], string>> = {
  unreachable: "HOST CONTROL UNREACHABLE",
  not_configured: "HOST CONTROL NOT CONFIGURED",
  key_unreadable: "HOST CONTROL KEY UNREADABLE",
  auth_rejected: "HOST CONTROL KEY REFUSED",
};

/** One blocked item, wrapped with a hanging indent so a long one still reads as a
 *  single bullet rather than two. */
function bullet(item: string): string[] {
  return wrapText(item, 84).map((line, i) => (i === 0 ? `  - ${line}` : `    ${line}`));
}

/** The shared #490 impact copy, laid out for a boot log: one reassurance, then the
 *  blocked list as its own lines so it survives being skimmed. */
const IMPACT = [
  ...wrapText(HOST_CHANNEL_UNAFFECTED),
  "Blocked until the channel works:",
  ...HOST_CHANNEL_BLOCKED.flatMap(bullet),
  ...wrapText(HOST_CHANNEL_SYMPTOM),
];

function defaultDeps(): HostChannelBannerDeps {
  return { health: hostChannelHealth, log: (line) => console.error(line) };
}

export async function reportHostChannelAtBoot(
  overrides: Partial<HostChannelBannerDeps> = {},
): Promise<HostChannelHealth["code"] | "cloud" | "error"> {
  // The multi-tenant SaaS drives no host of its own.
  if (env.CLOUD_MODE || env.DEPLOY_MODE === "cloud") return "cloud";

  const deps = { ...defaultDeps(), ...overrides };

  // A diagnostic that can't run says nothing: "we failed to check" must never be
  // dressed up as "your firewall is blocking this".
  let health: HostChannelHealth;
  try {
    health = await deps.health();
  } catch {
    return "error";
  }

  // `ok` covers a bare install (not_applicable) as well as a working channel.
  // `disabled` is a deliberate --no-host-control opt-out: don't nag every restart.
  if (health.ok || health.code === "disabled") {
    // One narrow advisory on an otherwise healthy channel: it execs fine but refuses TCP
    // forwards, which breaks exactly one thing — the deploy-time readiness probe, whose
    // published-port candidate can only be dialed from the host. Said here so an operator
    // learns it BEFORE a deploy rather than from a health check that falls back to `curl`
    // (or, on an install predating that fallback, from "the app never answered" about an
    // app that was answering all along — GH-583).
    //
    // Deliberately not the full !!! banner: nothing is broken yet, and the block above
    // owns the "this box cannot drive its host" story.
    if (health.forwarding === "blocked") {
      deps.log(
        `[host-channel] ${health.target ?? "the host channel"} refuses TCP forwarding, so ` +
          `deploy health checks fall back to \`curl\` on the host (and are skipped if it ` +
          `has none). Re-run \`openship up\` to re-provision the channel with forwarding.`,
      );
    }
    return health.code;
  }

  const title = TITLES[health.code] ?? "HOST CONTROL UNAVAILABLE";
  const headline = health.target ? `${title} — ${health.target}` : title;

  const body = [...(health.hint ? wrapText(health.hint) : []), ...IMPACT];
  // Never wrapped: the rule is multi-line and each line is a command to paste.
  if (health.rule) body.push("Fix:", ...health.rule.split("\n").map((line) => `  ${line}`));
  // Fix first, then how to confirm it worked, and only then the opt-out — an operator
  // reading top-down must reach the repair before the switch that hides the warning.
  body.push(...wrapText(HOST_CHANNEL_RECHECK), ...wrapText(HOST_CHANNEL_OPT_OUT));

  deps.log("");
  deps.log(`!!! ${headline}`);
  for (const line of body) deps.log(`!!! ${line}`);
  deps.log("");
  return health.code;
}
