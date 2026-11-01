import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packageManagerEnsureCommand } from "../src/stacks";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function run(
  files: Record<string, string>,
  options: {
    nested?: boolean;
    failCorepack?: boolean;
    manager?: string;
    reportedVersion?: string;
    nodeAliasToBun?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openship-pnpm-bootstrap-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "bin"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  for (const cmd of ["corepack", "npm", "pnpm", "yarn", "bun"])
    writeFileSync(
      join(root, "bin", cmd),
      `#!/bin/sh
printf '%s\\n' "${cmd} $*" >> "$BOOTSTRAP_LOG"
if [ "$1" = "--version" ]; then
  if [ -n "$REPORTED_VERSION" ]; then echo "$REPORTED_VERSION"; elif [ -f "$BOOTSTRAP_STATE" ]; then cat "$BOOTSTRAP_STATE"; else echo 0.0.0; fi
  exit 0
fi
${cmd === "corepack" && options.failCorepack ? "exit 1" : ""}
if [ "${cmd}" = corepack ] && [ "$1" = prepare ]; then printf '%s' "$2" | sed 's/^.*@//;s/+sha.*//' > "$BOOTSTRAP_STATE"; fi
if [ "${cmd}" = npm ] && [ "$1" = install ]; then printf '%s' "$3" | sed 's/^.*@//;s/+sha.*//' > "$BOOTSTRAP_STATE"; fi
exit 0
`,
      { mode: 0o755 },
    );
  if (options.nodeAliasToBun) {
    const binary = spawnSync("bun", ["--print", "process.execPath"], { encoding: "utf8" });
    expect(binary.status, binary.stderr).toBe(0);
    symlinkSync(binary.stdout.trim(), join(root, "bin", "node"));
  }
  const cwd = options.nested ? join(root, "nested") : root;
  if (options.nested) {
    mkdirSync(cwd);
    writeFileSync(join(cwd, "package.json"), "{}");
  }
  const result = spawnSync("sh", ["-c", packageManagerEnsureCommand(options.manager ?? "pnpm")], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      BOOTSTRAP_LOG: join(root, "calls"),
      BOOTSTRAP_STATE: join(root, "version"),
      REPORTED_VERSION: options.reportedVersion ?? "",
    },
  });
  let calls = "";
  try {
    calls = readFileSync(join(root, "calls"), "utf8");
  } catch {}
  return { ...result, calls, root };
}
describe("managed pnpm bootstrap", () => {
  it("does not downgrade an unpinned repository with an explicit dependency-script policy", () => {
    const result = run({
      "package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "allowBuilds:\n  sharp: false\n",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("preserves your explicit dependency-script policy");
    expect(result.calls).toBe("");
  });

  it.each([
    ["9.0", "9.15.9"],
    ["6.0", "8.15.9"],
    ["5.4", "7.33.7"],
  ])("selects a fixed version for lockfile %s", (lock, version) => {
    const result = run({ "package.json": "{}", "pnpm-lock.yaml": `lockfileVersion: '${lock}'\n` });
    expect(result.status).toBe(0);
    expect(result.calls).toContain(`corepack prepare pnpm@${version} --activate`);
    expect(readFileSync(join(result.root, "package.json"), "utf8")).toBe("{}");
  });
  it("honors a parent packageManager pin even when a child has a package.json", () => {
    const result = run(
      {
        "package.json": JSON.stringify({ packageManager: "pnpm@12.10.1" }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      },
      { nested: true },
    );
    expect(result.status).toBe(0);
    expect(result.calls).toContain("prepare pnpm@12.10.1 --activate");
  });
  it("honors exact devEngines pins", () => {
    const result = run({
      "package.json": JSON.stringify({
        devEngines: { packageManager: { name: "pnpm", version: "10.1.0" } },
      }),
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain("prepare pnpm@10.1.0 --activate");
  });
  it("keeps the selected version in the npm fallback", () => {
    const result = run({ "pnpm-lock.yaml": "lockfileVersion: '9.0'" }, { failCorepack: true });
    expect(result.status).toBe(0);
    expect(result.calls).toContain("npm install --global pnpm@9.15.9");
  });
  it.each(["pnpm@latest", "pnpm@9;touch /tmp/injected", "yarn@1.22.22"])(
    "refuses incompatible or unbounded pins: %s",
    (packageManager) => {
      const result = run({ "package.json": JSON.stringify({ packageManager }) });
      expect(result.status).not.toBe(0);
      expect(result.calls).toBe("");
    },
  );
  it("does not silently ignore an unknown lockfile", () => {
    const result = run({ "pnpm-lock.yaml": "lockfileVersion: '99.0'" });
    expect(result.status).not.toBe(0);
    expect(result.calls).toBe("");
  });
  it("does not drop integrity requirements when corepack fails", () => {
    const result = run(
      {
        "package.json": JSON.stringify({ packageManager: `pnpm@9.15.9+sha224.${"a".repeat(56)}` }),
      },
      { failCorepack: true },
    );
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toContain("npm install");
  });
});

describe("shared package-manager contract", () => {
  it("bootstraps Bun when node is an alias to the actual Bun runtime", () => {
    const result = run(
      { "package.json": '{"packageManager":"bun@1.4.4"}' },
      { manager: "bun", nodeAliasToBun: true, reportedVersion: "1.4.4" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified package manager: bun@1.4.4");
  });
  it("retains npm integrity pins through Corepack", () => {
    const pin = `npm@9.9.4+sha512.${"a".repeat(128)}`;
    const result = run(
      { "package.json": JSON.stringify({ packageManager: pin }) },
      { manager: "npm" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain(`corepack prepare ${pin} --activate`);
  });

  it.each(["npm", "pnpm", "yarn", "bun"])("installs and verifies the exact %s pin", (manager) => {
    const version = manager === "bun" ? "1.2.10" : manager === "yarn" ? "4.9.2" : "9.9.4";
    const result = run(
      { "package.json": JSON.stringify({ packageManager: `${manager}@${version}` }) },
      { manager },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Verified package manager: ${manager}@${version}`);
  });
  it.each(["npm", "pnpm", "yarn", "bun"])(
    "refuses a successful install that leaves the wrong %s version",
    (manager) => {
      const result = run({}, { manager, reportedVersion: "0.0.0" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Package-manager verification failed");
    },
  );
  it("uses the modern Yarn CLI distribution when Corepack is absent", () => {
    const result = run(
      { "package.json": '{"packageManager":"yarn@4.9.2"}' },
      { manager: "yarn", failCorepack: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("npm install --global @yarnpkg/cli-dist@4.9.2");
  });
  it("selects modern Yarn from its lockfile metadata", () => {
    const result = run({ "yarn.lock": "__metadata:\n  version: 8\n" }, { manager: "yarn" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("prepare yarn@4.9.2");
  });
  it("respects Yarn ignorePath without executing the ignored file", () => {
    const result = run(
      {
        "package.json": '{"packageManager":"yarn@4.9.2"}',
        ".yarnrc.yml": "ignorePath: true\nyarnPath: ./missing.cjs\n",
      },
      { manager: "yarn" },
    );
    expect(result.status, result.stderr).toBe(0);
  });
  it("honors a repository-local yarnPath", () => {
    const result = run(
      { ".yarnrc.yml": "yarnPath: ./yarn.cjs\n", "yarn.cjs": 'console.log("4.9.2")' },
      { manager: "yarn" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("prepare yarn@4.9.2");
  });
  it("does not hide a disagreement between yarnPath and packageManager", () => {
    const result = run(
      {
        "package.json": '{"packageManager":"yarn@3.8.7"}',
        ".yarnrc.yml": "yarnPath: ./yarn.cjs\n",
        "yarn.cjs": 'console.log("4.9.2")',
      },
      { manager: "yarn" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("disagree");
  });
});
