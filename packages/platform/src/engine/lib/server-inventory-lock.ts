import { createProvisionLock } from "./provision-lock";

/**
 * Enrollment and server teardown must share one critical section. Otherwise a
 * cluster can claim a server after teardown's membership check but before its
 * workloads are removed. Reuse the local mutex + PostgreSQL advisory lock.
 *
 * Organization scope also bounds a multi-server enrollment to one DB connection,
 * rather than holding an advisory-lock connection for each selected member.
 */
export function withServerInventoryLock<T>(
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return createProvisionLock(`server-inventory:${organizationId}`).run(fn);
}
