import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CloudRuntime, isHostBuildForbiddenError } from "./cloud";
import { blankComments } from "../system/source-scan.fixtures";

/**
 * `CloudRuntime` has TWO arms that do work on the machine the API process runs on:
 *
 *   1. `buildStrategy: "local"` → runLocalBuild → `new LocalExecutor()` → a login
 *      shell running the project's own install/build commands.
 *   2. a Dockerfile build with `localPath` set → createDockerBuildContext, which
 *      mkdtemps, spawns `git` and `tar`, and reads the host filesystem. Gated on
 *      `localPath` and NEVER on buildStrategy, so it is not covered by anything that
 *      only inspects the strategy.
 *
 * On a multi-tenant control plane neither is acceptable, and the upstream gate
 * (`resolveStrategy`, which answers "server" under CLOUD_MODE) does not cover them:
 * a REUSED snapshot never asks it. A project promoted from a self-hosted install
 * carries a frozen `"local"`, so every subsequent redeploy or auto-update asked the
 * cloud runtime to build on the SaaS host — no attacker required.
 *
 * `grep -rn CLOUD_MODE packages/adapters/src/` is intentionally empty: adapters do
 * not read env. The permission is therefore INJECTED, and it defaults to DENY, so
 * forgetting to pass it fails closed. These tests pin that default, because it is the
 * opposite of every other optional knob on PlatformConfig and would otherwise look
 * like an oversight worth "tidying up".
 */

const client = {} as never;

/** Minimal BuildConfig — only the fields the refusal path reads. */
const cfg = (over: Record<string, unknown> = {}) =>
  ({
    sessionId: `s_${Math.abs(Number(String(over.seed ?? 1)))}`,
    projectId: "proj_1",
    deploymentId: "dep_1",
    stack: "node",
    ...over,
  }) as never;

describe("CloudRuntime refuses host work unless explicitly allowed", () => {
  it("defaults to DENY when no option is passed (fails closed)", async () => {
    const rt = new CloudRuntime(client);
    const result = await rt
      .build(cfg({ buildStrategy: "local" }))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(result, "a local build was permitted with no allowHostBuild set").toBeInstanceOf(Error);
    expect(isHostBuildForbiddenError(result)).toBe(true);
  });

  it("still refuses when allowHostBuild is explicitly false", async () => {
    const rt = new CloudRuntime(client, { allowHostBuild: false });
    const err = await rt
      .build(cfg({ buildStrategy: "local" }))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isHostBuildForbiddenError(err)).toBe(true);
  });

  it("names the remedy, not just the symptom", async () => {
    const rt = new CloudRuntime(client, { allowHostBuild: false });
    const err = await rt
      .build(cfg({ buildStrategy: "local" }))
      .then(() => null)
      .catch((e: unknown) => e);

    // An operator hitting this on a promoted project needs to know that redeploying
    // re-resolves the stored setting. Without that the message is a dead end.
    expect((err as Error).message).toMatch(/redeploy/i);
    expect((err as Error).message).toMatch(/build locally|build settings/i);
  });

  it("refuses BEFORE provisioning an Oblien workspace", async () => {
    // `client` is an empty object: any Oblien call would throw a TypeError instead of
    // HostBuildForbiddenError. Getting the typed error proves nothing was provisioned
    // first — the refusal is not paid for with a workspace that then has to be cleaned
    // up, and it does not depend on Oblien being reachable.
    const rt = new CloudRuntime(client, { allowHostBuild: false });
    const err = await rt
      .build(cfg({ buildStrategy: "local" }))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isHostBuildForbiddenError(err)).toBe(true);
    expect((err as Error).name).toBe("HostBuildForbiddenError");
  });

  it("does not refuse a server-strategy build (the gate is not a blanket block)", async () => {
    const rt = new CloudRuntime(client, { allowHostBuild: false });
    const err = await rt
      .build(cfg({ buildStrategy: "server" }))
      .then(() => null)
      .catch((e: unknown) => e);

    // It will fail — `client` is empty — but NOT with the host-build refusal. If this
    // ever becomes HostBuildForbiddenError the gate has started blocking the normal
    // cloud path, which is the failure mode a too-eager guard produces.
    expect(isHostBuildForbiddenError(err)).toBe(false);
  });

  /**
   * A RATCHET over the host-touching calls in cloud.ts.
   *
   * The reason this exists: the first pass at this gate covered two arms and MISSED a
   * third — `transferLocalDirectory(cfg.localPath, …)` in the build preflight, which
   * lives in the buildStrategy:"server" path (the one the gate deliberately allows)
   * and is keyed only on `localPath`. Reaching it in a unit test needs a provisioned
   * Oblien workspace, so the behavioural tests above cannot cover it.
   *
   * Counting is what catches the FOURTH one. If a new call to any of these appears,
   * this fails and whoever added it has to come here and say whether it needs the
   * gate — instead of the gate silently not covering it.
   */
  it("ratchet: every host-touching call in cloud.ts is accounted for", () => {
    // Not a `replace(/\/\*[\s\S]*?\*\//g, "")`: `cloud.ts:215` holds the regex literal
    // `/^[A-Za-z0-9_@%+=:,./*?[\]-]+$/`, whose `./*?` reads as a comment opener to that
    // pattern and blanked the next 61 lines — so a new host-touching call anywhere in
    // 215-317 would have been invisible to the very ratchet that exists to catch it.
    const src = blankComments(
      readFileSync(fileURLToPath(new URL("./cloud.ts", import.meta.url)), "utf8"),
    ).replace(/^\s*import\s[\s\S]*?;\s*$/gm, "");

    const count = (re: RegExp) => [...src.matchAll(re)].length;

    // Directly gated, one assert each.
    expect(count(/this\.assertHostWorkAllowed\s*\(/g)).toBe(3);

    // runLocalBuild: the "build here, upload the output" arm.
    expect(count(/\brunLocalBuild\s*\(/g)).toBe(1);
    // createDockerBuildContext: the local-source Dockerfile arm.
    expect(count(/\bcreateDockerBuildContext\s*\(/g)).toBe(1);
    // transferLocalDirectory: 3 inside the runLocalBuild output-upload callback
    // (already behind that arm's gate), 1 in the build preflight (gated directly),
    // and 1 in transferDockerfileContext — reachable only for a source whose `kind`
    // is "local", which only the gated Dockerfile arm can produce, so it is covered
    // transitively rather than directly.
    expect(count(/\btransferLocalDirectory\s*\(/g)).toBe(5);
  });

  it("is detected by name across bundle boundaries", () => {
    const impostor = new Error("nope");
    impostor.name = "HostBuildForbiddenError";
    // Two copies of this module can exist in one process (the API bundles adapters,
    // and so do the CLI and desktop builds), so instanceof alone is not enough.
    expect(isHostBuildForbiddenError(impostor)).toBe(true);
    expect(isHostBuildForbiddenError(new Error("unrelated"))).toBe(false);
  });
});
