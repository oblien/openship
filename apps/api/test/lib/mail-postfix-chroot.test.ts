import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../../../apps/email/docker/postfix-chroot-etc.sh");
const ENTRYPOINT = readFileSync(
  join(import.meta.dirname, "../../../../apps/email/docker/entrypoint.sh"),
  "utf8",
);

const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openship-postfix-chroot-"));
  temporaryRoots.push(root);
  const source = join(root, "source-etc");
  const target = join(root, "spool", "etc");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  return { source, target };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Postfix chroot DNS/NSS reconciliation (GH-686)", () => {
  it("populates an empty persistent spool from the runtime container files", () => {
    const { source, target } = fixture();
    writeFileSync(join(source, "resolv.conf"), "nameserver 127.0.0.11\n");
    writeFileSync(join(source, "hosts"), "127.0.0.1 localhost\n");
    writeFileSync(join(source, "nsswitch.conf"), "hosts: files dns\n");
    writeFileSync(join(source, "services"), "smtp 25/tcp\n");

    execFileSync("bash", [SCRIPT, source, target]);

    expect(readFileSync(join(target, "resolv.conf"), "utf8")).toBe("nameserver 127.0.0.11\n");
    expect(readFileSync(join(target, "hosts"), "utf8")).toBe("127.0.0.1 localhost\n");
    expect(readFileSync(join(target, "nsswitch.conf"), "utf8")).toBe("hosts: files dns\n");
    expect(readFileSync(join(target, "services"), "utf8")).toBe("smtp 25/tcp\n");
  });

  it("refreshes stale resolver data on every boot instead of seeding only once", () => {
    const { source, target } = fixture();
    writeFileSync(join(source, "resolv.conf"), "nameserver 127.0.0.11\n");
    writeFileSync(join(target, "resolv.conf"), "nameserver 192.0.2.1\n");

    execFileSync("bash", [SCRIPT, source, target]);
    expect(readFileSync(join(target, "resolv.conf"), "utf8")).toBe("nameserver 127.0.0.11\n");

    writeFileSync(join(source, "resolv.conf"), "nameserver 10.0.0.53\n");
    execFileSync("bash", [SCRIPT, source, target]);
    expect(readFileSync(join(target, "resolv.conf"), "utf8")).toBe("nameserver 10.0.0.53\n");
  });

  it("fails closed when no usable resolver can be installed", () => {
    const { source, target } = fixture();

    const result = spawnSync("bash", [SCRIPT, source, target], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolv.conf is missing or empty");
  });

  it("runs the reconciliation before the mail supervisor starts", () => {
    const reconcile = ENTRYPOINT.indexOf("postfix-chroot-etc.sh");
    const supervisor = ENTRYPOINT.indexOf('exec "$@"');

    expect(reconcile).toBeGreaterThan(-1);
    expect(supervisor).toBeGreaterThan(reconcile);
  });
});
