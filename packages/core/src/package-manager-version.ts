/** Fixed defaults for repositories that do not declare their toolchain. */
export const PACKAGE_MANAGER_DEFAULTS = {
  npm: "9.9.4",
  pnpm: "9.15.9",
  yarn: "1.22.22",
  bun: "1.4.4",
} as const;
export type ManagedPackageManager = keyof typeof PACKAGE_MANAGER_DEFAULTS;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Shared declaration parser for detection and the bundled build bootstrap. */
export function declaredPackageManagerPin(pkg: unknown, manager: string): string | undefined {
  const manifest = record(pkg);
  const declared = manifest?.packageManager;
  if (declared !== undefined) {
    if (
      typeof declared !== "string" ||
      !/^(npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+sha(?:224|256|384|512)\.[0-9a-f]+)?$/.test(
        declared,
      ) ||
      !declared.startsWith(manager + "@")
    ) {
      throw new Error(
        `The build uses ${manager}; set packageManager to an exact ${manager}@X.Y.Z or select the matching package manager.`,
      );
    }
    return declared;
  }
  const engineDeclaration = record(manifest?.devEngines)?.packageManager;
  const engine = record(engineDeclaration);
  if (engineDeclaration !== undefined) {
    if (
      engine?.name !== manager ||
      typeof engine?.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(engine.version)
    )
      throw new Error(
        `Set an exact packageManager ${manager}@X.Y.Z to preserve devEngines.packageManager during managed builds.`,
      );
    return manager + "@" + engine.version;
  }
}

export function bunBuildImage(pkg: unknown): string {
  const pin = declaredPackageManagerPin(pkg, "bun");
  if (pin?.includes("+sha"))
    throw new Error(
      "Bun packageManager integrity pins require a custom toolchain; use an exact Bun version with a pinned image digest.",
    );
  return `oven/bun:${pin?.slice(4) ?? PACKAGE_MANAGER_DEFAULTS.bun}`;
}
