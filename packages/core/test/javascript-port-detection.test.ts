import { describe, expect, it } from "vitest";
import { javascriptLanguageDetector } from "../src/languages/javascript";

function detectPort(scripts: Record<string, string>): number | null {
  return javascriptLanguageDetector.detectPort?.({ packageJson: { scripts } }) ?? null;
}

describe("JavaScript package script port detection", () => {
  it("detects POSIX inline PORT assignments", () => {
    expect(detectPort({ start: "PORT=8080 node server.js" })).toBe(8080);
  });

  it("detects cross-env PORT assignments", () => {
    expect(detectPort({ start: "cross-env NODE_ENV=production PORT=4173 vite preview" })).toBe(4173);
  });

  it("detects Windows set PORT assignments", () => {
    expect(detectPort({ start: "set PORT=3001 && node server.js" })).toBe(3001);
  });

  it("prefers an explicit port flag over an environment assignment", () => {
    expect(detectPort({ start: "PORT=3000 vite --port 8080" })).toBe(8080);
  });

  it("ignores invalid ports and continues to lower-priority scripts", () => {
    expect(
      detectPort({
        start: "PORT=70000 node server.js",
        dev: "vite --port 5173",
      }),
    ).toBe(5173);
  });

  it("does not treat PORT references without assignment as a concrete port", () => {
    expect(detectPort({ start: "node server.js --port $PORT" })).toBeNull();
  });
});
