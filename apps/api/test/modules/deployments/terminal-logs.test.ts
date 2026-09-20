import { describe, expect, it } from "vitest";
import type { LogEntry } from "@repo/adapters";

import { collapseTerminalLogs } from "@repo/platform/engine/modules/deployments/terminal-logs";

const entry = (message: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: "2026-07-04T00:00:00.000Z",
  message,
  level: "info",
  ...extra,
});

describe("collapseTerminalLogs", () => {
  it("keeps consecutive newline-less entries as SEPARATE lines (per-service build output)", () => {
    // Docker build steps arrive as discrete entries with no trailing newline.
    const out = collapseTerminalLogs([
      entry("Step 1/3 : FROM node:22", { serviceName: "api" }),
      entry("Step 2/3 : WORKDIR /app", { serviceName: "api" }),
      entry("Step 3/3 : RUN npm ci", { serviceName: "api" }),
    ]);
    expect(out.map((e) => e.message)).toEqual([
      "Step 1/3 : FROM node:22",
      "Step 2/3 : WORKDIR /app",
      "Step 3/3 : RUN npm ci",
    ]);
    // serviceName is preserved so the line lands in the right compose tab.
    expect(out.every((e) => e.serviceName === "api")).toBe(true);
  });

  it("collapses a bare-\\r progress bar within an entry to its final value", () => {
    const out = collapseTerminalLogs([
      entry("Counting objects:  42%\rCounting objects: 100%, done.\n", { serviceName: "api" }),
    ]);
    expect(out.map((e) => e.message)).toEqual(["Counting objects: 100%, done."]);
  });

  it("splits multi-line entries on \\n", () => {
    const out = collapseTerminalLogs([entry("line one\nline two\nline three")]);
    expect(out.map((e) => e.message)).toEqual(["line one", "line two", "line three"]);
  });

  it("passes step-metadata entries through unchanged", () => {
    const step = entry("Deploying...", { step: "deploy", stepStatus: "running" });
    const out = collapseTerminalLogs([entry("build log", { serviceName: "api" }), step]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ step: "deploy", stepStatus: "running" });
  });

  it("does not merge output across different services", () => {
    const out = collapseTerminalLogs([
      entry("api build line", { serviceName: "api" }),
      entry("web build line", { serviceName: "web" }),
    ]);
    expect(out).toEqual([
      expect.objectContaining({ message: "api build line", serviceName: "api" }),
      expect.objectContaining({ message: "web build line", serviceName: "web" }),
    ]);
  });
});
