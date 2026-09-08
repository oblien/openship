import { describe, expect, it } from "vitest";

import { dockerHardening, parseComposeHardening } from "./compose-hardening";

/**
 * The five hardening controls at the parse boundary and at the Docker payload
 * (#749).
 *
 * Every case here is one that can fail: a control that would reach the container
 * weaker than the file asked for, a value that would be refused by the daemon only
 * AFTER the serving container was removed, or a difference between what the two
 * import doors store for the same file. Shape assertions the type system already
 * guarantees are deliberately absent.
 */

describe("parseComposeHardening", () => {
  it("carries each of the five off a file that asks for it", () => {
    const { hardening, issues } = parseComposeHardening({
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      tmpfs: ["/run:size=64m,mode=1777"],
      user: "1000:1000",
    });
    expect(issues).toEqual([]);
    expect(hardening).toEqual({
      readOnly: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      tmpfs: ["/run:size=64m,mode=1777"],
      user: "1000:1000",
    });
  });

  it("says nothing about a service that declares none of them", () => {
    const { hardening, issues } = parseComposeHardening({ image: "nginx" });
    expect(hardening).toEqual({});
    expect(issues).toEqual([]);
  });

  /**
   * The one that keeps the two import doors honest. `docker compose config` DROPS
   * `read_only: false` and `cap_drop: []` from its output, so the CLI door never
   * sees them; storing them here would make the raw-YAML door produce a different
   * `advanced` for the same file, and the drift UI would then show a change on
   * every sync. Clearing a control that WAS set happens through the key going
   * absent (COMPOSE_OWNED_ADVANCED_KEYS), not through storing a false.
   */
  it("stores nothing for the false/empty forms, matching `docker compose config`", () => {
    const { hardening, issues } = parseComposeHardening({
      read_only: false,
      cap_drop: [],
      security_opt: [],
      tmpfs: [],
      user: "",
    });
    expect(hardening).toEqual({});
    expect(issues).toEqual([]);
  });

  /**
   * `read_only: "true"` is a STRING in YAML. Treating it as falsy would leave the
   * root filesystem writable on a file that asked for the opposite, which is the
   * exact silent downgrade this feature exists to end.
   */
  it("refuses a non-boolean read_only instead of reading it as false", () => {
    const { hardening, issues } = parseComposeHardening({ read_only: "true" });
    expect(hardening.readOnly).toBeUndefined();
    expect(issues).toEqual([
      { field: "read_only", reason: 'read_only must be true or false, got "true".' },
    ]);
  });

  /**
   * Capability spelling is the operator's. Measured against Engine 29.2.1:
   * `net_raw`, `NET_RAW` and `CAP_NET_RAW` all clear the same bit, and the Engine
   * API stores whichever was sent verbatim (only the `docker` CLI rewrites them).
   * Normalizing would make the inspect readback disagree with the file for no gain.
   */
  it("keeps cap_drop spelling and order, and folds a repeat of the same capability", () => {
    const { hardening, issues } = parseComposeHardening({
      cap_drop: ["ALL", "net_raw", "CAP_NET_RAW", "NET_RAW", "CHOWN"],
    });
    expect(issues).toEqual([]);
    expect(hardening.capDrop).toEqual(["ALL", "net_raw", "CHOWN"]);
  });

  it("refuses a cap_drop entry that is not a capability name", () => {
    const { hardening, issues } = parseComposeHardening({ cap_drop: ["NET RAW"] });
    expect(hardening.capDrop).toBeUndefined();
    expect(issues[0]?.field).toBe("cap_drop");
    expect(issues[0]?.reason).toContain("NET RAW");
  });

  it("passes security_opt through as authored, including profile case", () => {
    const { hardening, issues } = parseComposeHardening({
      security_opt: ["no-new-privileges:true", "apparmor:MyProfile", "label:user:USER"],
    });
    expect(issues).toEqual([]);
    expect(hardening.securityOpt).toEqual([
      "no-new-privileges:true",
      "apparmor:MyProfile",
      "label:user:USER",
    ]);
  });

  /**
   * A value Docker would refuse has to be caught at import. At deploy it is found
   * only by `createContainer` failing, and by then the previously-serving
   * container has already been removed.
   */
  it("refuses a security_opt that is neither key:value nor bare no-new-privileges", () => {
    const { hardening, issues } = parseComposeHardening({
      security_opt: ["no-new-privileges", "nonsense"],
    });
    expect(hardening.securityOpt).toEqual(["no-new-privileges"]);
    expect(issues[0]?.field).toBe("security_opt");
    expect(issues[0]?.reason).toContain("nonsense");
  });

  /** `docker compose config` normalizes a scalar into a list; the raw door must too. */
  it("reads a scalar tmpfs the same way the CLI door's list arrives", () => {
    expect(parseComposeHardening({ tmpfs: "/run" }).hardening.tmpfs).toEqual(["/run"]);
    expect(parseComposeHardening({ tmpfs: ["/run"] }).hardening.tmpfs).toEqual(["/run"]);
  });

  it("refuses a relative tmpfs target", () => {
    const { hardening, issues } = parseComposeHardening({ tmpfs: ["run"] });
    expect(hardening.tmpfs).toBeUndefined();
    expect(issues[0]?.field).toBe("tmpfs");
  });

  /**
   * `HostConfig.Tmpfs` is a map keyed by path, so a second spec for the same
   * target would silently overwrite the first, taking its size cap or `noexec`
   * with it. Refuse rather than pick a winner.
   */
  it("refuses two tmpfs entries on one target rather than letting one overwrite the other", () => {
    const { hardening, issues } = parseComposeHardening({
      tmpfs: ["/run:size=1m", "/run:size=64m"],
    });
    expect(hardening.tmpfs).toEqual(["/run:size=1m"]);
    expect(issues[0]?.field).toBe("tmpfs");
    expect(issues[0]?.reason).toContain("/run is mounted twice");
  });

  /** `docker compose config` refuses a numeric `user`, but an uploaded YAML can carry one. */
  it("accepts a numeric user from a raw file", () => {
    expect(parseComposeHardening({ user: 1000 }).hardening.user).toBe("1000");
  });

  it("refuses a user spec Docker could not resolve", () => {
    const { hardening, issues } = parseComposeHardening({ user: "root:wheel:extra" });
    expect(hardening.user).toBeUndefined();
    expect(issues[0]?.field).toBe("user");
  });

  it("expands interpolations before validating, so a ${VAR} user is not refused as malformed", () => {
    const { hardening, issues } = parseComposeHardening(
      { user: "${APP_UID}", tmpfs: ["${SCRATCH}:size=8m"], cap_drop: ["${DROP}"] },
      (value) =>
        value
          .replace("${APP_UID}", "1000:1000")
          .replace("${SCRATCH}", "/scratch")
          .replace("${DROP}", "ALL"),
    );
    expect(issues).toEqual([]);
    expect(hardening.user).toBe("1000:1000");
    expect(hardening.tmpfs).toEqual(["/scratch:size=8m"]);
    expect(hardening.capDrop).toEqual(["ALL"]);
  });
});

