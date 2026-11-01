import {
  RUNTIME_VERSION_COMMANDS,
  SECURITY_RUNTIMES,
  type SecurityRuntime,
  type SecurityRuntimeEvidence,
} from "@repo/core";

export function runtimeVersionProbe(runtimes: readonly SecurityRuntime[]): string {
  return (
    "unset NODE_OPTIONS BUN_OPTIONS RUBYOPT JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS PYTHONSTARTUP PYTHONPATH; " +
    Object.entries(RUNTIME_VERSION_COMMANDS)
      .filter(([runtime]) => runtimes.includes(runtime as SecurityRuntime))
      .map(
        ([runtime, command]) =>
          `if command -v ${command.split(" ")[0]} >/dev/null 2>&1; then printf '\\nOPENSHIP_RUNTIME_${runtime}\\n'; ${command} 2>&1 | head -c 1024; fi`,
      )
      .join("; ")
  );
}
export const RUNTIME_VERSION_PROBE = runtimeVersionProbe(SECURITY_RUNTIMES);

export function parseRuntimeProbe(
  output: string,
  serviceId: string | null,
): SecurityRuntimeEvidence[] {
  const observations: SecurityRuntimeEvidence[] = [];
  for (const runtime of SECURITY_RUNTIMES) {
    const section = output.split(`OPENSHIP_RUNTIME_${runtime}\n`)[1]?.split("OPENSHIP_RUNTIME_")[0];
    if (!section) continue;
    const firstLine = section.trimStart().split(/\r?\n/)[0]!;
    const versions =
      runtime === "go"
        ? [firstLine.match(/\bgo(\d+\.\d+\.\d+)(?=\s|$)/)?.[1]].filter(
            (value): value is string => !!value,
          )
        : runtime === "dotnet"
          ? [
              ...section.matchAll(
                /Microsoft\.(?:NETCore|AspNetCore)\.App (\d+\.\d+\.\d+)(?=\s|$)/g,
              ),
            ].map((match) => match[1]!)
          : [firstLine.match(/(?:^|[\s"v])((?:\d+\.){2}\d+)(?=\s|"|$)/)?.[1]].filter(
              (value): value is string => !!value,
            );
    for (const version of new Set(versions)) observations.push({ serviceId, runtime, version });
  }
  return observations;
}
