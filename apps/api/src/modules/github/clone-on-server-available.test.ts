import { describe, expect, it } from "vitest";
import { cloneOnServerAvailable } from "./clone-auth";

/**
 * ONE definition of "can the build host clone this itself".
 *
 * It was an unnamed inline boolean in `build-pipeline`, which meant the only way to find out
 * whether "On the server" would actually work was to start a deploy and read the log for
 * "Clone-on-server was requested, but nothing can authenticate the clone on the build host".
 * Named and exported so a capability check the picker calls and the decision the deploy makes
 * cannot disagree.
 */
const cred = (over: Record<string, unknown> = {}) => over as never;

describe("credentials that make clone-on-server work", () => {
  it("the server's own ambient git access", () => {
    expect(cloneOnServerAvailable(cred({ ambient: { via: "ssh-agent" } })).available).toBe(true);
  });

  it("a shippable ssh key", () => {
    expect(cloneOnServerAvailable(cred({ ssh: { keyKind: "deploy-key" } })).available).toBe(true);
  });

  it("the desktop relay", () => {
    expect(cloneOnServerAvailable(cred({ relay: true })).available).toBe(true);
  });

  it("a public repo, which needs no credential", () => {
    expect(cloneOnServerAvailable(cred({ anonymous: true })).available).toBe(true);
  });

  it("a token usable off-host", () => {
    expect(cloneOnServerAvailable(cred({ token: "ghp_x" })).available).toBe(true);
  });
});

describe("credentials that do NOT", () => {
  it("refuses a token flagged apiHostFallback — it is LOCAL-only", () => {
    // The subtle one, and the security-relevant one: treating token-presence alone as
    // "shippable" would send a credential somewhere it can't authenticate, leaking it off-host
    // on the way.
    const r = cloneOnServerAvailable(cred({ token: "ghp_local", apiHostFallback: true }));
    expect(r.available).toBe(false);
  });

  it("refuses an empty credential, and says why", () => {
    const r = cloneOnServerAvailable(cred({}));
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.reason).toContain("no GitHub identity of its own");
      expect(r.reason).toContain("no git identity could be forwarded");
    }
  });

  it("treats relay/anonymous false as absent, not as permission", () => {
    expect(cloneOnServerAvailable(cred({ relay: false, anonymous: false })).available).toBe(false);
  });
});
