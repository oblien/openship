import { describe, expect, it } from "vitest";

import { sharedMountExecutor, type Platform } from "./platform";
import { createExecutor } from "./system/executor";
import { EDGE_CONTAINER_MOUNTS, EDGE_SAME_PATH_MOUNTS } from "./infra/openresty-lua";
import { STATIC_RELEASE_BASE } from "./runtime/bare";

/**
 * `/opt/openship/static` and `/etc/letsencrypt` are 1:1 host bind mounts in the api
 * container (see EDGE_CONTAINER_MOUNTS), so on the local box the api process, the edge
 * and the host all read the same files at the same path. Routing them over the
 * container→host SSH channel made static deploys, static rollback and cert adoption the
 * things a firewall-blocked or switched-off channel broke for no reason (#490).
 *
 * A remote target has no such mount, and there getting this wrong is worse: a LOCAL
 * read would answer about the orchestrator's own files.
 */
const fake = (localHost: boolean, executor: unknown): Platform =>
  ({ localHost, executor }) as unknown as Platform;

describe("sharedMountExecutor", () => {
  it("reads the shared tree locally on the local box, bypassing the host channel", async () => {
    const hostChannel = { tag: "ssh-to-host.docker.internal" };
    const resolved = await sharedMountExecutor(fake(true, hostChannel));
    expect(resolved).not.toBe(hostChannel);
    // The one shared LocalExecutor — identity matters, because per-executor
    // memoization elsewhere is keyed on "which box is this".
    expect(resolved).toBe(createExecutor());
  });

  it("uses the server's own executor for a remote target", async () => {
    const remote = { tag: "ssh-to-remote" };
    expect(await sharedMountExecutor(fake(false, remote))).toBe(remote);
  });

  it("passes a remote target's missing executor through as null, never as local", async () => {
    // Silently substituting a local executor here would promote a release onto the
    // orchestrator and report success about a machine that got nothing.
    expect(await sharedMountExecutor(fake(false, null))).toBeNull();
  });

  it("takes a resolved {localHost,executor} pair, not only a whole Platform", async () => {
    // resolveServerExecutor hands back `{ executor, isLocal }`; the rollback planner and
    // cert reuse call this with that pair, so the rule has one implementation.
    const remote = { tag: "ssh-to-remote" };
    expect(await sharedMountExecutor({ localHost: false, executor: remote as never })).toBe(remote);
    expect(await sharedMountExecutor({ localHost: true, executor: null })).toBe(createExecutor());
  });
});

/**
 * The premise, pinned. This helper is only sound for a mount that is the SAME path on
 * both sides: `apps/api/test/lib/compose-edge-mounts.test.ts` pins that the compose file
 * really mounts these, and this pins which of them a caller may hand it.
 */
describe("which paths this is allowed for", () => {
  // The shipped constant, not a local re-filter of the table: `NginxProvider._chmod`
  // gates on this same list, so a re-derivation here would let the two rules disagree
  // about which paths qualify while both looked tested.
  const samePath = EDGE_SAME_PATH_MOUNTS;

  it("covers the static release tree and certbot's store", () => {
    expect(samePath).toContain(STATIC_RELEASE_BASE);
    expect(samePath).toContain("/etc/letsencrypt");
  });

  it("holds every same-path mount in the table, so a new one can't be forgotten", () => {
    expect([...samePath].sort()).toEqual(
      EDGE_CONTAINER_MOUNTS.filter((m) => m.host === m.container)
        .map((m) => m.host)
        .sort(),
    );
  });

  it("does NOT cover sites-enabled — a local read there would look elsewhere", () => {
    const sites = EDGE_CONTAINER_MOUNTS.find((m) => m.host.endsWith("/sites-enabled"));
    expect(sites).toBeDefined();
    expect(sites!.host).not.toBe(sites!.container);
    expect(samePath).not.toContain(sites!.host);
  });
});
