import type { ManagedPackageManager } from "../package-manager-version";
import { discoverPackageManager } from "./discover";
import { resolvePackageManager, type PackageManagerSelection } from "./resolve";
import { installPackageManager } from "./install";
import { versionOf } from "./execute";

function verifyPackageManager({ manager, version }: PackageManagerSelection): void {
  const actual = versionOf(manager);
  if (actual !== version)
    throw new Error(
      "Package-manager verification failed: expected " +
        manager +
        "@" +
        version +
        ", got " +
        (actual || "no executable") +
        ".",
    );
  console.log("[openship] Verified package manager: " + manager + "@" + actual);
}

export function bootstrapPackageManager(
  manager: ManagedPackageManager,
  versionOverride?: string,
): void {
  const discovery = discoverPackageManager(manager);
  const selection = resolvePackageManager(manager, discovery, versionOverride);
  if (versionOverride && discovery.pin && discovery.pin !== selection.pin)
    console.log(
      "[openship] Explicit package-manager selection " +
        selection.pin +
        " overrides repository " +
        discovery.pin,
    );
  console.log("[openship] Selected package manager: " + selection.pin);
  installPackageManager(selection);
  verifyPackageManager(selection);
}
