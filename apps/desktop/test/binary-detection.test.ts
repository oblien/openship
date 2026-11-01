import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("bounds the macOS signer's binary probe for malformed protobuf-like resources", () => {
  // Resolve through Forge's signing dependency chain, including isolated installs.
  const desktopRequire = createRequire(import.meta.url);
  let require = createRequire(desktopRequire.resolve("@electron-forge/cli/package.json"));
  for (const dependency of ["@electron-forge/core", "@electron/packager", "@electron/osx-sign"]) {
    require = createRequire(require.resolve(dependency));
  }
  const detector = require.resolve("isbinaryfile");
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "-e",
      `const assert = require('node:assert/strict');
const { isBinaryFile, isBinaryFileSync } = require(process.argv[1]);
(async () => {
  const malformed = Buffer.alloc(512, 0x61);
  // Length-delimited protobuf field claiming 2 GiB in a 512-byte sample.
  malformed.set([0x0a, 0xff, 0xff, 0xff, 0xff, 0x07]);
  for (const [buffer, binary] of [[Buffer.from('plain text'), false], [Buffer.from([0, 1, 2]), true], [malformed, false]]) {
    assert.equal(isBinaryFileSync(buffer, buffer.length), binary);
    assert.equal(await isBinaryFile(buffer, buffer.length), binary);
  }
  console.log('BOUNDED_BINARY_PROBE_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });`,
      detector,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("BOUNDED_BINARY_PROBE_OK");
});
