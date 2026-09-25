/**
 * Run inside the deployed SaaS API environment. Uses a separate, read-verified
 * PostgreSQL connection: never opens the live API's PGlite or runs migrations.
 */
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { AppError, PLAN_IDS, type PlanTierId } from "@repo/core";
import { createDatabase, createAdvisoryLocks, createBillingPlanGrantRepo } from "@repo/db/factory";

const usage = `Complimentary Openship Cloud plans (no customer charge).

  bun run --cwd apps/api billing:grant grant --email user@example.com --plan pro --reason "Partner account"
  bun run --cwd apps/api billing:grant grant --email user@example.com --plan pro --reason "Partner account" --dry-run
  bun run --cwd apps/api billing:grant show --email user@example.com
  bun run --cwd apps/api billing:grant revoke --email user@example.com

Options:
  --organization <id>   Select an owned workspace; defaults to the personal workspace.
  --plan <tier>         Grant a catalog plan with a finite monthly allowance (default: pro).
  --reason <text>       Required when granting, saved with the operator identity.
  --operator <name>     Audit identity (default: current OS user).
  --expires <ISO date>  Optional expiry; otherwise renews monthly until revoked.
  --dry-run            Read and preview only; no provider or database writes.

Run on the SaaS with CLOUD_MODE=true, DATABASE_URL and OBLIEN_CLIENT_ID/SECRET.
The API must be deployed with the plan-grant migration first. The CLI verifies
the schema and never creates a checkout, charges a card, or replaces a paid plan.`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, email: { type: "string" }, plan: { type: "string" },
    organization: { type: "string" }, reason: { type: "string" }, operator: { type: "string" },
    expires: { type: "string" }, "dry-run": { type: "boolean" },
  } });
  if (values.help || !positionals.length) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "grant" && command !== "show" && command !== "revoke")) {
    throw new AppError("Expected grant, show, or revoke. Use --help for usage.", 400, "USAGE");
  }
  const email = values.email?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("A valid --email is required", 400, "USAGE");
  const plan = (values.plan ?? "pro") as PlanTierId;
  if (!PLAN_IDS.includes(plan) || plan === "free") throw new AppError("--plan must name a paid catalog tier", 400, "USAGE");
  if (command === "grant" && !values.reason?.trim()) throw new AppError("--reason is required when granting a plan", 400, "USAGE");
  const expiresAt = values.expires ? new Date(values.expires) : null;
  if (expiresAt && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(values.expires!) || !Number.isFinite(expiresAt.getTime()))) {
    throw new AppError("--expires must be an ISO timestamp with a timezone", 400, "USAGE");
  }
  if (process.env.CLOUD_MODE !== "true" || !process.env.DATABASE_URL || !process.env.OBLIEN_CLIENT_ID || !process.env.OBLIEN_CLIENT_SECRET) {
    throw new AppError("Run in the SaaS API environment with CLOUD_MODE, DATABASE_URL and Oblien credentials configured", 400, "CONFIGURATION");
  }
  const { getOblienBillingApi } = await import("@repo/platform/engine/lib/oblien-client");
  const { runPlanGrantCommand } = await import("@repo/platform/engine/modules/billing/billing-plan-grant.operator");
  const connection = await createDatabase({ driver: "pg", url: process.env.DATABASE_URL, migrations: "verify", poolMax: 3, connectTimeoutMs: 5_000 });
  try {
    const locks = createAdvisoryLocks({ getDriver: () => "pg", getPgPool: () => connection.pool!, poolMax: 3 });
    const result = await runPlanGrantCommand({
      command, email, organizationId: values.organization, plan, expiresAt,
      operator: values.operator?.trim() || userInfo().username,
      reason: values.reason ?? "", dryRun: values["dry-run"] ?? false,
    }, { grants: createBillingPlanGrantRepo(connection.db), billing: getOblienBillingApi(), lock: locks.withAdvisoryLock });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await connection.close();
  }
}

main().catch(error => {
  // Never serialize raw provider/database errors, SQL parameters, or credentials.
  console.error(error instanceof AppError ? `${error.code}: ${error.message}`
    : "Plan grant failed. Check the deployed schema, database connection and provider availability; retrying the same grant is safe.");
  process.exitCode = 1;
});
