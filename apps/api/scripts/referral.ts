/** Run only inside the trusted Cloud API environment; never opens the live embedded database. */
import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { createDatabase, createRepositories } from "@repo/db/factory";
import { AppError } from "@repo/contracts";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      email: { type: "string" },
      "participant-key": { type: "string" },
      "minimum-cents": { type: "string" },
      enabled: { type: "string" },
      payout: { type: "string" },
      reference: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      offset: { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(`Referral administration. Run on the Cloud API with its normal environment.
  bun run referral queue [--status pending|processing|paid|rejected|canceled] [--limit 25] [--offset 0]
  bun run referral show --email person@example.com [--offset 0]
  bun run referral configure --email person@example.com --minimum-cents 5000 --enabled true --reason "Approved terms"
  bun run referral approve --email person@example.com --payout <id> --reason "Verified recipient and earnings"
  bun run referral reject --email person@example.com --payout <id> --reason "Purchase refunded"
  bun run referral destination --email person@example.com --payout <id> --reason "Preparing manual payment"
  bun run referral paid --email person@example.com --payout <id> --reference <bank-transfer-id> --reason "Transfer completed"
Approve reserves the request for manual payment. This command never sends money.
Use paid only to record a completed external transfer. Never pay a pending or rejected request.
An operator identity is recorded (defaults to the current OS user).
Queue lists account emails for review. Deleted accounts retain their participant key;
use --participant-key <key> instead of --email to reconcile their existing requests.`);
    return;
  }
  const command = positionals[0];
  const queue = command === "queue";
  if (
    positionals.length !== 1 ||
    (queue
      ? Boolean(values.email || values["participant-key"])
      : Boolean(values.email) === Boolean(values["participant-key"]))
  )
    throw new AppError(
      "Queue takes no account selector. Other commands require exactly one --email or --participant-key",
      400,
      "USAGE",
    );
  if (
    process.env.CLOUD_MODE !== "true" ||
    !process.env.DATABASE_URL ||
    !process.env.OBLIEN_CLIENT_ID ||
    !process.env.OBLIEN_CLIENT_SECRET
  )
    throw new AppError(
      "Run in the Cloud API environment with PostgreSQL and Oblien credentials configured",
      400,
      "CONFIGURATION",
    );
  const { env, runtimeTarget } = await import("@repo/platform/engine/config/env");
  const { getOblienBillingApi } = await import("@repo/platform/engine/lib/oblien-client");
  const { runReferralOperator, readReferralPayoutQueue } =
    await import("@repo/platform/engine/modules/referrals/referral.operator");
  const connection = await createDatabase({
    driver: "pg",
    url: process.env.DATABASE_URL,
    migrations: "verify",
    poolMax: 2,
    connectTimeoutMs: 5000,
  });
  try {
    if (queue) {
      const result = await readReferralPayoutQueue(
        {
          ...(values.status !== undefined ? { status: values.status } : {}),
          ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
          offset: Number(values.offset ?? 0),
        },
        env.REFERRAL_NAMESPACE,
        getOblienBillingApi(),
      );
      const { referralQueueAccounts } = await import("./referral-accounts");
      const accounts = await referralQueueAccounts(
        connection.db,
        result.items.map((item) => item.participantKey),
      );
      console.log(
        JSON.stringify(
          {
            ...result,
            items: result.items.map((item) => ({
              ...item,
              account: accounts.get(item.participantKey) ?? null,
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    const input =
      command === "show"
        ? { command, offset: Number(values.offset ?? 0) }
        : {
            command,
            operator: values.operator || userInfo().username,
            reason: values.reason,
            ...(command === "configure"
              ? {
                  minimumCents: Number(values["minimum-cents"]),
                  enabled:
                    values.enabled === "true"
                      ? true
                      : values.enabled === "false"
                        ? false
                        : undefined,
                }
              : {
                  payoutId: values.payout,
                  ...(command === "paid" ? { paymentReference: values.reference } : {}),
                }),
          };
    const account = values.email
      ? await createRepositories(connection.db).user.findByEmail(values.email.trim())
      : undefined;
    if (
      values.email &&
      (!account || account.email.toLowerCase() !== values.email.trim().toLowerCase())
    )
      throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");
    console.log(
      JSON.stringify(
        await runReferralOperator(
          input,
          {
            ...(account ? { userId: account.id } : { participantKey: values["participant-key"] }),
            namespace: env.REFERRAL_NAMESPACE,
            dashboardUrl: runtimeTarget.dashboard,
          },
          getOblienBillingApi(),
        ),
        null,
        2,
      ),
    );
  } finally {
    await connection.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof AppError
      ? `${error.code}: ${error.message}`
      : "Referral command failed. Check command arguments, the account and provider status. No payment was sent.",
  );
  process.exitCode = 1;
});
