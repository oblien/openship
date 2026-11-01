import { describe, expect, it } from "vitest";
import { deploymentResourceIssue } from "./deployment-resource-issue";

describe("deployment resource evidence", () => {
  it.each([
    ["copy_file_range failed: no space left on device", "storage-full"],
    ["npm ERR! code ENOSPC", "storage-full"],
    ["FATAL ERROR: JavaScript heap out of memory", "process-heap"],
    ["FATAL ERROR: Reached heap limit Allocation failed", "process-heap"],
    ["fatal error: runtime: out of memory", "memory-allocation"],
    ["fork: cannot allocate memory", "memory-allocation"],
    ["npm ERR! code ENOMEM", "memory-allocation"],
    ["process exited with code 137", "process-killed"],
    ["process exited with code 1\nFATAL ERROR: JavaScript heap out of memory", "process-heap"],
  ])("classifies the failing operation: %s", (message, expected) => {
    expect(deploymentResourceIssue(message)).toBe(expected);
  });
  it.each([
    "Build ran for 20 minutes",
    "Memory utilization: 99%",
    "Disk utilization: 99%",
    "Could not reach Docker daemon",
    "exit code 143",
    "exit code 0",
    "exit code 1",
    "Memory pressure is one possible cause of this timeout",
    "COPY . .",
  ])("does not invent a capacity failure: %s", (message) => {
    expect(deploymentResourceIssue(message)).toBeNull();
  });
  it("recognizes measured storage pressure without claiming the disk is full", () => {
    expect(deploymentResourceIssue("Too little free storage", "BUILD_STORAGE_LOW")).toBe(
      "storage-low",
    );
    expect(
      deploymentResourceIssue("Could not measure storage", "BUILD_STORAGE_UNKNOWN"),
    ).toBeNull();
  });
});