describe("dockerHardening", () => {
  /**
   * The mapping the Engine actually takes, verified against Engine 29.2.1 with a
   * real container: uid 1000, empty effective capability set, `NoNewPrivs: 1`, a
   * root that refused a write, and a writable size-capped /run.
   */
  it("maps all five onto the Engine's own field names", () => {
    const { config, hostConfig } = dockerHardening({
      user: "1000:1000",
      readOnly: true,
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      tmpfs: ["/run:size=64m,mode=1777", "/tmp"],
    });
    expect(config).toEqual({ User: "1000:1000" });
    expect(hostConfig).toEqual({
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/run": "size=64m,mode=1777", "/tmp": "" },
    });
  });

  /**
   * An unrequested control must leave NO key behind: the runtime spreads these
   * into the create payload, and a key present with an undefined value is still a
   * key the Engine reads. Same contract `toStopConfig` follows.
   */
  it("emits no keys at all for a service that asked for nothing", () => {
    expect(dockerHardening(undefined)).toEqual({ config: {}, hostConfig: {} });
    expect(dockerHardening({})).toEqual({ config: {}, hostConfig: {} });
  });

  it("does not alias the stored arrays into the create payload", () => {
    const stored = { capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"] };
    const { hostConfig } = dockerHardening(stored);
    hostConfig.CapDrop?.push("CHOWN");
    expect(stored.capDrop).toEqual(["ALL"]);
  });
});
