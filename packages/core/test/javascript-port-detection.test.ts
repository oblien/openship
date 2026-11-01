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

  it.each([
    '  PORT="8080" node server.js  ',
    "NODE_ENV=production PORT='8080' node server.js",
    'cross-env DESCRIPTION="production web server" PORT=8080 node server.js',
    'env PORT=8080 node server.js',
    'set "PORT=8080" && node server.js',
  ])("reads a literal port in %s", (start) => {
    expect(detectPort({ start })).toBe(8080);
  });

  it.each([
    "echo PORT=8080",
    'node server.js --define PORT=8080',
    'node server.js --description "PORT=8080"',
    "port=8080 node server.js",
    "MY_PORT=8080 node server.js",
    "PORT = 8080 node server.js",
    "PORT=8080.5 node server.js",
    "PORT=8080/path node server.js",
    'PORT="8080suffix" node server.js',
    'PORT=$PRODUCTION_PORT node server.js',
    'node server.js --grpc-port=8080',
    'node server.js --port=8080.5',
  ])("does not infer the listening port from %s", (start) => {
    expect(detectPort({ start })).toBeNull();
  });

  it("uses the final assignment and does not revive an overwritten literal", () => {
    expect(detectPort({ start: "PORT=3000 PORT=8080 node server.js" })).toBe(8080);
    expect(detectPort({ start: "PORT=3000 PORT=$RUNTIME_PORT node server.js" })).toBeNull();
    expect(detectPort({ start: 'PORT=3000 PORT="\\$RUNTIME_PORT" node server.js' })).toBeNull();
  });

  it("prefers the production assignment over a development CLI flag", () => {
    expect(detectPort({ start: "PORT=8080 node server.js", dev: "vite --port 5173" })).toBe(8080);
  });

  it("ignores malformed script entries", () => {
    expect(javascriptLanguageDetector.detectPort?.({
      packageJson: { scripts: { start: 123, dev: "PORT=8080 node server.js" } },
    })).toBe(8080);
  });
});
