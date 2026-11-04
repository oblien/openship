import { describe, expect, it } from "bun:test";
import { auditProcessSource, unreviewedProcessSites } from "./audit-process-execution.mjs";

describe("process execution review gate", () => {
  it("finds named, namespace, require, dynamic and promisified process launches", () => {
    const sites = auditProcessSource(
      "packages/adapters/src/example.ts",
      `
      import { spawn as launch, execFile } from 'node:child_process';
      import * as cp from 'child_process';
      const run = promisify(execFile);
      const { spawnSync: sync } = require('child_process');
      async function direct() {
        launch('sh', ['-c', input]); cp.exec(input); await run('git', args); sync('sh', args);
        const { exec: invoke } = await import('node:child_process'); invoke(input);
        require('child_process').spawn(input);
      }
    `,
    );
    expect(sites.map((site) => site.api).sort()).toEqual([
      "exec",
      "exec",
      "execFile",
      "spawn",
      "spawn",
      "spawnSync",
    ]);
  });
  it("finds Bun and Deno launches, including Bun tagged shell templates", () => {
    const sites = auditProcessSource(
      "example.ts",
      "import { $ as shell } from 'bun'; shell`echo hi`; Bun.$`echo hi`; Bun.spawn(['sh']); new Deno.Command('sh');",
    );
    expect(sites.map((site) => site.api)).toEqual(["Bun.$", "Bun.$", "Bun.spawn", "Deno.Command"]);
  });
  it("detects a new LocalExecutor method instead of allowing every future spawn in that file", () => {
    const rows = auditProcessSource(
      "local.ts",
      "import { spawn } from 'node:child_process'; class LocalExecutor { rawExec(command: string) { return spawn('sh', ['-c', command]); } }",
    );
    expect(rows).toEqual([{ file: "local.ts", scope: "LocalExecutor.rawExec", api: "spawn" }]);
    const key = "local.ts:LocalExecutor.rawExec:spawn";
    expect(
      unreviewedProcessSites(
        [{ key, count: 1 }],
        [{ key: "local.ts:LocalExecutor.streamExec:spawn", count: 1, boundary: "Cloud floor" }],
      ),
    ).toEqual([{ key, count: 1 }]);
    expect(
      unreviewedProcessSites([{ key, count: 2 }], [{ key, count: 1, boundary: "Cloud floor" }]),
    ).toHaveLength(1);
    expect(
      unreviewedProcessSites([{ key, count: 1 }], [{ key, count: 1, boundary: "" }]),
    ).toHaveLength(1);
  });
  it("ignores comments but inspects embedded JavaScript wrappers", () => {
    expect(auditProcessSource("plain.ts", "// spawn('sh')\nconst message = 'hello';")).toEqual([]);
    const rows = auditProcessSource(
      "wrapper.ts",
      "export const wrapper = String.raw`import { spawn } from 'node:child_process'; spawn(tool, args);`;",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].api).toBe("spawn");
  });
});
