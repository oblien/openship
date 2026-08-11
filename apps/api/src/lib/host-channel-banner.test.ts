import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The boot banner exists for boxes installed BEFORE the CLI preflight shipped:
 * nothing else on those instances ever tells the operator the host channel is dead
 * (#490). So what's pinned here is the operator-facing contract — silence when
 * there is nothing to say, and a copy-pasteable rule when there is — plus the
 * property that a failed CHECK is never reported as a failed CHANNEL.
 */

const h = vi.hoisted(() => ({ env: { CLOUD_MODE: false, DEPLOY_MODE: "docker" as string } }));

vi.mock("../config/env", () => ({ env: h.env }));
// Only the probe is stubbed: the impact copy the banner prints is shared (#490), and a
// test that asserted against a mocked copy would pass while the real lines said anything.
vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hostChannelHealth: vi.fn(async () => ({ ok: true, code: "ok" })),
}));

import { HOST_CHANNEL_NOT_PROVISIONED, HOST_CHANNEL_UNPROVISIONED } from "@repo/core";

import { reportHostChannelAtBoot } from "./host-channel-banner";

/**
 * Shaped like real `hostChannelHealth` output: the rule is NOT inside the hint. The
 * two are separate fields because prose gets wrapped to the terminal and a command
 * must not be, and this fixture is the reason the banner can't quietly go back to
 * concatenating them.
 */
const UNREACHABLE = {
  ok: false,
  code: "unreachable" as const,
  host: "host.docker.internal",
  port: 22,
  target: "root@host.docker.internal:22",
  rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
  hint:
    "root@host.docker.internal:22 — no response, not even a refusal (ETIMEDOUT). That is " +
    "what a dropped packet looks like. This address is host-local, so the connection " +
    "traverses the host's filter/INPUT chain, where a default-deny firewall applies.",
};

function lines() {
  const out: string[] = [];
  return { out, log: (line: string) => out.push(line) };
}

beforeEach(() => {
  h.env.CLOUD_MODE = false;
  h.env.DEPLOY_MODE = "docker";
});

