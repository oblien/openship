import type { ManagedPackageManager } from "../package-manager-version";
import type { PackageManagerSelection } from "./resolve";
import { run, versionOf } from "./execute";
import { installBunBinary } from "./install-bun";

function installWithCorepack({ manager, pin, version }: PackageManagerSelection): void {
  if (run("corepack", ["enable", manager])) {
    if (!run("corepack", ["prepare", pin, "--activate"]))
      throw new Error("Corepack could not prepare the selected package-manager version.");
    return;
  }
  if (pin.includes("+sha"))
    throw new Error("Corepack is required to honor the packageManager integrity pin.");
  const spec =
    manager === "yarn" && Number(version.split(".")[0]) >= 2 ? "@yarnpkg/cli-dist@" + version : pin;
  if (!run("npm", ["install", "--global", spec]))
    throw new Error("Unable to install the selected package-manager version.");
}

function installWithNpm({ pin }: PackageManagerSelection): void {
  if (!run("npm", ["install", "--global", pin]))
    throw new Error(
      "Unable to install " +
        pin +
        ". Use a build image containing this version or an npm installer.",
    );
}

function installNpm(selection: PackageManagerSelection): void {
  if (selection.pin.includes("+sha")) return installWithCorepack(selection);
  if (versionOf("npm") !== selection.version) installWithNpm(selection);
}

function installBun(selection: PackageManagerSelection): void {
  if (selection.pin.includes("+sha"))
    throw new Error(
      "Integrity-qualified Bun pins need a custom toolchain; no integrity requirement was discarded.",
    );
  if (versionOf("bun") === selection.version) return;
  if ("bun" in process.versions) installBunBinary(selection.version);
  else installWithNpm(selection);
}

const installers: Record<ManagedPackageManager, (selection: PackageManagerSelection) => void> = {
  npm: installNpm,
  pnpm: installWithCorepack,
  yarn: installWithCorepack,
  bun: installBun,
};

export function installPackageManager(selection: PackageManagerSelection): void {
  installers[selection.manager](selection);
}
