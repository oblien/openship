import { getDockerRuntimeProbe, type DockerRuntimeProbe } from "@repo/core";
import type { BuildConfig } from "../../types";

/** Commands measure the actual images, not tags supplied by their publisher. */
const probes: Record<DockerRuntimeProbe, string> = {
  node: `node -p 'process.versions.modules'`,
  bun: `bun -e 'console.log(Bun.version)'`,
  python: `python -c 'import sys; print("%s.%s" % sys.version_info[:2])'`,
  ruby: `ruby -e 'puts RUBY_VERSION.split(".").first(2).join(".")'`,
  java: `command -v java >/dev/null && java -XshowSettings:properties -version 2>&1 | awk '/java.specification.version =/ { print $3; found=1 } END { if (!found) exit 1 }'`,
  dotnet: `command -v dotnet >/dev/null && dotnet --list-runtimes | awk '$1 == "Microsoft.NETCore.App" { split($2, v, "."); print v[1] "." v[2]; found=1; exit } END { if (!found) exit 1 }'`,
  elixir: `elixir -e 'IO.puts(System.version()); IO.puts(System.otp_release())'`,
};
const requirementsPath = "/tmp/openship-runtime.requirements";

function fingerprint(config: BuildConfig): string | undefined {
  if (!config.runtimeImageOverride) return undefined;
  const probe = getDockerRuntimeProbe(config.stack, config.packageManager);
  if (!probe) return undefined; // Compiled-native apps are verified by deploy readiness.
  const libc =
    probe === "java"
      ? ""
      : ` && if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1; then printf 'musl\\n'; else getconf GNU_LIBC_VERSION; fi`;
  return `${probes[probe]} && uname -m${libc}`;
}

export function builderCompatibilityLines(config: BuildConfig): string[] {
  const command = fingerprint(config);
  return command ? [`RUN { ${command}; } > ${requirementsPath}`] : [];
}

export function runtimeCompatibilityLines(config: BuildConfig): string[] {
  const command = fingerprint(config);
  if (!command) return [];
  return [
    `COPY --from=builder ${requirementsPath} ${requirementsPath}`,
    `RUN openship_runtime_actual="$( ${command} )" && openship_runtime_expected="$(cat ${requirementsPath})" && if [ "$openship_runtime_actual" != "$openship_runtime_expected" ]; then printf 'Openship runtime image is incompatible with the builder. Expected:\\n%s\\nActual:\\n%s\\n' "$openship_runtime_expected" "$openship_runtime_actual" >&2; exit 1; fi && rm ${requirementsPath}`,
  ];
}