describe("reportHostChannelAtBoot — when it stays quiet", () => {
  it("does not even probe in cloud mode", async () => {
    h.env.CLOUD_MODE = true;
    const { out, log } = lines();
    const health = vi.fn();
    expect(await reportHostChannelAtBoot({ health, log })).toBe("cloud");
    expect(health).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("does not probe when DEPLOY_MODE is cloud without CLOUD_MODE", async () => {
    h.env.DEPLOY_MODE = "cloud";
    const health = vi.fn();
    expect(await reportHostChannelAtBoot({ health, log: () => {} })).toBe("cloud");
    expect(health).not.toHaveBeenCalled();
  });

  it("says nothing when the channel answers", async () => {
    const { out, log } = lines();
    const health = async () => ({ ok: true, code: "ok" as const });
    expect(await reportHostChannelAtBoot({ health, log })).toBe("ok");
    expect(out).toEqual([]);
  });

  it("says nothing on a bare install, where there is no channel to dial", async () => {
    const { out, log } = lines();
    const health = async () => ({ ok: true, code: "not_applicable" as const });
    expect(await reportHostChannelAtBoot({ health, log })).toBe("not_applicable");
    expect(out).toEqual([]);
  });

  it("does not nag about a deliberate --no-host-control opt-out", async () => {
    const { out, log } = lines();
    const health = async () => ({
      ok: false,
      code: "disabled" as const,
      hint: "Host control is off (OPENSHIP_HOST_CONTROL=false).",
    });
    expect(await reportHostChannelAtBoot({ health, log })).toBe("disabled");
    expect(out).toEqual([]);
  });
});

describe("reportHostChannelAtBoot — a blocked channel", () => {
  it("names the endpoint and prints the rule once, with the blast radius", async () => {
    const { out, log } = lines();
    expect(await reportHostChannelAtBoot({ health: async () => UNREACHABLE, log })).toBe(
      "unreachable",
    );

    const text = out.join("\n");
    expect(text).toContain("HOST CONTROL UNREACHABLE — root@host.docker.internal:22");
    // Exactly one copy of the rule, and it is the one under "Fix:".
    expect(text.split(UNREACHABLE.rule)).toHaveLength(2);
    expect(text).toContain("Fix:");
    // Deploys keep working — an operator must not read this as "my box is broken".
    expect(text).toContain("deploys to this box still work");
    expect(text).toContain('reads "Offline"');
    expect(text).toContain("openship up --no-host-control");
    // …and the repair comes before the switch that only hides the warning.
    expect(text.indexOf(UNREACHABLE.rule)).toBeLessThan(text.indexOf("--no-host-control"));
    // Every body line is prefixed so the banner is greppable and visually one block.
    expect(out.filter((l) => l !== "").every((l) => l.startsWith("!!! "))).toBe(true);
  });

  it("wraps the hint without dropping any of it", async () => {
    const { out, log } = lines();
    await reportHostChannelAtBoot({ health: async () => UNREACHABLE, log });
    const body = out
      .filter((l) => l.startsWith("!!! "))
      .map((l) => l.slice(4))
      .join(" ");
    expect(body).toContain(UNREACHABLE.hint);
    expect(out.every((l) => l.length <= 96)).toBe(true);
  });

  it("never reflows a multi-line rule — each command stays pasteable", async () => {
    const { out, log } = lines();
    // In a container we can't tell ufw from firewalld, so the rule offers both and is
    // long. Wrapping it would produce commands that look right and don't run.
    const rule = [
      "# ufw:",
      "sudo ufw allow from 172.18.0.0/16 to any port 2222 proto tcp",
      "# firewalld:",
      `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.18.0.0/16" port port="2222" protocol="tcp" accept'`,
      "sudo firewall-cmd --reload",
    ].join("\n");
    const health = async () => ({
      ok: false,
      code: "unreachable" as const,
      target: "root@10.0.0.4:2222",
      hint: "Nothing answered.",
      rule,
    });
    await reportHostChannelAtBoot({ health, log });
    const printed = out.map((l) => l.replace(/^!!!\s*/, ""));
    for (const command of rule.split("\n")) expect(printed).toContain(command);
  });

  it("reports a container with no channel provisioned at all", async () => {
    const { out, log } = lines();
    // The hint as `hostChannelHealth` actually builds it (#509) — taken from @repo/core
    // rather than retyped, or this fixture would keep passing while the real boot log
    // said something else.
    const health = async () => ({
      ok: false,
      code: "not_configured" as const,
      hint: `${HOST_CHANNEL_UNPROVISIONED} ${HOST_CHANNEL_NOT_PROVISIONED}`,
    });
    expect(await reportHostChannelAtBoot({ health, log })).toBe("not_configured");
    // Unwrapped: the hint is prose, so the banner wraps it and no single output line
    // holds the whole sentence.
    const text = out.map((l) => l.replace(/^!!!\s*/, "")).join(" ");
    expect(out.join("\n")).toContain("HOST CONTROL NOT CONFIGURED");
    expect(text).toContain("no host channel");
    // Both halves of the remedy: what repairs it, and how to confirm the repair.
    expect(text).toContain("openship up");
    expect(text).toContain("openship doctor");
    // No firewall rule was implicated, so none is suggested.
    expect(text).not.toContain("Fix:");
    expect(text).not.toContain("ufw");
  });

  it("reports an unreadable key against its endpoint", async () => {
    const { out, log } = lines();
    const health = async () => ({
      ok: false,
      code: "key_unreadable" as const,
      target: "root@host.docker.internal:22",
      hint: "Cannot read the host SSH key at /app/.ssh/host_key (ENOENT).",
    });
    expect(await reportHostChannelAtBoot({ health, log })).toBe("key_unreadable");
    expect(out.join("\n")).toContain("HOST CONTROL KEY UNREADABLE — root@host.docker.internal:22");
  });
});

describe("reportHostChannelAtBoot — a failed check is not a failed channel", () => {
  it("swallows a probe that throws and blames nothing", async () => {
    const { out, log } = lines();
    const health = async () => {
      throw new Error("no procfs");
    };
    expect(await reportHostChannelAtBoot({ health, log })).toBe("error");
    expect(out).toEqual([]);
  });
});
