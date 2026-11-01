import { expect, it, vi } from "vitest";
import { projectBuildKitWorker, removeProjectBuildKitWorker } from "./docker-buildkit-worker";

const worker = projectBuildKitWorker("project-a");
it("derives a stable single-node identity without accepting command text from project IDs", () => {
  expect(worker.builderName).toMatch(/^openship-cache-[a-f0-9]{24}$/);
  expect(worker.nodeName).toBe(`${worker.builderName}0`);
  expect(worker.containerName).toBe(`buildx_buildkit_${worker.nodeName}`);
  expect(projectBuildKitWorker("project-b")).not.toEqual(worker);
  expect(projectBuildKitWorker("'; docker rm other #").builderName).toMatch(
    /^openship-cache-[a-f0-9]{24}$/,
  );
});

it("removes a daemon worker even when buildx metadata is missing, then verifies absence", async () => {
  const exec = vi
    .fn()
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockRejectedValueOnce(new Error("builder metadata missing"))
    .mockResolvedValueOnce(`${worker.containerName}\n`)
    .mockResolvedValueOnce(worker.containerName)
    .mockResolvedValueOnce("");
  await removeProjectBuildKitWorker({ exec }, "project-a");
  expect(exec.mock.calls[3]![0]).toContain(`name=^/${worker.containerName}$`);
  expect(exec.mock.calls[4]![0]).toBe(`docker container rm --force '${worker.containerName}'`);
  expect(exec.mock.calls[5]).toEqual(exec.mock.calls[3]);
  expect(exec.mock.calls.flat().join(" ")).not.toContain(
    projectBuildKitWorker("project-b").containerName,
  );
});

it("accepts already absent workers only after a successful daemon query", async () => {
  const exec = vi
    .fn()
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockRejectedValueOnce(new Error("no buildx plugin"))
    .mockResolvedValueOnce("");
  await removeProjectBuildKitWorker({ exec }, "project-a");
  expect(exec).toHaveBeenCalledTimes(4);
});

it("does not mistake an unreachable daemon for an absent worker", async () => {
  const exec = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("").mockResolvedValueOnce("").mockRejectedValueOnce(new Error("daemon offline"));
  await expect(removeProjectBuildKitWorker({ exec }, "project-a")).rejects.toMatchObject({
    code: "CLOUD_BUILD_WORKER_EXIT_UNCONFIRMED",
  });
});

it("refuses to release when Docker still reports the worker after removal", async () => {
  const exec = vi
    .fn()
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(worker.containerName)
    .mockRejectedValueOnce(new Error("removal failed"))
    .mockResolvedValueOnce(worker.containerName);
  await expect(removeProjectBuildKitWorker({ exec }, "project-a")).rejects.toMatchObject({
    code: "CLOUD_BUILD_WORKER_EXIT_UNCONFIRMED",
  });
});

it("reconciles a lost removal acknowledgement using confirmed daemon absence", async () => {
  const exec = vi
    .fn()
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce(worker.containerName)
    .mockRejectedValueOnce(new Error("lost acknowledgement"))
    .mockResolvedValueOnce("");
  await expect(removeProjectBuildKitWorker({ exec }, "project-a")).resolves.toBeUndefined();
});

it("never removes a container with a different identity", async () => {
  const exec = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("customer-service");
  await expect(removeProjectBuildKitWorker({ exec }, "project-a")).rejects.toMatchObject({
    code: "CLOUD_BUILD_WORKER_EXIT_UNCONFIRMED",
  });
  expect(exec).toHaveBeenCalledTimes(2);
});
