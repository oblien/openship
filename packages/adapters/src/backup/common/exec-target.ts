/**
 * The precondition every logical-dump producer shares: can we actually run a
 * command inside this service right now?
 *
 * A dump has to exec INSIDE the database — `pg_dump`, `mysqldump`, `mongodump`,
 * `redis-cli BGSAVE` all run there — so a producer that selects itself without a
 * usable container cannot do anything except fail at the exec. And failing there is
 * strictly worse than not selecting: `resolveProducerForService` falls through to
 * the volume producer, which for a stopped database is the COLD and therefore
 * BETTER artifact. So a wrong answer here turns a good backup into no backup.
 *
 * Each producer used to check a different subset of the same two facts, which is
 * how three of the four ended up wrong:
 *
 *   pg_dump      `!!containerId`                    — presence, but not running
 *   mysql_dump   credentials only                   — no container check at all
 *   mongo_dump   image only                          — neither
 *   redis_rdb    image only                          — neither
 *
 * So an undeployed MariaDB with `MYSQL_ROOT_PASSWORD` set, or any mongo/redis
 * service that had never deployed, selected a dump producer over the volume
 * fallback and the run failed. One predicate instead, so the next producer cannot
 * invent a fifth subset.
 *
 * `containerRunning` UNKNOWN (`null`/`undefined`) counts as usable, deliberately.
 * A cloud workspace and a bare host cannot be enumerated, so unknown is the normal
 * answer there — reading it as "stopped" would take the logical dump away from
 * every non-docker source and silently downgrade them all to volume snapshots.
 * Only an observed `false` withholds the dump.
 */

import type { ServiceHandle } from "../types";

/** True when a logical dump can exec inside this service's container. */
export function canExecInService(service: ServiceHandle): boolean {
  return !!service.containerId && service.containerRunning !== false;
}
