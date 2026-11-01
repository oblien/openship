/** Fixed precision for displaying verified deposits and provider usage. This is
 * not a second execution-time ledger. Offers buy one provider credit per cent. */
export const ACTIONS_UNITS_PER_CENT = 600_000;

export function actionDepositUnits(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100_000_000)
    throw new Error("Invalid Actions deposit amount");
  return cents * ACTIONS_UNITS_PER_CENT;
}

/** Provider credits may be fractional. Never round spendable credit upward. */
export function actionCreditUnits(credits: number): number {
  const units = Math.floor(credits * ACTIONS_UNITS_PER_CENT);
  if (!Number.isFinite(credits) || credits < 0 || !Number.isSafeInteger(units))
    throw new Error("Invalid Actions provider amount");
  return units;
}
