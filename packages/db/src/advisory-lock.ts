import { getDriver, getPgPool, PG_POOL_MAX } from "./client";
import { createAdvisoryLocks } from "./advisory-lock-factory";
export { hashStringToInt, type AdvisoryLockHandle } from "./advisory-lock-factory";

const locks = createAdvisoryLocks({ getDriver, getPgPool, poolMax: PG_POOL_MAX });
export const withAdvisoryLock = locks.withAdvisoryLock;
export const tryAcquireAdvisoryLock = locks.tryAcquireAdvisoryLock;
