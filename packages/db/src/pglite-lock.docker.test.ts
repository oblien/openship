import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const docker = (...args: string[]) => execute("docker", args, { timeout: 30_000 });

// Required by the Database CI job; opt in locally to use a real Docker daemon.
it.skipIf(process.env.RUN_DOCKER_E2E !== "1")(
  "excludes live PID-1 containers and recovers after repeated SIGKILL restarts",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-lock-docker-"));
    const name = `openship-lock-${randomUUID()}`;
    const data = `${name}-data`;
    const code = `${name}-code`;
    const image = "node:24-bookworm-slim";
    const mounts = ["--mount", `type=volume,src=${data},dst=/shared`,
      "--mount", `type=volume,src=${code},dst=/fixture`];
    try {
      await execute("bun", ["build", resolve(import.meta.dirname, "./pglite-lock.ts"),
        "--target=node", `--outfile=${join(directory, "lock.mjs")}`]);
      await writeFile(join(directory, "holder.mjs"), `
        import { createPgliteLock } from './lock.mjs';
        if (process.pid !== 1) throw new Error('Expected PID 1');
        const lock = createPgliteLock();
        await lock.acquire('/shared/data', { waitMs: 0, takeover: false });
        console.log('ACQUIRED');
        const timer = setInterval(() => {}, 1000);
        process.on('SIGTERM', () => { lock.release(); clearInterval(timer); });
      `);
      await writeFile(join(directory, "contender.mjs"), `
        import { createPgliteLock } from './lock.mjs';
        const lock = createPgliteLock();
        try {
          await lock.acquire(process.env.LOCK_DIR || '/shared/data', {
            waitMs: 0, takeover: process.env.TAKEOVER !== 'false',
          });
          console.log('ACQUIRED');
          lock.release();
        } catch (error) {
          if (!error.message.includes('already using')) throw error;
          console.log('BLOCKED');
        }
      `);
      await writeFile(join(directory, "exit.mjs"), `
        import { spawnSync } from 'node:child_process';
        import { createPgliteLock } from './lock.mjs';
        const lock = createPgliteLock({ registerExitHook: true });
        await lock.acquire('/shared/exit-data', { waitMs: 0, takeover: false });
        process.on('exit', () => {
          const result = spawnSync(process.execPath, ['/fixture/contender.mjs'], {
            env: { ...process.env, LOCK_DIR: '/shared/exit-data', TAKEOVER: 'false' }, encoding: 'utf8',
          });
          if (result.status !== 0 || result.stdout.trim() !== 'BLOCKED')
            throw new Error('Kernel ownership was released before process exit');
          console.log('EXIT_OWNER_RETAINED');
        });
        process.exit(0);
      `);
      await docker("pull", image);
      await docker("volume", "create", data);
      await docker("volume", "create", code);
      await docker("create", "--name", name, ...mounts, image, "node", "/fixture/holder.mjs");
      await docker("cp", `${directory}/.`, `${name}:/fixture`);
      await docker("start", name);

      for (let starts = 1; starts <= 3; starts++) {
        await expect.poll(async () => {
          const { stdout } = await docker("logs", name);
          return stdout.split("ACQUIRED").length - 1;
        }, { timeout: 10_000 }).toBe(starts);
        const { stdout } = await docker("run", "--rm", ...mounts, image, "node", "/fixture/contender.mjs");
        expect(stdout.trim()).toBe("BLOCKED");
        expect((await docker("inspect", "--format", "{{.State.Running}}", name)).stdout.trim()).toBe("true");
        if (starts < 3) {
          await docker("kill", "--signal=KILL", name);
          await docker("start", name);
        }
      }
      await docker("stop", "--time=5", name);
      const { stdout } = await docker("run", "--rm", ...mounts, image, "node", "/fixture/contender.mjs");
      expect(stdout.trim()).toBe("ACQUIRED");
      const exiting = await docker("run", "--rm", ...mounts, image, "node", "/fixture/exit.mjs");
      expect(exiting.stdout.trim()).toBe("EXIT_OWNER_RETAINED");
      const recovered = await docker("run", "--rm", "--env", "LOCK_DIR=/shared/exit-data",
        ...mounts, image, "node", "/fixture/contender.mjs");
      expect(recovered.stdout.trim()).toBe("ACQUIRED");
    } finally {
      await docker("rm", "-f", name).catch(() => {});
      await docker("volume", "rm", data).catch(() => {});
      await docker("volume", "rm", code).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
