/**
 * The host detector, run inside real distro images.
 *
 * This is the one layer where the origin bug actually lived. `parseDistro` had no `amzn`
 * arm and read `ID_LIKE` nowhere, so an Amazon Linux host resolved to `distro: "unknown"`,
 * every distro-gated provisioning step silently skipped, `curl get.docker.com | sh` ran
 * and hard-refused the ID, and the operator's only symptom was `socket hang up` from a
 * daemon that was never installed. Hand-written `/etc/os-release` fixtures cover the
 * parser, and `environment-ops.test.ts` covers the command tables — but a fixture is a
 * transcript of what someone believed a distro says, and that belief is precisely what
 * was wrong. Only a real image can contradict it.
 *
 * **This is a detection test, and must stay one.** None of these images run an init as
 * PID 1, so `serviceManager` is honestly `none` and provisioning cannot be exercised
 * here — a test that installed Docker in `amazonlinux:2023` would be measuring the
 * container's init, not the distro's. That boundary is asserted rather than promised:
 * every case checks that `dockerStart()` REFUSES, naming the missing init. `requireDocker()`
 * fails rather than skips, so a green here is a claim, and a misleading claim about
 * provisioning would be worse than no test at all.
 *
 * The images are driven through the `docker` CLI with argv rather than through
 * `DockerRuntime`: the probe is a multi-line POSIX script, `execFile` argv passes it with
 * no shell in between and therefore no quoting to get wrong, and `DockerRuntime`'s
 * in-container exec is private. What runs is the product's real
 * `ENVIRONMENT_PROBE_SCRIPT`, through the product's real `resolveEnvironment()` — script,
 * parser and support verdict end to end.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { beforeAll, expect, it } from "vitest";

import {
  type CommandExecutor,
  type EnvironmentProfile,
  envOps,
  resolveEnvironment,
} from "@repo/adapters";

import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const run = promisify(execFile);

/** Generous: a cold `docker run` on a just-pulled image, plus the probe itself. */
const RUN_TIMEOUT_MS = 120_000;

type Case = {
  readonly image: string;
  readonly distroId: string;
  readonly distroFamily: EnvironmentProfile["distroFamily"];
  readonly packageManager: EnvironmentProfile["packageManager"];
  readonly libc: EnvironmentProfile["libc"];
  /** `versionId` starts with this — Rocky ships `9.3`, Alpine `3.20.10`. */
  readonly versionPrefix: string;
  /** Exact `pkgInstall(["git"])`, so the verb is provably family-derived. */
  readonly installGit: readonly string[];
  /**
   * The ENGINE steps of `dockerInstall()`, exact and leading. The AL arms are the origin
   * bug, pinned. The compose tail — where there is one — is asserted separately because
   * its asset name is arch-derived and this suite runs on arm64 and amd64 alike.
   */
  readonly dockerEngine: readonly string[];
  /**
   * Where `docker compose` comes from on this host. Every deploy path in the product runs
   * `docker compose`, so an arm that installs an engine without one provisions green and
   * fails its first deploy — which makes this the property worth pinning per distro, not
   * the step list.
   */
  readonly composeFrom: "engine" | "plugin";
};

