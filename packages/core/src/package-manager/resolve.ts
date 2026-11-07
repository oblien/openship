import {
  PACKAGE_MANAGER_DEFAULTS as defaults,
  type ManagedPackageManager,
} from "../package-manager-version";
import type { PackageManagerDiscovery } from "./discover";
import { versionOf } from "./execute";

export interface PackageManagerSelection {
  manager: ManagedPackageManager;
  pin: string;
  version: string;
}

export function resolvePackageManager(
  manager: ManagedPackageManager,
  discovery: PackageManagerDiscovery,
  versionOverride?: string,
): PackageManagerSelection {
  let { pin } = discovery;
  if (versionOverride) {
    if (!/^\d+\.\d+\.\d+$/.test(versionOverride))
      throw new Error("A package-manager version override requires an exact stable version.");
    const declaredVersion = pin?.slice(manager.length + 1).split("+sha")[0];
    if (pin?.includes("+sha") && declaredVersion !== versionOverride)
      throw new Error(
        "A version override cannot discard a packageManager integrity requirement. Update the repository pin first.",
      );
    const declared = declaredVersion
      ?.match(/^(\d+)\.(\d+)\.(\d+)/)
      ?.slice(1)
      .map(Number);
    const selected = versionOverride.split(".").map(Number);
    const difference = declared?.findIndex((value, index) => value !== selected[index]) ?? -1;
    if (declared && difference >= 0 && declared[difference]! > selected[difference]!)
      throw new Error(
        `The repository requires ${pin}, newer than the selected ${manager} version ${versionOverride}. ` +
          `Select a compatible version; the build will not downgrade ${manager}.`,
      );
    // Preserve integrity when the selected version already matches the pin.
    pin = pin?.includes("+sha") ? pin : `${manager}@${versionOverride}`;
  }
  const { lock, yarnLock, yarnPath, scriptPolicy, ignoreYarnPath } = discovery;
  let localYarnVersion: string | undefined;
  if (manager === "yarn" && yarnPath && !ignoreYarnPath) {
    localYarnVersion = versionOf(process.execPath, [yarnPath, "--version"]);
    if (!localYarnVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(localYarnVersion))
      throw new Error("Cannot verify the repository yarnPath version.");
  }
  if (!pin) {
    let version: string | undefined = defaults[manager];
    if (manager === "pnpm") {
      if (scriptPolicy)
        throw new Error(
          "Pin packageManager to pnpm@X.Y.Z so the managed build preserves your explicit dependency-script policy.",
        );
      const versions: Record<string, string> = {
        "9": "9.15.9",
        "9.0": "9.15.9",
        "6": "8.15.9",
        "6.0": "8.15.9",
        "5.4": "7.33.7",
        "5.3": "6.35.1",
      };
      version = lock === undefined ? defaults.pnpm : versions[lock];
      if (!version)
        throw new Error("Unsupported pnpm lockfile version; set packageManager to pnpm@X.Y.Z.");
    }
    if (manager === "yarn") {
      if (localYarnVersion) version = localYarnVersion;
      else if (yarnLock && /(?:^|\n)__metadata:/.test(yarnLock)) {
        const metadata = yarnLock.match(/__metadata:\s*\n\s+version:\s*(\d+)/);
        const versions: Record<string, string> = { "4": "2.4.3", "6": "3.8.7", "8": "4.9.2" };
        version = metadata ? versions[metadata[1]] : undefined;
        if (!version)
          throw new Error("Unsupported Yarn lockfile; set packageManager to yarn@X.Y.Z.");
      } else if (yarnLock && !yarnLock.includes("# yarn lockfile v1"))
        throw new Error("Unsupported Yarn lockfile; set packageManager to yarn@X.Y.Z.");
    }
    pin = manager + "@" + version;
  }
  const version = pin.slice(manager.length + 1).split("+sha")[0];
  if (localYarnVersion && localYarnVersion !== version)
    throw new Error("yarnPath and the declared package-manager version disagree.");
  return { manager, pin, version };
}
