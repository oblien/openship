import { createHash, randomUUID } from "node:crypto";
import type { CommandExecutor } from "../../types";
import { OPENRESTY_MGMT_PORT } from "../../infra/openresty-lua";
import type { SystemLogCallback } from "../types";
import { sq } from "../local-shell";
import { runReliable } from "../remote-journal";
import { EDGE_TRANSITION_PREFIX } from "../port-owner";
import { invalidateEdgeContainer } from "./detect";
import { buildEdgeRunCommand, type EdgeContainerMount } from "./edge-container-command";

interface EdgeReplacement {
  container: string;
  image: string;
  mounts: readonly EdgeContainerMount[];
  predecessor: { id: string; labels: Record<string, string> };
  verifyTimeoutMs?: number;
}

/** One host-owned transaction. No SSH round trip separates stop, start and rollback. */
export function edgeReplacementCommand(opts: EdgeReplacement): string {
  const { container, image, predecessor, mounts } = opts;
  if (!/^[a-f0-9]{64}$/.test(predecessor.id)) throw new Error("Invalid predecessor identity");
  // Reserve the candidate, then retain the config-check container until the
  // transaction ends. Its name remains reserved while the candidate is renamed,
  // so another control plane cannot start an overlapping cutover on this daemon.
  const prefix =
    EDGE_TRANSITION_PREFIX + createHash("sha256").update(container).digest("hex").slice(0, 16);
  const candidate = `${prefix}-next`;
  const backup = `${prefix}-previous`;
  const preflight = `${prefix}-check`;
  const create = buildEdgeRunCommand(candidate, image, mounts, predecessor.labels, "create");
  const seconds = Math.max(1, Math.min(60, Math.ceil((opts.verifyTimeoutMs ?? 30_000) / 1000)));

  return `sh -c ${sq(`set -eu
old=${sq(predecessor.id)}
name=${sq(container)}
backup=${sq(backup)}
candidate=''
check=''
cutover=0
committed=0

# Bound Docker CLI calls on Linux and macOS without requiring GNU timeout.
bounded() {
  "$@" & command_pid=$!
  (
    trap - 0
    sleep 20 & timer_pid=$!
    trap 'kill "$timer_pid" 2>/dev/null || :; exit 0' TERM INT
    wait "$timer_pid"
    kill -KILL "$command_pid" 2>/dev/null || :
  ) & watchdog_pid=$!
  command_status=0
  wait "$command_pid" || command_status=$?
  kill "$watchdog_pid" 2>/dev/null || :
  wait "$watchdog_pid" 2>/dev/null || :
  return "$command_status"
}
healthy() {
  health_deadline=$(( $(date +%s) + ${seconds} ))
  while [ "$(date +%s)" -lt "$health_deadline" ]; do
    if [ "$(bounded docker inspect -f '{{.State.Status}}' "$1")" = running ] &&
      bounded docker exec "$1" sh -c 'openresty -t >/dev/null 2>&1 && curl -fsS --max-time 2 http://127.0.0.1:${OPENRESTY_MGMT_PORT}/health >/dev/null && curl -sS --max-time 2 -o /dev/null http://127.0.0.1:80/'; then
      return 0
    fi
    sleep 1
  done
  return 1
}
finish() {
  status=$?
  trap - 0 HUP INT TERM
  # Never touch a candidate belonging to another transaction.
  if [ -n "$candidate" ] && [ "$committed" = 0 ]; then
    bounded docker rm -f "$candidate" >/dev/null 2>&1 || :
  fi
  if [ "$cutover" = 1 ] && [ "$committed" = 0 ]; then
    echo 'Edge replacement failed; restoring the previous container.' >&2
    if [ "$(bounded docker inspect -f '{{.Name}}' "$old")" != "/$name" ]; then
      bounded docker rename "$old" "$name" || :
    fi
    if bounded docker start "$old" >/dev/null && healthy "$old"; then
      echo 'Previous edge restored.' >&2
      status=20
    else
      echo "Edge recovery failed. Previous container retained: $old ($backup)." >&2
      status=21
    fi
  elif [ "$status" != 0 ]; then
    echo 'Replacement was not activated; the previous edge was not stopped.' >&2
    status=10
  fi
  # Release the reservation last, and only by the identity we created.
  if [ -n "$check" ]; then bounded docker rm -f "$check" >/dev/null || :; fi
  exit "$status"
}
trap finish 0
trap 'exit 1' HUP INT TERM

[ "$(bounded docker inspect -f '{{.Id}}' "$name")" = "$old" ] || exit 1
candidate=$(bounded ${create})
# -t validates without binding ports. Keep host networking for upstream DNS.
check=$(bounded docker create --name ${sq(preflight)} --network host --volumes-from "$candidate:ro" --entrypoint openresty ${sq(image)} -t)
# Hold the reservation while checking for a predecessor retained after cleanup
# failed. Refuse before stopping traffic, including when Docker cannot answer.
retained=$(bounded docker ps -a --filter "name=^/$backup$" --format '{{.ID}}')
if [ -n "$retained" ]; then
  echo "A retained predecessor still occupies $backup. Inspect it before retrying; this replacement has not stopped the current edge." >&2
  exit 1
fi
bounded docker start -a "$check"
[ "$(bounded docker inspect -f '{{.Id}}' "$name")" = "$old" ] || exit 1
echo 'Replacement config validated. Switching edge containers...'
cutover=1
bounded docker stop --time 10 "$old" >/dev/null
bounded docker rename "$old" "$backup"
bounded docker rename "$candidate" "$name"
bounded docker start "$candidate" >/dev/null
healthy "$candidate"
committed=1
if ! bounded docker rm "$old" >/dev/null; then
  echo "New edge is healthy; could not remove stopped predecessor $old." >&2
fi
echo 'Edge replacement is healthy.'
`)}`;
}

export async function replaceEdgeContainer(
  executor: CommandExecutor,
  opts: EdgeReplacement & { onLog: SystemLogCallback },
): Promise<{ swapped: boolean; down: boolean }> {
  const emit = (message: string, level: "info" | "warn" = "info") =>
    opts.onLog({ timestamp: new Date().toISOString(), level, message });
  emit(
    "Validating the replacement edge. Activation and rollback run on the server, even if this connection drops.",
  );
  try {
    const result = await runReliable(
      () => Promise.resolve(executor),
      `edge-update-${randomUUID()}`,
      edgeReplacementCommand(opts),
      {
        timeoutMs: 180_000,
        waitSecs: 5,
        onRetryableDrop: () =>
          emit(
            "Connection interrupted. Any edge activation already started will finish or roll back on the server. Reconnecting to check the result...",
            "warn",
          ),
      },
    );
    for (const line of result.stdout.split("\n").filter(Boolean)) emit(line);
    for (const line of result.stderr.split("\n").filter(Boolean)) emit(line, "warn");
    if (result.code === 0) return { swapped: true, down: false };
    if (result.code === 10 || result.code === 20) return { swapped: false, down: false };
    if (result.code === 21) return { swapped: false, down: true };
    throw new Error(
      "The edge update did not return a confirmed result; reconnect and recheck routing.",
    );
  } finally {
    invalidateEdgeContainer(executor);
  }
}
