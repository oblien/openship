import { DEFAULT_CONTAINER_LOG_ARGS } from "../../container-logging";
import { EDGE_CONTAINER_MOUNTS } from "../../infra/openresty-lua";
import { sq } from "../local-shell";
import { OPENSHIP_LABEL } from "../port-owner";

export type EdgeContainerMount = Readonly<{ host: string; container: string }>;

/** Shared Docker arguments for fresh installs and staged replacements. */
export function buildEdgeRunCommand(
  container: string,
  image: string,
  edgeMounts: readonly EdgeContainerMount[] = EDGE_CONTAINER_MOUNTS,
  identityLabels: Readonly<Record<string, string>> = {},
  action: "run" | "create" = "run",
): string {
  const mounts = edgeMounts
    .map(
      // `:z` relabels for SELinux-enforcing hosts; a no-op elsewhere.
      (m) => `-v ${sq(`${m.host}:${m.container}:z`)}`,
    )
    .join(" ");
  return [
    action === "run" ? "docker run -d" : "docker create",
    `--name ${sq(container)}`,
    "--network host",
    "--restart unless-stopped",
    ...DEFAULT_CONTAINER_LOG_ARGS,
    ...[
      OPENSHIP_LABEL.project,
      OPENSHIP_LABEL.deployment,
      OPENSHIP_LABEL.service,
      OPENSHIP_LABEL.role,
      "com.docker.compose.project",
      "com.docker.compose.service",
      "com.docker.compose.container-number",
    ]
      .filter((key) => Object.hasOwn(identityLabels, key))
      .map((key) => `--label ${sq(`${key}=${identityLabels[key]}`)}`),
    mounts,
    sq(image),
  ].join(" ");
}