const CASES: readonly Case[] = [
  {
    // `ID_LIKE=fedora` is the whole reason this host is drivable at all: `ID=amzn` is in
    // no table anyone would write from memory.
    image: "amazonlinux:2023",
    distroId: "amzn",
    distroFamily: "rhel",
    packageManager: "dnf",
    libc: "glibc",
    versionPrefix: "2023",
    installGit: ["dnf install -y git"],
    // AL's own repos carry no `docker-compose-plugin` under any name.
    dockerEngine: ["dnf install -y docker"],
    composeFrom: "plugin",
  },
  {
    // Same `ID`, different package manager, different Docker install. AL2 is told apart
    // from AL2023 by `dnf` vs `yum` rather than by parsing VERSION_ID — this case is what
    // makes that claim testable, since a VERSION_ID parser would pass the case above too.
    image: "amazonlinux:2",
    distroId: "amzn",
    distroFamily: "rhel",
    packageManager: "yum",
    libc: "glibc",
    versionPrefix: "2",
    installGit: ["yum install -y git"],
    // Braced, and tolerating a non-zero exit when the binary is there: AL2's
    // `amazon-linux-extras` exits 13 AFTER yum has installed dockerd, and
    // `opScript` joins with `&&`, so a bare command aborted the compose-plugin
    // steps that follow and provisioned an engine with no `docker compose`.
    // Pinned as one step on purpose — the braces are what keep it one.
    dockerEngine: ["{ amazon-linux-extras install -y docker || command -v docker >/dev/null 2>&1; }"],
    composeFrom: "plugin",
  },
  {
    // A rebuild whose `ID` get.docker.com does accept, so the RHEL family is not one arm.
    image: "rockylinux:9",
    distroId: "rocky",
    distroFamily: "rhel",
    packageManager: "dnf",
    libc: "glibc",
    versionPrefix: "9",
    installGit: ["dnf install -y git"],
    // The script pulls `docker-compose-plugin` on its own rpm path.
    dockerEngine: ["curl -fsSL https://get.docker.com | sh"],
    composeFrom: "engine",
  },
  {
    // musl, apk, and unquoted os-release values (`ID=alpine`, not `ID="alpine"`) — the
    // shape a parser written against Debian's file gets wrong.
    image: "alpine:3.20",
    distroId: "alpine",
    distroFamily: "alpine",
    packageManager: "apk",
    libc: "musl",
    versionPrefix: "3.20",
    installGit: ["apk add --no-cache git"],
    dockerEngine: ["apk add --no-cache docker docker-cli docker-cli-compose"],
    composeFrom: "engine",
  },
];

/**
 * A host that happens to be a container.
 *
 * `resolveEnvironment` calls `exec` and nothing else, so the rest of `CommandExecutor`
 * is genuinely unreachable here; the cast is narrower than it looks and a real
 * implementation would only add untested surface.
 */
