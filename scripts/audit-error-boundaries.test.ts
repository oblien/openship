import { describe, expect, it } from "bun:test";
import { auditSource } from "./audit-error-boundaries.mjs";

describe("error boundary gate", () => {
  it("rejects silent catches, forgotten promise rejections and raw error logs", () => {
    const rows = auditSource(
      "apps/api/src/example.ts",
      `
      try { await run(); } catch { return null; }
      request().then(ok, () => false);
      socket.on('error', () => {});
      console.error('unsafe', error);
    `,
    );
    expect(rows.map((row) => row.disposition)).toEqual([
      "unobserved",
      "unobserved",
      "unobserved",
      "unstructured",
    ]);
  });
  it("accounts for capture, propagation, parsing fallbacks and documented queue cleanup", () => {
    const rows = auditSource(
      "packages/platform/src/example.ts",
      `
      try { await run(); } catch (error) { reportError(error); return null; }
      request().catch(error => { throw error; });
      try { return JSON.parse(text); } catch { return null; }
      task.then(ok, () => { /* diagnostics-ignore: the original task is returned to its caller. */ clear(); });
    `,
    );
    expect(rows.map((row) => row.disposition)).toEqual([
      "observed",
      "propagated",
      "parsing-fallback",
      "documented-control-flow",
    ]);
  });
});
