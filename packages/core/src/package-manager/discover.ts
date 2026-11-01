import * as fs from "node:fs";
import * as path from "node:path";
import { declaredPackageManagerPin, type ManagedPackageManager } from "../package-manager-version";

/** Collect the nearest repository declarations without changing project files. */
export function discoverPackageManager(manager: ManagedPackageManager) {
  let directory = process.cwd();
  let pin: string | undefined,
    lock: string | undefined,
    yarnLock: string | undefined,
    yarnPath: string | undefined;
  let scriptPolicy = false;
  let ignoreYarnPath = /^(?:1|true)$/i.test(process.env.YARN_IGNORE_PATH || "");
  const policyKeys = [
    "onlyBuiltDependencies",
    "ignoredBuiltDependencies",
    "neverBuiltDependencies",
    "allowBuilds",
    "strictDepBuilds",
    "dangerouslyAllowAllBuilds",
  ];
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (pkg.pnpm && policyKeys.some((key) => key in pkg.pnpm)) scriptPolicy = true;
      const declared = declaredPackageManagerPin(pkg, manager);
      if (declared) pin = declared;
    }
    for (const name of ["pnpm-workspace.yaml", ".npmrc"]) {
      const file = path.join(directory, name);
      if (
        fs.existsSync(file) &&
        /^(?:onlyBuiltDependencies|ignoredBuiltDependencies|neverBuiltDependencies|allowBuilds|strictDepBuilds|dangerouslyAllowAllBuilds|strict-dep-builds)\s*[:=]/m.test(
          fs.readFileSync(file, "utf8"),
        )
      )
        scriptPolicy = true;
    }
    if (
      manager === "yarn" &&
      yarnLock === undefined &&
      fs.existsSync(path.join(directory, "yarn.lock"))
    )
      yarnLock = fs.readFileSync(path.join(directory, "yarn.lock"), "utf8");
    if (manager === "yarn" && yarnPath === undefined)
      for (const name of [".yarnrc.yml", ".yarnrc"]) {
        const file = path.join(directory, name);
        if (!fs.existsSync(file)) continue;
        const contents = fs.readFileSync(file, "utf8");
        if (/^\s*ignorePath:\s*true\s*(?:#.*)?$/m.test(contents)) ignoreYarnPath = true;
        const match = contents.match(
          /^\s*(?:yarnPath:|yarn-path)\s*(?:"([^"]+)"|'([^']+)'|([^#\r\n]+))/m,
        );
        const value = match && (match[1] || match[2] || match[3]).trim();
        if (value && value !== "false" && value !== "null") {
          yarnPath = path.resolve(directory, value);
          break;
        }
      }
    const file = path.join(directory, "pnpm-lock.yaml");
    if (manager === "pnpm" && lock === undefined && fs.existsSync(file)) {
      const match = fs
        .readFileSync(file, "utf8")
        .match(/^lockfileVersion:\s*['"]?(\d+(?:\.\d+)?)/m);
      if (!match)
        throw new Error(
          "Cannot determine pnpm lockfile version; set packageManager to pnpm@X.Y.Z.",
        );
      lock = match[1];
    }
    if (pin || fs.existsSync(path.join(directory, ".git"))) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return { pin, lock, yarnLock, yarnPath, scriptPolicy, ignoreYarnPath };
}
export type PackageManagerDiscovery = ReturnType<typeof discoverPackageManager>;
