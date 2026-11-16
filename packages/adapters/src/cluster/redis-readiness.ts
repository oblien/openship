import { shellQuote } from "@repo/core";

/** A quorum can exist while Sentinel has forgotten every failover candidate
 * after reconciliation. All voters must discover the current primary, its
 * replicas and each other before provisioning is reported as ready. */
export function redisSentinelReadiness(namespace: string, replicas: number): string {
  if (!Number.isSafeInteger(replicas) || replicas < 2 || replicas > 8)
    throw new Error("The Redis readiness check requires a valid replica count.");
  const primary = `database-master.${namespace}.svc.cluster.local`;
  const voters = [0, 1, 2].map(
    (index) =>
      `database-sentinel-${index}.database-sentinel-headless.${namespace}.svc.cluster.local`,
  );
  return `(
primary_info="$(timeout 10 redis-cli --raw -h ${shellQuote(primary)} INFO server)" || exit 1
primary_id="$(printf '%s\\n' "$primary_info" | tr -d '\\r' | sed -n 's/^run_id://p')"
printf '%s\\n' "$primary_id" | grep -Eq '^[0-9a-f]{40}$' || exit 1
for voter in ${voters.map(shellQuote).join(" ")}; do
  quorum="$(timeout 10 redis-cli --raw -h "$voter" -p 26379 SENTINEL CKQUORUM mymaster)" || exit 1
  printf '%s\\n' "$quorum" | grep -q '^OK 3 usable Sentinels\\.' || exit 1
  master="$(timeout 10 redis-cli --raw -h "$voter" -p 26379 SENTINEL MASTER mymaster)" || exit 1
  printf '%s\\n' "$master" | tr -d '\\r' | awk -v primary="$primary_id" -v replicas=${replicas} '
    NR % 2 == 1 { key = $0; next }
    { values[key] = $0 }
    END { exit !(values["flags"] == "master" && values["runid"] == primary &&
      values["num-slaves"] == replicas && values["num-other-sentinels"] == 2) }
  ' || exit 1
done
)`;
}
