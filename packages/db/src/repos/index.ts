export { createUserRepo, type User, type NewUser } from "./user.repo";
export { createSessionRepo, type Session } from "./session.repo";
export { createAccountRepo, type Account } from "./account.repo";

// ─── Convenience: pre-bound repos using the singleton db ─────────────────────

import { db } from "../client";
import { createUserRepo } from "./user.repo";
import { createSessionRepo } from "./session.repo";
import { createAccountRepo } from "./account.repo";

/**
 * Pre-bound repository instances using the singleton `db`.
 *
 * Usage:
 *   import { repos } from "@repo/db";
 *   const user = await repos.user.findByEmail("test@example.com");
 *
 * For testing, create isolated repos with `createUserRepo(testDb)` etc.
 */
export const repos = {
  user: createUserRepo(db),
  session: createSessionRepo(db),
  account: createAccountRepo(db),
} as const;
