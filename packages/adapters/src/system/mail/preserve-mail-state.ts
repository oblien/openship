import { posix } from "node:path";
import type { CommandExecutor } from "../../types";
import { MAIL_CONTAINER_MOUNTS, MAIL_HOST_STATE_DIR } from "../../infra/mail-container";
import { sq } from "../local-shell";
import { elevatedExecutor } from "../elevated-executor";
import { resolveEnvironment } from "../environment";

/** Quiesce SQLite and its log writers before migrating their writable layer.
 * A failed copy restores the same container; replacement has not started yet. */
export async function preserveMailState(
  executor: CommandExecutor,
  container: string,
): Promise<void> {
  const raw = await executor.exec(
    `docker inspect -f '{{.Id}}\t{{.State.Running}}\t{{json .Mounts}}' ${sq(container)}`,
  );
  const [id, running, encoded] = raw.trim().split("\t");
  if (!id || !/^[a-f0-9]{64}$/.test(id) || !["true", "false"].includes(running ?? ""))
    throw new Error(
      "Could not verify the mail container before preserving its state; update refused.",
    );
  const mounted: unknown = JSON.parse(encoded ?? "null");
  if (
    !Array.isArray(mounted) ||
    mounted.some((m) => !m || typeof m.Destination !== "string" || typeof m.Source !== "string")
  )
    throw new Error("Could not verify the mail container mounts; update refused.");
  const missing = MAIL_CONTAINER_MOUNTS.filter((m) => m.preserveFromContainer).filter((m) => {
    const prior = mounted.find((p) => p.Destination === m.container);
    if (!prior) return true;
    if (prior.Type !== "bind" || posix.normalize(prior.Source) !== m.host)
      throw new Error(
        `Mail state at ${m.container} uses a custom mount; preserve it before updating.`,
      );
    return false;
  });
  if (!missing.length) return;
  const profile = await resolveEnvironment(executor);
  if (!profile.isRoot && !profile.canSudo)
    throw new Error("Preserving mail state requires root or passwordless sudo; update refused.");
  const root = profile.isRoot ? executor : elevatedExecutor(executor);
  // sudo must not select root's different Docker context/daemon. These commands
  // need filesystem privilege, not registry credentials; pin the login daemon.
  let docker = "docker";
  if (!profile.isRoot) {
    const endpoint = (
      await executor.exec(
        `if [ -n "$(printenv DOCKER_CONTEXT)" ] || [ -z "$(printenv DOCKER_HOST)" ]; then
        docker context inspect --format '{{.Endpoints.docker.Host}}' "$(docker context show)"
      else printenv DOCKER_HOST; fi`,
      )
    ).trim();
    if (!/^unix:\/\/\/[^\0\r\n]+$/.test(endpoint))
      throw new Error(
        "Mail state migration requires the deployment host's local Docker socket; update refused.",
      );
    docker = `docker --host ${sq(endpoint)}`;
  }
  const paths = missing.map((m) => ({ ...m, name: posix.basename(m.host) }));
  // One target-host transaction: copy every directory before publishing any.
  // Roll back published directories if a later rename fails, never merge over
  // existing host data. The source container is removed only by the caller.
  await root.exec(
    `sh -c ${sq(`set -eu
umask 077
stage=$(mktemp -d ${sq(`${MAIL_HOST_STATE_DIR}/.state-migration.XXXXXX`)})
completed=false
stopped=false
moved=''
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$completed" != true ]; then
    for name in $moved; do
      mv -T ${sq(MAIL_HOST_STATE_DIR)}/"$name" "$stage/$name" || true
    done
    if [ "$stopped" = true ]; then ${docker} start ${sq(id)} >/dev/null || true; fi
  fi
  rm -rf -- "$stage"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
${paths
  .map(
    (
      m,
    ) => `if [ -L ${sq(m.host)} ] || { [ -e ${sq(m.host)} ] && { [ ! -d ${sq(m.host)} ] || [ -n "$(ls -A ${sq(m.host)})" ]; }; }; then
  echo ${sq(`Existing mail state at ${m.host} would be overwritten; update refused.`)} >&2
  exit 1
fi`,
  )
  .join("\n")}
${running === "true" ? `stopped=true\n${docker} stop -t 30 ${sq(id)} >/dev/null` : ""}
${paths.map((m) => `${docker} cp -a ${sq(`${id}:${m.container}`)} "$stage/${m.name}"`).join("\n")}
${paths
  .map(
    (m) => `if [ -d ${sq(m.host)} ]; then rmdir ${sq(m.host)}; fi
mv -T "$stage/${m.name}" ${sq(m.host)}
moved="$moved ${m.name}"`,
  )
  .join("\n")}
completed=true
`)}
`,
    { timeout: 600_000 },
  );
}
