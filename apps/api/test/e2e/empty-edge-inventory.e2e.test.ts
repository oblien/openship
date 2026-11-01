import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const name = `openship-e2e-empty-edge-${randomUUID().slice(0, 8)}`;
const image = `${name}:local`;
const volume = `${name}-data`;
const builder = `${name}-build`;
const fixture = resolve(import.meta.dirname, "../fixtures/empty-edge");
let directory = "";
function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}

describeDockerE2E("strict edge inventory on a fresh Linux Docker host", () => {
  beforeAll(async () => {
    await requireDocker();
    directory = mkdtempSync(join(tmpdir(), `${name}-`));
    execFileSync("bun", ["build", join(fixture, "proof.ts"), "--target=node", `--outfile=${directory}/proof.mjs`], { timeout: 60_000 });
    docker("buildx", "create", "--name", builder, "--driver", "docker-container");
    docker("buildx", "build", "--builder", builder, "--load", "--tag", image, fixture);
    docker("volume", "create", volume);
    // Dedicated Docker daemon, network namespace and storage: no host socket or
    // public port is mounted/published. The host's own ingress is never changed.
    docker("run", "-d", "--privileged", "--cgroupns=private", "--network=none", "--memory=2g", "--cpus=1", "--name", name,
      "--mount", `type=volume,source=${volume},target=/var/lib/docker`, "-e", "DOCKER_TLS_CERTDIR=", image,
      "dockerd", "--host=unix:///var/run/docker.sock");
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { docker("exec", name, "docker", "info"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    expect(ready, "isolated Docker daemon did not start").toBe(true);
    docker("cp", `${directory}/proof.mjs`, `${name}:/proof.mjs`);
  }, 240_000);
  afterAll(() => {
    const failures: string[] = [];
    for (const args of [["rm", "-f", name], ["volume", "rm", volume], ["buildx", "rm", builder], ["image", "rm", image]]) {
      try { docker(...args); }
      catch (error) {
        const message = String(error);
        if (!/No such|not found|no builder/i.test(message)) failures.push(message);
      }
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    expect(failures, "owned test resources must be removed").toEqual([]);
  }, 120_000);
  it("permits an empty host and rejects live, dormant and unreadable ingress", () => {
    const output = docker("exec", name, "node", "/proof.mjs");
    expect(JSON.parse(output).passed).toHaveLength(8);
  }, 120_000);
});
