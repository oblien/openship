import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The backup helper streams a volume's archive over `attach()`. With the
 * daemon's default json-file driver, Docker ALSO writes every byte to
 * /var/lib/docker/containers — a second copy of the whole backup, inflated
 * further because json-file escapes binary. Observed on a live box: a 4.6 GB
 * volume produced a 12 GB log, so a backup spiked host disk by far more than
 * it read and only released it when the helper exited.
 *
 * Asserted against the source because the alternative is a full dockerode
 * double, which would pin far more of the executor's shape than this one
 * property is worth.
 */
const executorSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/backup/executors/docker.ts"),
  "utf8",
);

describe("backup helper container", () => {
  it("disables container logging for the archive stream", () => {
    expect(executorSource).toMatch(/LogConfig:\s*\{\s*Type:\s*"none"/);
  });

  it("keeps the log config on the same HostConfig that binds the source", () => {
    const hostConfig = executorSource.slice(
      executorSource.indexOf("const hostConfig"),
      executorSource.indexOf("const helper ="),
    );
    expect(hostConfig).toContain(":/mnt:ro");
    expect(hostConfig).toContain("AutoRemove: true");
    expect(hostConfig).toMatch(/LogConfig/);
  });
});
