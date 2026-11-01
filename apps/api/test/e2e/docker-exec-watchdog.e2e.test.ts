/** Real shell cancellation: BusyBox startup races and PostgreSQL timer adoption. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { buildInContainerExecCmd } from "../../../../packages/adapters/src/runtime/docker";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const execFileAsync = promisify(execFile);
const POSTGRES =
  "postgres:17@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232";

function docker(args: string[], timeout = 30_000) {
  return execFileAsync("docker", ["--host", `unix://${dockerSocketPath}`, ...args], {
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

describeDockerE2E.each([
  { name: "BusyBox ash", image: "busybox:1.37", postgres: false },
  { name: "Debian dash with PostgreSQL as PID 1", image: POSTGRES, postgres: true },
])("container exec watchdog: $name", ({ image, postgres }) => {
  beforeAll(async () => {
    await requireDocker();
    await docker(["pull", image], 120_000);
  }, 150_000);

  it("returns promptly, reaps timers and still enforces command deadlines", async () => {
    const { stdout: created } = await docker([
      "create",
      "--network",
      "none",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--label",
      "openship.test=exec-watchdog",
      ...(postgres
        ? [
            "--tmpfs",
            "/var/lib/postgresql/data:rw,size=256m",
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            image,
          ]
        : ["--entrypoint", "sh", image, "-c", "exec tail -f /dev/null"]),
    ]);
    const container = created.trim();
    try {
      await docker(["start", container]);
      if (postgres) {
        await docker([
          "exec",
          container,
          "sh",
          "-c",
          'i=0; until [ "$(cat /proc/1/comm)" = postgres ] && pg_isready -U postgres >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 100 ] || exit 1; sleep 0.1; done',
        ]);
      }

      // A timer must be running before these successful commands return.
      for (let i = 0; i < 3; i++) {
        await docker(["exec", container, ...buildInContainerExecCmd("sleep 0.1", 30_000)], 5_000);
      }

      // Rapid completion hits BusyBox's child-startup/cancellation window. A lost
      // cancellation waits the full 30s watchdog, exceeding this batch's 20s cap.
      // Pass the actual argv, rather than maintaining another copy of the wrapper.
      await docker(
        [
          "exec",
          container,
          "sh",
          "-c",
          'i=0; while [ "$i" -lt 2000 ]; do "$@" || exit; i=$((i+1)); done',
          "openship-watchdog-batch",
          ...buildInContainerExecCmd(":", 30_000),
        ],
        20_000,
      );

      await expect(
        docker(
          [
            "exec",
            container,
            ...buildInContainerExecCmd(
              "printf '%s\\n' 'literal $HOME \"quoted\"'; printf err >&2; exit 7",
              30_000,
            ),
          ],
          5_000,
        ),
      ).rejects.toMatchObject({ code: 7, stdout: 'literal $HOME "quoted"\n', stderr: "err" });

      await expect(
        docker(["exec", container, ...buildInContainerExecCmd("sleep 30", 1_000)], 5_000),
      ).rejects.toMatchObject({ code: 143, stderr: "" });

      const { stdout: processes } = await docker(["top", container, "-eo", "pid,ppid,stat,comm"]);
      expect(processes.split("\n").filter((line) => /\bsleep\s*$/.test(line))).toEqual([]);
      if (postgres) await docker(["exec", container, "pg_isready", "-U", "postgres"]);
    } finally {
      // Removing our container also stops an exec if a regression hit the CLI timeout.
      await docker(["rm", "--force", container]);
    }
  }, 90_000);
});
