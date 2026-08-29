import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The row and the dial cannot disagree if they cannot spell the account separately.
 *
 * #527's visible symptom was a server row rendering `admin@<ip>` while the channel dialed
 * `root@host.docker.internal`. The cause was not the default — it was that five files each
 * carried their own `OPENSHIP_HOST_SSH_USER?.trim() || "root"`, so "the account" was five
 * facts that happened to agree until one of them didn't. Consolidating them fixes today;
 * this test is what stops the sixth copy, which would reopen the same class silently.
 *
 * Enforced over source text rather than behaviour because that is precisely the failure
 * mode: a re-introduced copy would return the right answer in every test while still being
 * a second source of truth. There is nothing to observe until it drifts.
 */
describe("hostChannelAccount is the only place that spells the channel-account fallback", () => {
  const REPO = join(__dirname, "../../..");

  /** Every file that legitimately needs the account, plus the resolver's own home. */
  const CONSUMERS = [
    "packages/adapters/src/system/executor.ts",
    "apps/api/src/lib/startup/self-server.ts",
    "apps/cli/src/lib/compose.ts",
  ];

  /**
   * The expression in any of its spellings: `|| "root"` / `?? "root"` applied to the env
   * var, with or without `.trim()`, single or double quoted.
   */
  const LOCAL_COPY = /OPENSHIP_HOST_SSH_USER[^\n;]*(\|\||\?\?)\s*["']root["']/;

  it.each(CONSUMERS)("%s reads the account through the resolver, not a local copy", (rel) => {
    const src = readFileSync(join(REPO, rel), "utf8");
    // Guards against a vacuous pass: if the file stops mentioning the account at all, this
    // list is stale and the test is no longer checking anything.
    expect(src, `${rel} no longer mentions the channel account — update CONSUMERS`).toContain(
      "hostChannelAccount",
    );
    expect(src).not.toMatch(LOCAL_COPY);
  });

  it("catches the pattern it claims to catch", () => {
    // The regex is the whole test; a typo in it would make every case above pass forever.
    expect('process.env.OPENSHIP_HOST_SSH_USER?.trim() || "root"').toMatch(LOCAL_COPY);
    expect("prev.OPENSHIP_HOST_SSH_USER?.trim() || 'root'").toMatch(LOCAL_COPY);
    expect('env.OPENSHIP_HOST_SSH_USER ?? "root"').toMatch(LOCAL_COPY);
    expect("hostChannelAccount(process.env)").not.toMatch(LOCAL_COPY);
  });
});
