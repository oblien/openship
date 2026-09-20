import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAIL_CONTAINER_MOUNTS } from "@repo/adapters";

/**
 * Three shipped artifacts have to agree about the mail engine's seeded mounts, and no
 * compiler checks any of it: the mount table (TypeScript), the entrypoint that copies
 * baked defaults onto those mounts, and the Dockerfile that bakes what it copies FROM.
 *
 * Issue #565 was one broken leg of exactly that. `/var/lib/clamav` was bind-mounted
 * without `seed: true`, the entrypoint never seeded it, and the Dockerfile baked nothing
 * to seed it from — so the signature database the installer wrote sat in the image layer
 * where the mount hid it, clamd exited 1, and supervisord's default three retries were
 * spent in ~6s and marked it FATAL for the life of the container. Amavis has no backup
 * scanner, so that defers all inbound mail.
 *
 * Building the image to catch this is not an option here: the iRedMail installer plus a
 * signature fetch is minutes to tens of minutes (see test/e2e/mail-db-bootstrap.e2e.test.ts).
 */

const EMAIL_DIR = join(import.meta.dirname, "../../../../apps/email");
const read = (p: string) => readFileSync(join(EMAIL_DIR, p), "utf8");

const ENTRYPOINT = read("docker/entrypoint.sh");
const SUPERVISORD = read("docker/supervisord.conf");
const DOCKERFILE = read("Dockerfile");
const BUILD_CONFIG = read("docker/build-config");

/**
 * The `seed <baked-subdir> <container-path>` calls the entrypoint actually makes. The
 * optional `|| …` tail matters: the ClamAV seed is deliberately non-fatal, and a regex
 * that stopped at end-of-line would silently stop seeing it.
 */
const seedCalls = [
  ...ENTRYPOINT.matchAll(/^seed[ \t]+(\S+)[ \t]+(\S+)[ \t]*(?:\\|\|\|.*)?$/gm),
].map(([, dir, path]) => ({ dir, path }));

/** One `[program:x]` block, up to the next section. */
function programBlock(name: string): string {
  const block = SUPERVISORD.split(/^\[/m).find((b) => b.startsWith(`program:${name}]`));
  if (!block) throw new Error(`no [program:${name}] in supervisord.conf`);
  return block;
}

function numericSetting(program: string, key: string): number {
  const found = new RegExp(`^${key}=(\\d+)$`, "m").exec(programBlock(program));
  if (!found) throw new Error(`[program:${program}] has no ${key}`);
  return Number(found[1]);
}

describe("openship-mail seed wiring", () => {
  it("seeds every mount marked seed:true, and marks every mount it seeds", () => {
    const declared = MAIL_CONTAINER_MOUNTS.filter((m) => m.seed)
      .map((m) => m.container)
      .sort();
    expect(seedCalls.map((c) => c.path).sort()).toEqual(declared);
  });

  it("bakes a seed dir in the image for every seed call", () => {
    // A seed call reading from a directory no build step creates is a silent no-op:
    // seed() skips when the source is absent.
    for (const { dir } of seedCalls) {
      expect(DOCKERFILE).toContain(`/opt/openship-mail/seed/${dir}`);
    }
  });

  it("seeds the ClamAV signature database and gates the build on it being there", () => {
    expect(seedCalls.some((c) => c.path === "/var/lib/clamav")).toBe(true);
    expect(DOCKERFILE).toContain("freshclam --datadir=/opt/openship-mail/seed/clamav");
    // The gate is what turns "shipped with no loadable database" into a build failure.
    expect(DOCKERFILE).toMatch(/FATAL: no ClamAV signature database/);
    // And the installer must not fetch a second copy into the mounted path.
    expect(BUILD_CONFIG).toMatch(/^export FRESHCLAM_UPDATE_IMMEDIATELY='NO'$/m);
  });

  it("hands the signature mount and clamd's socket dir to the clamav user", () => {
    // The mount arrives root-owned from ensure-container-mail and both daemons drop
    // privileges; /var/run/clamav holds clamd's socket and freshclam's pid file, and
    // nothing in a container creates it.
    expect(ENTRYPOINT).toContain("chown -R clamav:clamav /var/lib/clamav");
    expect(ENTRYPOINT).toContain("/var/run/clamav");
  });

  it("keeps the ClamAV seed non-fatal", () => {
    // Copying hundreds of MB onto a bind mount can fail on a full or read-only disk.
    // The entrypoint runs under `set -e`, so an unguarded seed would take Postfix and
    // Dovecot down over a virus scanner.
    const clamavSeed = /^seed clamav \/var\/lib\/clamav.*$/m.exec(ENTRYPOINT)?.[0] ?? "";
    expect(clamavSeed).toMatch(/\\$|\|\|/);
  });
});

describe("clamd's start is not terminal", () => {
  it("gives clamd and freshclam far more than supervisord's default 3 retries", () => {
    // 3 retries is ~6 seconds, which is how a clamd that started before its signatures
    // ended up FATAL — a state supervisord never retries.
    expect(numericSetting("clamav-daemon", "startretries")).toBeGreaterThan(3);
    // A freshclam that FATALs on a boot with no network yet never fetches the
    // signatures clamd is waiting for.
    expect(numericSetting("clamav-freshclam", "startretries")).toBeGreaterThan(3);
  });

  it("starts freshclam before clamd", () => {
    expect(numericSetting("clamav-freshclam", "priority")).toBeLessThan(
      numericSetting("clamav-daemon", "priority"),
    );
  });

  it("still launches clamd under the name the API probes", () => {
    expect(programBlock("clamav-daemon")).toContain("command=/usr/sbin/clamd");
  });
});
