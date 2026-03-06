// ─── Database client ─────────────────────────────────────────────────────────
export { db, getDriver, type Database, type Driver } from "./client";

// ─── Schema (table definitions) ──────────────────────────────────────────────
export * as schema from "./schema";

// ─── Repositories (all DB access goes through here) ──────────────────────────
export {
  repos,
  createUserRepo,
  createSessionRepo,
  createAccountRepo,
  type User,
  type NewUser,
  type Session,
  type Account,
} from "./repos";

// ─── Drizzle operators (re-exported for convenience) ─────────────────────────
export {
  eq,
  ne,
  and,
  or,
  not,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  between,
  desc,
  asc,
  sql,
  count,
} from "drizzle-orm";
