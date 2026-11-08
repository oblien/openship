import { describe, expect, it } from "vitest";
import type { LogEntry } from "../types";
import { BuildLogger } from "./build-pipeline";
import { DockerRuntime } from "./docker";
import { BuildKitTraceDecoder } from "./docker-buildkit-trace";
import { statusResponse } from "../../test/fixtures/docker-buildkit";

function fixture(secret: string) {
  const entries: LogEntry[] = [];
  const logger = new BuildLogger((entry) => entries.push(entry));
  logger.protectSecrets([secret]);
  return { entries, logger };
}

describe("build log confidentiality", () => {
  it("filters all log methods while retaining step, service and resource metadata", () => {
    const { logger, entries } = fixture("example-private-value");
    logger.log("printed example-private-value", "warn", { serviceId: "api", serviceName: "api" });
    logger.step("build", "failed", "failed example-private-value");
    logger.callback({ timestamp: "now", message: "callback example-private-value", level: "info" });
    expect(entries.map((entry) => entry.message)).toEqual([
      "printed ***",
      "failed ***",
      "callback ***",
    ]);
    expect(entries[0]).toMatchObject({ level: "warn", serviceId: "api" });
    expect(entries[1]).toMatchObject({ step: "build", stepStatus: "failed" });
    expect(logger.redact("failure example-private-value")).toBe("failure ***");
  });

  it("filters base64 bytes before live consumers receive them, including split UTF-8", () => {
    const secret = "🔐-example-private-value";
    const bytes = Buffer.from(`ok ${secret}\n`);
    for (let split = 1; split < bytes.length; split++) {
      const { logger, entries } = fixture(secret);
      for (const part of [bytes.subarray(0, split), bytes.subarray(split)]) {
        logger.callback({
          timestamp: "now",
          message: part.toString(),
          rawData: part.toString("base64"),
          level: "info",
          serviceId: "api",
        });
      }
      logger.flush();
      expect(entries.map((entry) => entry.message).join("")).toBe("ok ***\n");
      expect(
        entries.map((entry) => Buffer.from(entry.rawData!, "base64").toString()).join(""),
      ).toBe("ok ***\n");
    }
  });

  it("filters observer callbacks as well as visible output", () => {
    const observed: string[] = [];
    const entries: LogEntry[] = [];
    const logger = new BuildLogger(
      (entry) => entries.push(entry),
      (data) => observed.push(data),
    );
    logger.protectSecrets(["example-private-value"]);
    logger.observeBuildOutput("start example-pri", "stdout");
    logger.observeBuildOutput("vate-value end\n", "stdout");
    logger.flush();
    expect(observed.join("")).toBe("start *** end\n");
    expect(entries).toEqual([]);
  });

  it("filters BuildKit output before prefixes split a value into rendered lines", () => {
    const { logger, entries } = fixture("example-private-value");
    const runtime = Object.create(DockerRuntime.prototype);
    const trace = new BuildKitTraceDecoder();
    for (const msg of ["before example-pri", "vate-value after\n"]) {
      runtime.handleBuildEvent(
        {
          id: "moby.buildkit.trace",
          aux: statusResponse({ logs: [{ vertex: "sha256:build", msg }] }),
        },
        logger,
        trace,
      );
    }
    logger.flush();
    expect(entries.map((entry) => entry.message).join("\n")).toBe("#1 before \n#1 *** after");
  });

  it("keeps simultaneous service streams isolated and conceals abandoned prefixes", () => {
    const { logger, entries } = fixture("example-private-value");
    for (const [serviceId, value] of [
      ["a", "example-pri"],
      ["b", "output b\n"],
      ["a", "vate-value\n"],
    ])
      logger.callback({
        timestamp: "now",
        message: value!,
        rawData: Buffer.from(value!).toString("base64"),
        level: "info",
        serviceId,
      });
    logger.flush();
    expect(
      entries
        .filter((entry) => entry.serviceId === "a")
        .map((entry) => entry.message)
        .join(""),
    ).toBe("***\n");
    expect(
      entries
        .filter((entry) => entry.serviceId === "b")
        .map((entry) => entry.message)
        .join(""),
    ).toBe("output b\n");
  });
});
