import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const entry = new URL("./node.ts", import.meta.url).href;

describe.each(["node", "bun"])("fatal diagnostics under %s", (runtime) => {
  it("retains a queued, opted-in event immediately before an explicit process exit", () => {
    const reporter = new URL("./index.ts", import.meta.url).href;
    const source = `
      import { installNodeErrorReporting } from ${JSON.stringify(entry)};
      import { reportError, errorReporter } from ${JSON.stringify(reporter)};
      installNodeErrorReporting('cli');
      errorReporter.setEnabled(true);
      reportError(new Error('password=protected-exit-913'), { operation: 'install.refused' });
      process.exit(2);
    `;
    const child = spawnSync(
      runtime === "node" ? process.execPath : "bun",
      runtime === "node"
        ? [
            "--import",
            require.resolve("tsx"),
            "--input-type=module",
            "-e",
            source,
          ]
        : ["-e", source],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).not.toContain("protected-exit-913");
    expect(JSON.parse(child.stderr.trim())).toMatchObject({
      context: { source: "cli", operation: "install.refused" },
    });
  });

  it.each(["exception", "rejection"])(
    "records a %s safely and exits nonzero",
    (kind) => {
      const source = `
      import { installNodeErrorReporting } from ${JSON.stringify(entry)};
      installNodeErrorReporting('api');
      const failure = Object.assign(new Error('password=protected-fatal-913'), {
        request: { headers: { authorization: 'Bearer protected-fatal-913' } },
      });
      setTimeout(() => ${kind === "exception" ? "{ throw failure; }" : "{ void Promise.reject(failure); }"}, 0);
    `;
      const child = spawnSync(
        runtime === "node" ? process.execPath : "bun",
        runtime === "node"
          ? [
              "--import",
              require.resolve("tsx"),
              "--input-type=module",
              "-e",
              source,
            ]
          : ["-e", source],
        {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          encoding: "utf8",
          timeout: 10_000,
          env: { PATH: process.env.PATH, NODE_ENV: "test" },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
      expect(child.stderr).not.toContain("protected-fatal-913");
      const event = JSON.parse(child.stderr.trim());
      expect(event).toMatchObject({
        severity: "fatal",
        context: { source: "api", kind: "process", handled: false },
      });
      expect(event.error.stack).toBeTruthy();
    },
  );
});