function imageExecutor(image: string): CommandExecutor {
  return {
    exec: async (command: string, opts?: { timeout?: number }) => {
      const { stdout } = await run(
        "docker",
        ["run", "--rm", "--entrypoint", "sh", image, "-c", command],
        { timeout: opts?.timeout ?? RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout;
    },
  } as unknown as CommandExecutor;
}

describeDockerE2E("the detector, inside real distro images", () => {
  beforeAll(async () => {
    await requireDocker();
    // The socket is what `requireDocker` proves; these cases also need the CLI on PATH.
    await run("docker", ["version", "--format", "{{.Server.Version}}"]).catch((err: unknown) => {
      throw new Error(
        `The docker CLI is required for this suite (the daemon socket alone is not enough): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    // Pull up front so the first case's timeout isn't a multi-hundred-megabyte download —
    // but only when the image is absent. What these cases need is the image, not the
    // registry, and a `docker pull` on every run turns a 20-second Docker Hub TLS blip
    // into a red suite on a box that already has all four locally.
    for (const { image } of CASES) {
      const present = await run("docker", ["image", "inspect", image]).then(
        () => true,
        () => false,
      );
      if (present) continue;
      await run("docker", ["pull", "-q", image], { timeout: 300_000 }).catch((err: unknown) => {
        throw new Error(
          `${image} is not present locally and could not be pulled: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }, 900_000);

  for (const c of CASES) {
    it(`resolves ${c.image}`, async () => {
      const profile = await resolveEnvironment(imageExecutor(c.image));

      expect(profile.os).toBe("linux");
      expect(profile.distroId).toBe(c.distroId);
      expect(profile.distroFamily).toBe(c.distroFamily);
      expect(profile.packageManager).toBe(c.packageManager);
      expect(profile.libc).toBe(c.libc);
      expect(profile.versionId ?? "").toMatch(new RegExp(`^${c.versionPrefix}(\\.|$)`));
      expect(profile.prettyName).toBeTruthy();

      // The verdict, which is the field every call site branches on.
      expect(profile.supported).toBe(true);
      expect(profile.unsupportedReason).toBeNull();

      // Not a literal: this suite runs on both arm64 laptops and amd64 CI. The invariant
      // is that the architecture was READ — `unknown` is the value that used to become a
      // silent amd64 default and now refuses.
      expect(profile.arch).not.toBe("unknown");
      expect(envOps(profile).releaseArch()).toEqual({ supported: true, value: profile.arch });

      // `docker run` gives us a container and no init, and the detector says both.
      expect(profile.isContainer).toBe(true);
      expect(profile.serviceManager).toBe("none");
    });

    it(`derives ${c.image}'s commands from what was detected`, async () => {
      const profile = await resolveEnvironment(imageExecutor(c.image));
      const ops = envOps(profile);

      expect(ops.pkgInstall(["git"])).toEqual({ supported: true, value: c.installGit });

      const install = ops.dockerInstall();
      expect(install.supported).toBe(true);
      const steps = install.supported ? install.value : [];
      expect(steps.slice(0, c.dockerEngine.length)).toEqual(c.dockerEngine);

      if (c.distroId === "amzn") {
        // The specific thing that broke: get.docker.com reads `ID` verbatim and exits 1
        // on `amzn`, so running it here is the bug rather than a suboptimal choice.
        expect(steps.join(" ")).not.toContain("get.docker.com");
      }

      // Compose arrives one way or the other, and which way is a per-distro fact.
      if (c.composeFrom === "engine") {
        expect(steps).toEqual(c.dockerEngine);
        expect(steps.join(" ")).toMatch(/compose|get\.docker\.com/);
      } else {
        const tail = steps.slice(c.dockerEngine.length).join(" ");
        expect(tail).toContain("/usr/local/lib/docker/cli-plugins/docker-compose");
        // Derived from the arch that was DETECTED, not a literal: a plugin built for the
        // other architecture is the failure this arm exists to avoid, and hardcoding
        // either asset name would make the suite red on half the machines that run it.
        expect(tail).toContain(profile.arch === "arm64" ? "aarch64" : "x86_64");
      }

      // The boundary this file must not cross, asserted. Starting a service needs an init
      // these images don't have, and the answer is a reason — not an empty step list that
      // a caller reads as "nothing to do", which is how the original bug reached a host.
      const start = ops.dockerStart();
      expect(start.supported).toBe(false);
      expect(start.supported === false && start.reason).toContain("no service manager");
    });
  }

  /**
   * A real `/etc/os-release` with no trailing newline, read by a real `sh`.
   *
   * The forwarding step used to be `sed 's/^/opsh_osr:/'`, which reproduces its input byte
   * for byte — so on a file whose last line is unterminated, the next `echo` landed on that
   * line and `opsh_pm=apt` became part of it. The keys were all present, the brackets were
   * intact, nothing failed, and the box was refused for having no package manager. Only a
   * real shell can show that the awk form fixed it; a fixture renders the wire format we
   * *intended* either way.
   */
  it("parses an os-release whose last line has no newline", async () => {
    const image = CASES[0].image;
    const truncating: CommandExecutor = {
      exec: async (command: string, opts?: { timeout?: number }) => {
        const { stdout } = await run(
          "docker",
          [
            "run",
            "--rm",
            "--entrypoint",
            "sh",
            image,
            "-c",
            // `printf %s` of the file's own bytes, minus the final newline.
            `printf %s "$(cat /etc/os-release)" > /tmp/osr && cp /tmp/osr /etc/os-release && ${command}`,
          ],
          { timeout: opts?.timeout ?? RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        );
        return stdout;
      },
    } as unknown as CommandExecutor;

    const profile = await resolveEnvironment(truncating);

    expect(profile.distroId).toBe(CASES[0].distroId);
    expect(profile.packageManager).toBe(CASES[0].packageManager);
    expect(profile.supported).toBe(true);
  });
});
