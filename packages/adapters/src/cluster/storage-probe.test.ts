import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runClusterJob } from "./job";
import { StorageProbe } from "./storage-probe";
import { managedStorageClass } from "./storage";
import { KubernetesApiError, type KubernetesApi, type KubernetesObject } from "./kubernetes-api";

vi.mock("./job", () => ({ runClusterJob: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("shared-file verification policy", () => {
  it("permits bounded pod replacement while failing a corrupt or missing file without retry", async () => {
    const jobs: KubernetesObject[] = [];
    vi.mocked(runClusterJob).mockImplementation(async (_api, job) => {
      jobs.push(job);
      return { job, output: "" };
    });
    const cleanup = vi.spyOn(StorageProbe.prototype, "cleanup").mockResolvedValue();
    const api = {
      request: vi.fn(async (method: string, _path: string, body?: unknown) => {
        if (method === "GET") throw new KubernetesApiError(404, "Missing");
        if (method === "POST") return body;
        throw new Error("Unexpected request");
      }),
    } as unknown as KubernetesApi;
    await new StorageProbe(api, "runtime", AbortSignal.timeout(5000), async () => {}).run(
      managedStorageClass("runtime", 2),
      [
        { name: "First", nodeName: "one" },
        { name: "Second", nodeName: "two" },
      ],
      async () => {},
    );
    expect(jobs).toHaveLength(2);
    expect(
      jobs.map((job) => job.spec.template.spec.nodeSelector["kubernetes.io/hostname"]),
    ).toEqual(["one", "two"]);
    expect(cleanup).toHaveBeenCalledOnce();

    const directory = mkdtempSync(join(tmpdir(), "openship-storage-probe-"));
    const command = (job: KubernetesObject): [string, string[]] => {
      const [program, ...args] = job.spec.template.spec.containers[0].command as string[];
      // Run the actual submitted checker against an isolated shared directory.
      return [program!, args.map((arg) => arg.replaceAll("/shared/", `${directory}/`))];
    };
    try {
      execFileSync(...command(jobs[0]!));
      execFileSync(...command(jobs[1]!));
      writeFileSync(join(directory, "roundtrip"), "corrupt data");
      const corrupt = spawnSync(...command(jobs[1]!));
      rmSync(join(directory, "roundtrip"));
      const missing = spawnSync(...command(jobs[1]!));
      mkdirSync(join(directory, "roundtrip"));
      const unwritable = spawnSync(...command(jobs[0]!));
      for (const job of jobs) {
        expect(job.spec.backoffLimit).toBeGreaterThan(0);
        expect(job.spec.backoffLimit).toBeLessThanOrEqual(2);
        expect(job.spec.activeDeadlineSeconds).toBeLessThanOrEqual(300);
        expect(job.spec.template.spec.restartPolicy).toBe("Never");
        const exitRule = (code: number | null) =>
          job.spec.podFailurePolicy.rules.find((rule: any) => {
            const match = rule.onExitCodes;
            if (match?.containerName !== "check") return false;
            return match.operator === "In"
              ? match.values.includes(code)
              : !match.values.includes(code);
          });
        // Longhorn remounts can stop the shell during startup with exit 2,
        // not just 137/143. Only the checker's explicit file-error exit is a
        // verified mismatch; interrupted processes consume the finite budget.
        expect(exitRule(2)).toBeUndefined();
        expect(exitRule(137)).toBeUndefined();
        expect(exitRule(143)).toBeUndefined();
        for (const result of [corrupt, missing, unwritable]) {
          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          // Kubernetes uses the first matching rule. A real checker error
          // must end the Job, rather than consume the pod replacement budget.
          expect(exitRule(result.status)?.action).toBe("FailJob");
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
