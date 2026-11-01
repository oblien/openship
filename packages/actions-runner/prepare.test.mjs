import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { directory } from "./prepare.mjs";

test("prepares a runner from an empty module cache without modifying upstream source", () => {
  const download = spawnSync("go", ["mod", "download", "-json", "github.com/nektos/act"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(download.status, 0, download.stderr || download.stdout);
  const upstream = JSON.parse(download.stdout);
  const sourcePath = "pkg/container/host_environment.go";
  const original = readFileSync(join(upstream.Dir, sourcePath), "utf8");
  const cache = spawnSync("go", ["env", "GOMODCACHE"], { cwd: directory, encoding: "utf8" });
  assert.equal(cache.status, 0, cache.stderr);
  const temporary = mkdtempSync(join(tmpdir(), "openship-runner-prepare-"));
  // Serve the actual pinned module from the local Go proxy cache. No network
  // fallback: the child must populate a new module cache before patching.
  const env = {
    ...process.env,
    GOMODCACHE: join(temporary, "modules"),
    GOPROXY: pathToFileURL(join(cache.stdout.trim(), "cache", "download")).href,
    GOSUMDB: "off", // The checked-in go.sum still verifies the downloaded source.
    GOTOOLCHAIN: "local",
  };
  try {
    const prepared = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { existsSync } from "node:fs";
      import { join, sep } from "node:path";
      import { directory, prepareRunnerModule } from "./prepare.mjs";
      const modfile = prepareRunnerModule();
      const module = JSON.parse(execFileSync("go", ["list", "-m", "-json", "-modfile=" + modfile, "github.com/nektos/act"], { cwd: directory, encoding: "utf8" }));
      assert.equal(module.Version, "v0.2.89");
      assert.ok(module.Replace.Dir.startsWith(join(directory, ".generated") + sep));
      assert.ok(existsSync(join(module.Replace.Dir, "pkg/container/host_environment.go")));
      assert.ok(existsSync(modfile.replace(/\\.mod$/, ".sum")));
    `], { cwd: directory, env, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    assert.equal(readFileSync(join(env.GOMODCACHE, "github.com/nektos/act@v0.2.89", sourcePath), "utf8"), original);
    assert.equal(readFileSync(join(upstream.Dir, sourcePath), "utf8"), original);
  } finally {
    // Go removes read-only module-cache directories on macOS and Linux. This
    // environment points only to the test's private directory.
    spawnSync("go", ["clean", "-modcache"], { cwd: directory, env });
    rmSync(temporary, { recursive: true, force: true });
  }
});
