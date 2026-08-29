/**
 * This machine, resolved synchronously.
 *
 * The CLI's install preview is sync top to bottom (`spawnSync` throughout), which is why
 * it used to fabricate a profile from `process.platform` and cast it with
 * `as unknown as EnvironmentProfile` — a hand-written host that agreed with the real
 * detector about nothing but the OS, and reported `packageManager: "apt"` on a Fedora
 * laptop.
 *
 * So: the **same script** through `spawnSync`, and the **same parser**. Sync and async
 * differ only in how they hand one string to one shell. The result is published into
 * `environment.ts`'s cache under the local executor's key, so `resolveEnvironment()` and
 * `resolveLocalEnvironmentSync()` cannot hold different beliefs about this box.
 */

import { spawnSync } from "node:child_process";

import { safeErrorMessage, type EnvironmentProfile } from "@repo/core";

import { createExecutor } from "./executor";
import {
  cacheEnvironment,
  ENVIRONMENT_PROBE_SCRIPT,
  ENVIRONMENT_PROBE_TIMEOUT_MS,
  invalidateEnvironment,
  parseEnvironmentProbe,
  profileIsFresh,
} from "./environment";

let cached: { readonly measuredAt: number; readonly profile: EnvironmentProfile } | null = null;

/**
 * A refusal for the case where no shell could be reached at all.
 *
 * Routed through the parser rather than hand-written so every field lands the way a
 * measured host's would, and only the reason is ours — the parser's own wording blames
 * an sshd forced command, which is a sentence about a remote host and would be a lie
 * about this one.
 */
function unmeasurable(reason: string): EnvironmentProfile {
  return {
    ...parseEnvironmentProbe({ text: "", failed: true, unanswered: true }),
    unsupportedReason: reason,
  };
}

function probeLocalHost(): EnvironmentProfile {
  // No POSIX shell on Windows, and nothing below would mean anything there. Openship
  // provisions Linux and macOS hosts; a Windows box can drive them but cannot be one.
  if (process.platform === "win32") {
    return unmeasurable(
      "Openship cannot provision this machine: it runs Windows, and Openship's host " +
        "provisioning is POSIX-only. Deploying to a remote Linux server from here works.",
    );
  }

  const result = spawnSync("sh", ["-c", ENVIRONMENT_PROBE_SCRIPT], {
    encoding: "utf8",
    timeout: ENVIRONMENT_PROBE_TIMEOUT_MS,
    // `sh -c` and not the login shell: `wrapLocalBuildCommand`'s `-lc` exists so user
    // builds see a normal profile, but a host probe wants the plain POSIX behaviour the
    // remote path gets, without a dotfile's `echo` in the middle of the output.
    windowsHide: true,
  });

  if (result.error) {
    return unmeasurable(
      `Openship could not run a shell on this machine to detect it: ` +
        `${safeErrorMessage(result.error)}`,
    );
  }

  // No exit status, no answer — the same rule the SSH path applies to ssh2's "closed
  // without an exit status" and to a bare `Exit code null`. A timeout arrives above as
  // `result.error` (ETIMEDOUT, on Node and Bun alike), but a kill from outside — the OOM
  // killer, a CPU rlimit — leaves a null status with a signal, and whatever is on the
  // streams then is our own half-written probe rather than the host: a SIGKILLed spawn
  // reported `opsh_begin=1` back as this machine's forced-command banner.
  if (result.signal || typeof result.status !== "number") {
    return unmeasurable(
      `Openship could not measure this machine: the detection probe was killed` +
        `${result.signal ? ` by ${result.signal}` : ""} before it finished.`,
    );
  }

  const stdout = result.stdout ?? "";
  return parseEnvironmentProbe({
    // The script always exits 0, so a non-zero status means something ran instead of it
    // — the same signal the SSH path uses, and stderr is what said so.
    text: stdout.trim() ? stdout : (result.stderr ?? ""),
    failed: result.status !== 0,
    // Every way of not answering is refused above, so the shell exited on its own and
    // whatever it said is this machine's.
    unanswered: false,
  });
}

/**
 * This machine's profile, measured once per staleness window.
 *
 * Memoized because the CLI asks for these facts from several unrelated places while
 * rendering one plan, and bounded by the same {@link profileIsFresh} window as the SSH
 * path so the two cannot disagree about how long an answer lasts. That matters most for
 * the long-lived process rather than the CLI: a memo with no lifetime meant the desktop
 * app measured this machine at launch and believed it until quit — through the operator
 * installing Docker, which is the one thing it tells them to go and do.
 *
 * {@link invalidateLocalEnvironment} is the immediate path for a change we made ourselves.
 */
export function resolveLocalEnvironmentSync(): EnvironmentProfile {
  if (cached && profileIsFresh(cached.measuredAt)) return cached.profile;
  const profile = probeLocalHost();
  cached = { measuredAt: Date.now(), profile };
  cacheEnvironment(createExecutor(), profile);
  return profile;
}

/** Forget this machine's profile — after installing Docker, or opening the firewall. */
export function invalidateLocalEnvironment(): void {
  cached = null;
  invalidateEnvironment(createExecutor());
}
