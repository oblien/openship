/** Passive native composition entry. No environment loading or default database. */
export { createDatabase, type DatabaseConnection, type DatabaseOptions, type Database, type DatabaseTransaction, type Driver } from "./connection";
export { createRepositories, type Repositories } from "./repos/factory";
export { createBillingPlanGrantRepo, type BillingPlanGrant, type BillingPlanGrantRepo } from "./repos/billing-plan-grant.repo";
export { createAdvisoryLocks, hashStringToInt, type AdvisoryLockHandle } from "./advisory-lock-factory";
export * as schema from "./schema";
export { releaseExitedWorkerLock } from "./pglite-lock";
